/**
 * Parse + validate qwirq.yaml against the bundled JSON Schema (the consolidation of #93: the CLI's
 * schema-subset validator, promoted to the shared lib so every consumer enforces one set of rules).
 * The validator covers exactly the subset the manifest schema uses: type, $ref (local #/$defs only),
 * anyOf, required, properties, additionalProperties (false or a schema), propertyNames,
 * min/maxProperties, items, min/maxItems, pattern, min/maxLength, enum, minimum/maximum. The
 * annotation `x-patternMessage` (ignored by other validators) replaces the raw regex in a pattern error.
 * Keywords apply by the value's actual type (JSON Schema semantics), so a typeless anyOf branch such
 * as { required: [...] } still checks an object.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', 'schemas', 'qwirq.schema.json');
/** The canonical published schema URL (its $id). */
export const SCHEMA_URL = 'https://qwirq.com/schemas/qwirq.schema.json';
let schemaCache = null;
/** The bundled manifest JSON Schema (the canonical copy; consumers re-bundle from here). */
export function loadSchema() {
    if (!schemaCache)
        schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    return schemaCache;
}
/** Parse YAML text into a value; throws a readable error on a syntax error. */
export function parseManifestText(text) {
    try {
        return parseYaml(text);
    }
    catch (e) {
        throw new Error(`qwirq.yaml is not valid YAML: ${e?.message ?? e}`);
    }
}
const typeOf = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v;
const jsonType = (v) => {
    const t = typeOf(v);
    if (t === 'number')
        return Number.isInteger(v) ? 'integer' : 'number';
    return t;
};
/** Resolve a local `#/$defs/...` (or any `#/...`) JSON pointer against the root schema. */
function resolveRef(root, ref) {
    if (!ref.startsWith('#/'))
        throw new Error(`schema: only local $ref is supported, got ${ref}`);
    let node = root;
    for (const part of ref.slice(2).split('/')) {
        node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (node === undefined)
            throw new Error(`schema: unresolved $ref ${ref}`);
    }
    return node;
}
const child = (p, k) => (p ? `${p}.${k}` : k);
function check(value, schema, p, out, root) {
    const at = p || '(root)';
    const push = (keyword, message, path = p) => out.push({ path, keyword, message });
    if (schema.$ref)
        check(value, resolveRef(root, schema.$ref), p, out, root);
    if (schema.type) {
        const jt = jsonType(value);
        const want = schema.type;
        const ok = want === 'integer' ? jt === 'integer' : want === 'number' ? jt === 'integer' || jt === 'number' : jt === want;
        if (!ok) {
            push('type', `${at}: expected ${want}, got ${jt}`);
            return;
        }
    }
    if (schema.anyOf) {
        const branches = schema.anyOf.map((s) => { const e = []; check(value, s, p, e, root); return e; });
        if (!branches.some((e) => e.length === 0)) {
            const strip = (m) => (m.startsWith(`${at}: `) ? m.slice(at.length + 2) : m);
            push('anyOf', `${at}: must satisfy one of: ${branches.map((e) => e.map((x) => strip(x.message)).join(' and ')).join(' | ')}`);
        }
    }
    if (schema.enum && !schema.enum.includes(value))
        push('enum', `${p}: "${value}" is not one of ${schema.enum.join(', ')}`);
    const t = typeOf(value);
    if (t === 'object') {
        for (const req of schema.required ?? []) {
            if (!Object.keys(value).includes(req))
                push('required', `${at}: missing required "${req}"`);
        }
        const n = Object.keys(value).length;
        if (schema.minProperties != null && n < schema.minProperties) {
            push('minProperties', `${at}: needs at least ${schema.minProperties} of ${Object.keys(schema.properties ?? {}).join('/')}`);
        }
        if (schema.maxProperties != null && n > schema.maxProperties) {
            push('maxProperties', `${at}: at most ${schema.maxProperties} entries allowed, got ${n}`);
        }
        const props = schema.properties ?? {};
        for (const k of Object.keys(value)) {
            if (schema.propertyNames)
                check(k, schema.propertyNames, child(p, k), out, root);
            if (k in props)
                check(value[k], props[k], child(p, k), out, root);
            else if (schema.additionalProperties === false)
                push('additionalProperties', `${child(p, k)}: unknown field (check spelling)`, child(p, k));
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
                check(value[k], schema.additionalProperties, child(p, k), out, root);
        }
    }
    if (t === 'array') {
        if (schema.minItems != null && value.length < schema.minItems)
            push('minItems', `${at}: needs at least ${schema.minItems} item(s)`);
        if (schema.maxItems != null && value.length > schema.maxItems)
            push('maxItems', `${at}: at most ${schema.maxItems} items allowed, got ${value.length}`);
        if (schema.items)
            value.forEach((item, i) => check(item, schema.items, `${p}[${i}]`, out, root));
    }
    if (t === 'string') {
        if (schema.minLength != null && value.length < schema.minLength)
            push('minLength', `${p}: must not be empty`);
        if (schema.maxLength != null && value.length > schema.maxLength)
            push('maxLength', `${p}: longer than ${schema.maxLength} characters`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
            push('pattern', `${p}: "${value}" ${schema['x-patternMessage'] ?? `does not match ${schema.pattern}`}`);
        }
    }
    if (t === 'number') {
        if (schema.minimum != null && value < schema.minimum)
            push('minimum', `${p}: ${value} is below the minimum ${schema.minimum}`);
        if (schema.maximum != null && value > schema.maximum)
            push('maximum', `${p}: ${value} is above the maximum ${schema.maximum}`);
    }
}
/** Validate a parsed manifest value against the bundled schema, keeping each issue's path + keyword
 *  (pipeline.ts classifies them into engine error codes). [] = valid. */
