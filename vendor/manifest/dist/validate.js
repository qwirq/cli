/**
 * Parse + validate qwirq.yaml against the bundled JSON Schema (the consolidation of #93: the CLI's
 * schema-subset validator, promoted to the shared lib so every consumer enforces one set of rules).
 * The validator covers exactly the subset the manifest schema uses: type, required, properties,
 * additionalProperties:false, pattern, enum, minLength, minProperties, items.
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
function check(value, schema, p, errors) {
    if (schema.type) {
        const jt = jsonType(value);
        const want = schema.type;
        const ok = want === 'integer' ? jt === 'integer' : want === 'number' ? jt === 'integer' || jt === 'number' : jt === want;
        if (!ok) {
            errors.push(`${p || '(root)'}: expected ${want}, got ${jt}`);
            return;
        }
    }
    if (schema.type === 'object' && value && typeof value === 'object') {
        for (const req of schema.required ?? []) {
            if (!(req in value))
                errors.push(`${p || '(root)'}: missing required "${req}"`);
        }
        if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) {
            errors.push(`${p || '(root)'}: needs at least ${schema.minProperties} of ${Object.keys(schema.properties ?? {}).join('/')}`);
        }
        const props = schema.properties ?? {};
        if (schema.additionalProperties === false) {
            for (const k of Object.keys(value)) {
                if (!(k in props))
                    errors.push(`${p ? p + '.' : ''}${k}: unknown field (check spelling)`);
            }
        }
        for (const [k, sub] of Object.entries(props)) {
            if (k in value)
                check(value[k], sub, p ? `${p}.${k}` : k, errors);
        }
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
        value.forEach((item, i) => check(item, schema.items, `${p}[${i}]`, errors));
    }
    if (schema.type === 'string' && typeof value === 'string') {
        if (schema.minLength != null && value.length < schema.minLength)
            errors.push(`${p}: must not be empty`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value))
            errors.push(`${p}: "${value}" does not match ${schema.pattern}`);
        if (schema.enum && !schema.enum.includes(value))
            errors.push(`${p}: "${value}" is not one of ${schema.enum.join(', ')}`);
    }
}
/** Validate a parsed manifest value against the bundled schema. Returns `path: message` strings; [] = valid. */
export function validateManifest(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return ['qwirq.yaml: the manifest must be a YAML object'];
    }
    const errors = [];
    check(value, loadSchema(), '', errors);
    return errors;
}
/** Read + schema-validate a project dir's qwirq.yaml; throws with every error listed. */
export function readManifest(projectDir) {
    const p = path.join(projectDir, 'qwirq.yaml');
    if (!fs.existsSync(p))
        throw new Error(`no qwirq.yaml in ${projectDir}`);
    const value = parseManifestText(fs.readFileSync(p, 'utf8'));
    const errors = validateManifest(value);
    if (errors.length)
        throw new Error(`qwirq.yaml: ${errors.join('; ')}`);
    return value;
}
