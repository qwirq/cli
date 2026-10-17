/**
 * Declared inputs (manifest 0.6, WP6 grammar ruling): one primitive shared by checks and builds.
 * Pure. The schema owns structure and bounds ($defs.input); this module adds what a schema cannot say
 * (per-kind fields, unique names, path sets, overlap, counts) and emits the canonical form:
 *   - inputs sorted by name (names are unique per job/build); empty check inputs are omitted;
 *   - repository `paths` and npm `privateScopes` are sorted sets (UTF-8 byte order; duplicates rejected);
 *   - npm privateScopes always present; download unpack always present; file sha256 only when pinned.
 *
 * Planning never fetches. A declaration names exact bytes (commit + tree digest, lockfile digest,
 * download digest); authorization to fetch them is operator policy, never the declaration. Repository
 * trees and npm seeds mount read-only at /inputs/<name>; an npm seed's attempt-local writable copy is
 * /cache/<name>. Files and downloads keep the build placement/timing of their 0.5 aliases (files before
 * prebuild; downloads after install and after the runtime fingerprint).
 *
 * The tree digest (qwirq.input-tree.v1) is the one shared implementation (inputTreeSha256):
 *   SHA256(concat, in UTF-8 bytewise path order: UTF8(relativePath) || NUL || ASCII(SHA256(fileBytes).hex) || LF).hex
 */
import { createHash } from 'node:crypto';
import { containedPath } from './grammar.js';
import { DEPENDENCY_EGRESS_POLICY, isAllowedEgressHost } from './profiles.js';
import { loadSchema } from './validate.js';
export const INPUT_KINDS = Object.freeze(['repository', 'npm', 'file', 'download']);
export const CHECK_INPUT_KINDS = Object.freeze(['repository', 'npm']);
/** Combined inputs per job/build (builds: inputs + downloads together). */
export const MAX_INPUTS = 16;
/** The 0.5 per-build limits, retained. */
export const MAX_FILE_INPUTS = 8;
export const MAX_DOWNLOAD_INPUTS = 8;
export const INPUT_MOUNT_ROOT = '/inputs';
export const INPUT_TREE_DIGEST = 'qwirq.input-tree.v1';
export const NPM_SEED_FORMAT = 'qwirq.npm-seed.v1';
export const NPM_LOCKFILE_VERSIONS = Object.freeze([3]);
/** Read-only mount of a repository tree or npm seed. */
export const inputMountPath = (name) => `${INPUT_MOUNT_ROOT}/${name}`;
/** Attempt-local writable copy of an npm seed (npm ci --offline --cache <this>). */
export const npmCachePath = (name) => `/cache/${name}`;
const S = () => loadSchema().$defs;
/** The input path grammar, one home: the schema's $defs.inputPath. */
export const INPUT_PATH_PATTERN_SOURCE = loadSchema().$defs.inputPath.pattern;
export const INPUT_PATH_MAX_LENGTH = loadSchema().$defs.inputPath.maxLength;
const INPUT_PATH_RE = new RegExp(INPUT_PATH_PATTERN_SOURCE);
const SHA256_RE = /^[0-9a-f]{64}$/;
/** A relative POSIX input path: 1-4096 chars; no leading '/', backslash, control, glob (* ? [ ] { }),
 *  colon, or empty/'.'/'..' segment. Exact, never normalized. */
export const isInputPath = (v) => typeof v === 'string' && v.length >= 1 && v.length <= INPUT_PATH_MAX_LENGTH && INPUT_PATH_RE.test(v);
/** UTF-8 bytewise order (differs from JS UTF-16 order above U+FFFF). */
export const utf8Compare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
/** Whether a repository-relative file is inside a selection of exact files/directories. */
export const inputSelects = (paths, file) => paths.some((p) => file === p || file.startsWith(p + '/'));
export const fileSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/**
 * qwirq.input-tree.v1: the digest of a file set, paths relative to the input root. Throws on an invalid
 * path, a non-hex digest, or a duplicate path (a tree cannot hold one path twice).
 */