export function checkManifest(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return [{ path: '', keyword: 'type', message: 'qwirq.yaml: the manifest must be a YAML object' }];
    }
    const out = [];
    const schema = loadSchema();
    check(value, schema, '', out, schema);
    return out;
}
/** The built-in icon keys from @qwirq/ui-icon-kit. An icon field value not in this set
 *  and not defined in custom_icons is WARNED (not rejected) — the shell falls back to folder. */
const BUILTIN_ICON_KEYS = new Set([
    'access_time', 'account_circle', 'add', 'analytics', 'apps', 'arrow_back', 'arrow_forward',
    'article', 'assignment', 'attach_file', 'badge', 'bar_chart', 'book', 'bookmark', 'bug_report',
    'build', 'calendar_month', 'calendar_today', 'cancel', 'category', 'chat', 'check', 'check_circle',
    'checklist', 'chevron_left', 'chevron_right', 'close', 'cloud', 'cloud_done', 'cloud_download',
    'cloud_upload', 'code', 'comment', 'content_copy', 'dashboard', 'data_usage', 'database', 'db',
    'delete', 'description', 'dns', 'done', 'done_all', 'download', 'edit', 'error', 'event',
    'expand_less', 'expand_more', 'extension', 'fact_check', 'favorite', 'filter_list', 'flag',
    'folder', 'folder_open', 'forum', 'grid_view', 'group', 'help', 'history', 'home', 'info',
    'insights', 'integration_instructions', 'key', 'label', 'launch', 'link', 'list_alt', 'lock',
    'lock_open', 'login', 'logout', 'mail', 'memory', 'menu', 'more_horiz', 'more_vert',
    'notifications', 'notifications_none', 'open_in_new', 'pending', 'pending_actions', 'person',
    'person_add', 'pie_chart', 'playlist_add_check', 'redo', 'refresh', 'save', 'schedule', 'search',
    'security', 'send', 'settings', 'share', 'shield', 'show_chart', 'sort', 'star', 'star_border',
    'sticky_note', 'storage', 'table_view', 'task_alt', 'terminal', 'text_snippet', 'thumb_down',
    'thumb_up', 'trending_up', 'tune', 'undo', 'update', 'upload', 'view_list', 'visibility',
    'visibility_off', 'vpn_key', 'warning',
]);
/** Validate a parsed manifest value against the bundled schema. Returns `path: message` strings; [] = valid. */
export function validateManifest(value) {
    return checkManifest(value).map((i) => i.message);
}
/** Validate + return warnings for advisory issues (unknown icon key etc.).
 *  Warnings do NOT prevent the manifest from loading; they are surfaced by the CLI
 *  and VS Code as informational diagnostics. Returns [] = no warnings. */
export function warnManifest(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
        return [];
    const m = value;
    const warnings = [];
    if (typeof m.icon === 'string') {
        const customKeys = new Set(Array.isArray(m.custom_icons)
            ? m.custom_icons
                .filter(e => typeof e?.key === 'string')
                .map(e => e.key)
            : []);
        if (!BUILTIN_ICON_KEYS.has(m.icon) && !customKeys.has(m.icon)) {
            warnings.push(`icon: "${m.icon}" is not a built-in @qwirq/ui-icon-kit key and is not in custom_icons; ` +
                `the shell will fall back to the folder icon. ` +
                `Add it to custom_icons or use a built-in key (see x-builtinIconKeys in the schema).`);
        }
    }
    return warnings;
}
/** Read + schema-validate a project dir's qwirq.yaml; throws with every error listed.
 *  Icon-key warnings are emitted to stderr but do not throw. A pipeline-only manifest (no `provides`)
 *  comes back with a NON-ENUMERABLE `provides: {}` — typed access works (Manifest.provides), while
 *  absence is preserved for validateManifest/planPipeline/JSON (they see only enumerable keys), so
 *  planPipeline(readManifest(dir)) re-validates cleanly. Test with isPipelineOnly. */
export function readManifest(projectDir) {
    const p = path.join(projectDir, 'qwirq.yaml');
    if (!fs.existsSync(p))
        throw new Error(`no qwirq.yaml in ${projectDir}`);
    const value = parseManifestText(fs.readFileSync(p, 'utf8'));
    const errors = validateManifest(value);
    if (errors.length)
        throw new Error(`qwirq.yaml: ${errors.join('; ')}`);
    const warnings = warnManifest(value);
    for (const w of warnings)
        console.warn(`[qwirq.yaml] WARNING: ${w}`);
    const m = value;
    if (!m.provides)
        Object.defineProperty(m, 'provides', { value: {}, enumerable: false, writable: true, configurable: true });
    return m;
}
/** True when the manifest provides nothing to an instance (a pipeline-only project): no app, functions,
 *  or jobs. Accepts a readManifest result or a raw validated value whose `provides` is absent. Such a
 *  manifest never becomes a legacy app deployment (manifestToInstanceApp throws). */
export function isPipelineOnly(m) {
    return !m.provides || Object.keys(m.provides).length === 0;
}
