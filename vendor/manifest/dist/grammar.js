/**
 * The shared grammar primitives the manifest planner and the pipeline engine must agree on: image
 * references, contained paths, branch refs, path globs, and the engine issue codes. Pure. The engine
 * (lib/pipeline) imports these instead of restating them; its contract tests compare against them.
 */
import { loadSchema } from './validate.js';
/** Docker reference grammar, name[:tag]@sha256:<64 lowercase hex>. One home: the schema's
 *  pipeline.checks[].image.pattern (lib/pipeline's admission contract test reads it there). */
export const IMAGE_PATTERN_SOURCE = loadSchema().properties.pipeline.properties.checks.items.properties.image.pattern;
export const IMAGE_MAX_LENGTH = loadSchema().properties.pipeline.properties.checks.items.properties.image.maxLength;
const IMAGE_RE = new RegExp(IMAGE_PATTERN_SOURCE);
export const isPinnedImage = (v) => typeof v === 'string' && v.length <= IMAGE_MAX_LENGTH && IMAGE_RE.test(v);
/** Release channel names, ^[a-z][a-z0-9-]{0,31}$. One home: the schema's $defs.channelName; lib/releases
 *  and lib/secrets import this instead of restating it. */
export const CHANNEL_NAME_PATTERN_SOURCE = loadSchema().$defs.channelName.pattern;
const CHANNEL_RE = new RegExp(CHANNEL_NAME_PATTERN_SOURCE);
export const isChannelName = (v) => typeof v === 'string' && CHANNEL_RE.test(v);
const ADAPTER_FIELD = /(?:^pipeline\.checks\[\d+\]|^pipeline\.builds\[\d+\]|^jobs\[\d+\]\.spec)\.adapter$/;
const NETWORK_FIELD = /(?:^pipeline\.checks\[\d+\]|^jobs\[\d+\]\.spec)\.steps\[\d+\]\.network$/;
const PLATFORM_FIELD = /^releases\.channels\[\d+\]\.platform$/;
const FEATURE_ROOTS = ['pipeline.', 'releases.', 'jobs['];
/** Map a schema issue to an engine code: an unknown field, adapter, network or platform is a feature this
 *  platform version does not support; everything else is an invalid manifest. */
export function classifySchemaIssue(i) {
    if (i.keyword === 'enum' && ADAPTER_FIELD.test(i.path))
        return 'adapter_unknown';
    if (i.keyword === 'enum' && (NETWORK_FIELD.test(i.path) || PLATFORM_FIELD.test(i.path)))
        return 'unsupported_feature';
    if (i.keyword === 'additionalProperties' && FEATURE_ROOTS.some((r) => i.path.startsWith(r)))
        return 'unsupported_feature';
    return 'manifest_invalid';
}
export function schemaIssuesToPipeline(issues) {
    return issues.map((i) => {
        const code = classifySchemaIssue(i);
        const message = code === 'unsupported_feature' && i.keyword === 'additionalProperties'
            ? `${i.path}: not supported by this platform version (unknown field)` : i.message;
        return { code, path: i.path, message };
    });
}
/** Normalize a relative POSIX path; null when it is absolute, escapes the root, or is not POSIX.
 *  '' = the root itself. (The schema pattern rejects these too; this is the authoritative check.) */
export function containedPath(raw) {
    if (/[\u0000-\u001f\\]/.test(raw) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw))
        return null;
    const out = [];
    for (const seg of raw.split('/')) {
        if (seg === '' || seg === '.')
            continue;
        if (seg === '..')
            return null;
        out.push(seg);
    }
    return out.join('/');
}
/** The default integration branch when pipeline.targetRef is absent. */
export const DEFAULT_TARGET_REF = 'refs/heads/main';
const MAX_REF_CHARS = 1024;
const REF_BAD_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * The git-host intake's branch-ref grammar (apps/git-host hooks/enqueue-pipeline.py valid_branch_ref,
 * identical to lib/pipeline validBranchRef): valid UTF-8, <= 1024 code points, refs/heads/ only; no
 * control/space/DEL or ~ ^ : ? * [ \; no '..' or '@{'; not ending '.' or '/'; every component non-empty,
 * not '.'-led, not '.lock'; not exactly refs/heads/@. The acceptance checks it differentially against intake.
 */
export function validBranchRef(ref) {
    if (typeof ref !== 'string' || LONE_SURROGATE.test(ref))
        return false;
    if ([...ref].length > MAX_REF_CHARS || !ref.startsWith('refs/heads/'))
        return false;
    if (REF_BAD_CHARS.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.') || ref.endsWith('/'))
        return false;
    if (ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')))
        return false;
    return ref !== 'refs/heads/@';
}
/** Normalize a path glob ('./a//b/**' -> 'a/b/**'); null when it escapes the repository, uses an
 *  unsupported construct ([ ] { } ! or backslash), or puts '**' inside a segment. */
export function normalizeGlob(raw) {
    if (/[\u0000-\u001f\\[\]{}!]/.test(raw))
        return null;
    const p = containedPath(raw);
    if (p == null || p === '')
        return null;
    if (p.split('/').some((seg) => seg.includes('**') && seg !== '**'))
        return null;
    return p;
}
const globCache = new Map();
function globRegExp(glob) {
    let re = globCache.get(glob);
    if (re)
        return re;
    const segs = glob.split('/');
    let src = '^';
    segs.forEach((seg, i) => {
        const last = i === segs.length - 1;
        if (seg === '**') {
            src += last ? '.*' : '(?:[^/]+/)*';
            return;
        }
        src += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
        if (!last)
            src += '/';
    });
    re = new RegExp(src + '$');
    globCache.set(glob, re);
    return re;
}
/** Whether a repository-relative file path matches a normalized glob: '*' and '?' stay within one
 *  segment (dotfiles included), '**' as a whole segment spans zero or more segments. */
export function matchPathGlob(glob, path) {
    return globRegExp(glob).test(path);
}