export function inputTreeSha256(files) {
    const list = [...files];
    for (const f of list) {
        if (!isInputPath(f.path))
            throw new Error(`${INPUT_TREE_DIGEST}: "${f.path}" is not a relative input path`);
        if (!SHA256_RE.test(f.sha256))
            throw new Error(`${INPUT_TREE_DIGEST}: ${f.path}: sha256 must be 64 lowercase hex`);
    }
    list.sort((a, b) => utf8Compare(a.path, b.path));
    const h = createHash('sha256');
    list.forEach((f, i) => {
        if (i && list[i - 1].path === f.path)
            throw new Error(`${INPUT_TREE_DIGEST}: duplicate path "${f.path}"`);
        h.update(Buffer.from(f.path, 'utf8')).update('\0').update(f.sha256, 'ascii').update('\n');
    });
    return h.digest('hex');
}
/** Check a lockfile's raw bytes against an npm input: digest first, then a supported lockfileVersion. */
export function verifyNpmLockfile(bytes, sha256) {
    if (fileSha256(bytes) !== sha256)
        return { ok: false, reason: 'digest_mismatch' };
    let v;
    try {
        v = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch {
        return { ok: false, reason: 'not_json' };
    }
    const version = v?.lockfileVersion;
    return NPM_LOCKFILE_VERSIONS.includes(version) ? { ok: true, lockfileVersion: version } : { ok: false, reason: 'unsupported_lockfile_version' };
}
const FIELDS = {
    repository: { required: ['repository', 'commit', 'paths', 'sha256'], optional: [] },
    npm: { required: ['lockfile', 'sha256'], optional: ['privateScopes'] },
    file: { required: ['path'], optional: ['sha256'] },
    download: { required: ['url', 'sha256', 'path'], optional: ['unpack'] },
};
const ZERO_COMMIT = '0'.repeat(40);
/**
 * What a schema cannot say about one owner's inputs. `entries` = [declared value, its issue path].
 * Build aliases arrive here already tagged (kind: file / download). Returns true when clean.
 */
export function checkInputs(entries, ctx, bad) {
    let clean = true;
    const flag = (p, m, c) => { clean = false; bad(p, m, c); };
    if (entries.length > MAX_INPUTS)
        flag(entries[MAX_INPUTS][1], `at most ${MAX_INPUTS} inputs per ${ctx.owner} (got ${entries.length})`);
    const names = new Map();
    const dest = []; // placed file/download destinations
    let files = 0, downloads = 0;
    for (const [i, at] of entries) {
        if (names.has(i.name))
            flag(`${at}.name`, `duplicate input name "${i.name}" (also ${names.get(i.name)})`);
        else
            names.set(i.name, at);
        const kind = i.kind;
        if (kind === undefined) {
            flag(`${at}.kind`, 'kind is required (repository | npm)');
            continue;
        }
        if (!ctx.kinds.includes(kind)) {
            flag(`${at}.kind`, `kind "${kind}" is not supported on a ${ctx.owner} (${ctx.kinds.join(' | ')})`, 'unsupported_feature');
            continue;
        }
        const f = FIELDS[kind];
        for (const k of Object.keys(i)) {
            if (k !== 'kind' && k !== 'name' && !f.required.includes(k) && !f.optional.includes(k))
                flag(`${at}.${k}`, `${k} does not apply to a ${kind} input`);
        }
        for (const k of f.required)
            if (i[k] === undefined)
                flag(at, `a ${kind} input needs ${k}`);
        if (kind === 'repository') {
            if (i.commit === ZERO_COMMIT)
                flag(`${at}.commit`, 'the zero commit is not a commit');
            const paths = i.paths ?? [];
            const seen = new Set();
            paths.forEach((p, k) => {
                if (seen.has(p))
                    flag(`${at}.paths[${k}]`, `duplicate path "${p}"`);
                else {
                    const over = [...seen].find((q) => p.startsWith(q + '/') || q.startsWith(p + '/'));
                    if (over)
                        flag(`${at}.paths[${k}]`, `"${p}" overlaps "${over}" (selections must not overlap)`);
                }
                seen.add(p);
            });
        }
        else if (kind === 'npm') {
            const lf = i.lockfile;
            if (lf !== undefined && lf !== 'package-lock.json' && !lf.endsWith('/package-lock.json'))
                flag(`${at}.lockfile`, 'must name a committed package-lock.json');
            const scopes = i.privateScopes ?? [];
            scopes.forEach((s, k) => { if (scopes.indexOf(s) !== k)
                flag(`${at}.privateScopes[${k}]`, `duplicate scope "${s}"`); });
        }
        else {
            if (kind === 'file')
                files++;
            else {
                downloads++;
                const url = i.url;
                if (url !== undefined) {
                    const host = new URL(url).hostname;
                    if (/^[0-9.]+$/.test(host))
                        flag(`${at}.url`, 'an IP-literal host is not allowed');
                    else if (!isAllowedEgressHost(host))
                        flag(`${at}.url`, `host "${host}" is not in the reviewed dependency allowlist (revision ${DEPENDENCY_EGRESS_POLICY.revision})`);
                }
            }
            const p = i.path;
            if (p !== undefined) {
                const over = dest.find(([q]) => q === p || p.startsWith(q + '/') || q.startsWith(p + '/'));
                if (over)
                    flag(`${at}.path`, `"${p}" overlaps the destination of ${over[1]}`);
                dest.push([p, at]);
            }
        }
    }
    if (files > MAX_FILE_INPUTS)
        flag(entries[0][1], `at most ${MAX_FILE_INPUTS} file inputs per ${ctx.owner} (got ${files})`);
    if (downloads > MAX_DOWNLOAD_INPUTS)
        flag(entries[0][1], `at most ${MAX_DOWNLOAD_INPUTS} downloads per ${ctx.owner} (got ${downloads})`);
    return clean;
}
/** One input, canonical (input already checked). */
export function canonInput(i) {
    switch (i.kind) {
        case 'repository':
            return { kind: 'repository', name: i.name, repository: i.repository, commit: i.commit,
                paths: [...i.paths].sort(utf8Compare), sha256: i.sha256 };
        case 'npm':
            return { kind: 'npm', name: i.name, lockfile: i.lockfile, sha256: i.sha256,
                privateScopes: [...(i.privateScopes ?? [])].sort(utf8Compare) };
        case 'file':
            return { kind: 'file', name: i.name, path: i.path, ...(i.sha256 ? { sha256: i.sha256 } : {}) };
        case 'download':
            return { kind: 'download', name: i.name, url: i.url, sha256: i.sha256, path: i.path,
                unpack: i.unpack ?? S().input.properties.unpack.default };
        default:
            throw new Error(`canonInput: unknown kind ${String(i.kind)}`);
    }
}
/** Canonical input list: sorted by name. */
export const canonInputs = (xs) => xs.map(canonInput).sort((a, b) => utf8Compare(a.name, b.name));
/**
 * The 0.5 build aliases as tagged inputs: builds.inputs entries without kind -> file (path normalized
 * as 0.5 did), builds.downloads -> download. Kinded builds.inputs entries pass through.
 * Returns [input, issue path] pairs in declaration order (inputs, then downloads).
 */
export function buildInputEntries(at, inputs, downloads, bad) {
    const out = [];
    (inputs ?? []).forEach((raw, j) => {
        const i = raw;
        const iat = `${at}.inputs[${j}]`;
        if (i.kind !== undefined) {
            out.push([i, iat]);
            return;
        }
        // the 0.5 alias requires path (the schema says so too); never normalize an absent one
        if (typeof i.path !== 'string') {
            bad(iat, 'a file input (no kind) needs path');
            out.push([{ ...i, kind: 'file' }, iat]);
            return;
        }
        out.push([{ ...i, kind: 'file', path: aliasPath(i.path, `${iat}.path`, bad) }, iat]);
    });
    (downloads ?? []).forEach((raw, j) => {
        const d = raw;
        const dat = `${at}.downloads[${j}]`;
        if (typeof d.path !== 'string') {
            bad(dat, 'a download needs path');
            out.push([{ ...d, kind: 'download' }, dat]);
            return;
        }
        out.push([{ ...d, kind: 'download', path: aliasPath(d.path, `${dat}.path`, bad) }, dat]);
    });
    return out;
}
/** A 0.5 alias path is normalized (./a//b -> a/b) as 0.5 did, then must satisfy the input path grammar. */
function aliasPath(raw, at, bad) {
    const p = containedPath(raw);
    if (p == null) {
        bad(at, `"${raw}" escapes the workspace`);
        return raw;
    }
    if (p === '') {
        bad(at, 'must name a path inside the workspace, not the workspace itself');
        return raw;
    }
    if (!isInputPath(p))
        bad(at, `"${raw}" is not an exact input path (no glob characters or colon)`);
    return p;
}
/**
 * A build plan's inputs as 0.6 canonical, from either shape: a 0.6 plan (inputs only, every entry
 * kinded) or a stored 0.5 plan (inputs [{name, path, sha256?}] + downloads). Never re-validates and
 * never changes a stored plan's digest; use it to READ historical plans.
 */
export function upgradeBuildInputs(plan) {
    const tagged = [
        ...(plan.inputs ?? []).map((i) => (i.kind ? i : { ...i, kind: 'file' })),
        ...(plan.downloads ?? []).map((d) => ({ ...d, kind: 'download' })),
    ];
    return canonInputs(tagged);
}
