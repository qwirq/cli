/**
 * qwirq.yaml `pipeline.builds` + `releases.channels` -> canonical build targets and desired channels
 * (M12-SPEC §4–5; M3-6-SPEC §B M3). Pure. A build target describes repository-specific inputs only;
 * the toolchain image, resource limits, signing, version-code allocation and runtime stamping belong
 * to the platform adapter. Channels are DESIRED configuration: the owner reconciles them through
 * revisioned brokers, so nothing here can sign, publish, grant secrets, open public access or unpause.
 */
import { containedPath } from './grammar.js';
import { DEPENDENCY_EGRESS_POLICY, isAllowedEgressHost } from './profiles.js';
import { loadSchema } from './validate.js';
/** Schema defaults (the schema is the one home of every default). */
const BUILD = () => loadSchema().$defs.pipelineBuild.properties;
const CHANNEL = () => loadSchema().$defs.releaseChannel.properties;
export const DEFAULT_ARCHITECTURES = [...BUILD().architectures.default];
const ANDROID_ONLY = ['app', 'install', 'prepare', 'inputs', 'downloads', 'architectures', 'runtime', 'env'];
const dedupe = (xs) => [...new Set(xs ?? [])];
const sortedMap = (o) => Object.fromEntries(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
const rootDot = (p) => (p === '' ? '.' : p);
/** Semantic analysis of a schema-valid manifest's builds and channels. Used by planBuilds/planPipeline. */
export function analyzeBuilds(m) {
    const builds = m.pipeline?.builds ?? [];
    const channels = m.releases?.channels ?? [];
    const issues = [];
    const bad = (path, message, code = 'manifest_invalid') => issues.push({ code, path, message: `${path}: ${message}` });
    const unique = (names, at, what) => {
        const seen = new Set();
        names.forEach((n, i) => { if (seen.has(n))
            bad(at(i), `duplicate ${what} "${n}"`); seen.add(n); });
    };
    const contained = (raw, path, allowRoot) => {
        const p = containedPath(raw);
        if (p == null)
            bad(path, `"${raw}" escapes the workspace`);
        else if (p === '' && !allowRoot)
            bad(path, 'must name a path inside the workspace, not the workspace itself');
    };
    unique(builds.map((b) => b.name), (i) => `pipeline.builds[${i}].name`, 'build name');
    const byName = new Map(builds.map((b) => [b.name, b]));
    builds.forEach((b, i) => {
        const at = `pipeline.builds[${i}]`;
        if (b.adapter === 'android-apk') {
            if (b.native !== undefined)
                bad(`${at}.native`, 'native applies only to expo-update builds');
            if (!b.app)
                bad(at, 'android-apk needs app (path, applicationId)');
            if (!b.install)
                bad(at, 'android-apk needs install (at least one locked install)');
            if (b.app)
                contained(b.app.path, `${at}.app.path`, true);
            (b.install ?? []).forEach((s, j) => {
                const sat = `${at}.install[${j}]`;
                if (s.path !== undefined)
                    contained(s.path, `${sat}.path`, true);
                if (s.filter && s.manager !== 'pnpm')
                    bad(`${sat}.filter`, 'filter applies only to manager pnpm');
                if (s.legacyPeerDeps !== undefined && s.manager !== 'npm')
                    bad(`${sat}.legacyPeerDeps`, 'legacyPeerDeps applies only to manager npm');
            });
            const installAt = new Set();
            (b.install ?? []).forEach((s, j) => {
                const p = rootDot(containedPath(s.path ?? '.') ?? '');
                if (installAt.has(p))
                    bad(`${at}.install[${j}].path`, `a second install in "${p}"`);
                installAt.add(p);
            });
            unique((b.prepare ?? []).map((s) => s.name), (j) => `${at}.prepare[${j}].name`, 'prepare step name');
            (b.prepare ?? []).forEach((s, j) => {
                if (s.run[0] === '')
                    bad(`${at}.prepare[${j}].run[0]`, 'the executable must not be empty');
                if (s.cwd !== undefined)
                    contained(s.cwd, `${at}.prepare[${j}].cwd`, true);
            });
            unique((b.inputs ?? []).map((s) => s.name), (j) => `${at}.inputs[${j}].name`, 'input name');
            (b.inputs ?? []).forEach((s, j) => contained(s.path, `${at}.inputs[${j}].path`, false));
            unique((b.downloads ?? []).map((s) => s.name), (j) => `${at}.downloads[${j}].name`, 'download name');
            (b.downloads ?? []).forEach((s, j) => {
                contained(s.path, `${at}.downloads[${j}].path`, false);
                const host = new URL(s.url).hostname;
                if (/^[0-9.]+$/.test(host))
                    bad(`${at}.downloads[${j}].url`, 'an IP-literal host is not allowed');
                else if (!isAllowedEgressHost(host)) {
                    bad(`${at}.downloads[${j}].url`, `host "${host}" is not in the reviewed dependency allowlist (revision ${DEPENDENCY_EGRESS_POLICY.revision})`);
                }
            });
            unique(b.architectures ?? [], (j) => `${at}.architectures[${j}]`, 'architecture');
        }
        else {
            for (const k of ANDROID_ONLY)
                if (b[k] !== undefined)
                    bad(`${at}.${k}`, `${k} applies only to android-apk builds (expo-update shares its native target's)`);
            if (b.native === undefined)
                bad(at, 'expo-update needs native (the android-apk target it shares)');
            else if (byName.get(b.native)?.adapter !== 'android-apk')
                bad(`${at}.native`, `"${b.native}" is not an android-apk build in this manifest`);
        }
    });
    unique(channels.map((c) => `${c.platform}/${c.name}`), (i) => `releases.channels[${i}].name`, 'channel');
    const defaults = new Set();
    channels.forEach((c, i) => {
        const at = `releases.channels[${i}]`;
        if (byName.get(c.build)?.adapter !== 'android-apk')
            bad(`${at}.build`, `"${c.build}" is not an android-apk build in pipeline.builds`);
        if (c.content !== undefined) {
            const cb = byName.get(c.content);
            if (cb?.adapter !== 'expo-update')
                bad(`${at}.content`, `"${c.content}" is not an expo-update build in pipeline.builds`);
            else if (cb.native !== c.build)
                bad(`${at}.content`, `expo-update "${c.content}" shares "${cb.native}", not this channel's build "${c.build}"`);
        }
        if (c.default) {
            if (defaults.has(c.platform))
                bad(`${at}.default`, `a second default channel for ${c.platform}`);
            defaults.add(c.platform);
        }
    });
    if (issues.length)
        return { issues, builds: [], channels: [] };
    return {
        issues,
        builds: builds.map((b) => {
            const labels = dedupe(b.labels);
            if (b.adapter === 'expo-update')
                return { name: b.name, adapter: 'expo-update', labels, native: b.native };
            const env = sortedMap(b.env);
            return {
                name: b.name,
                adapter: 'android-apk',
                labels,
                app: { path: rootDot(containedPath(b.app.path)), applicationId: b.app.applicationId },
                install: b.install.map((s) => ({
                    path: rootDot(containedPath(s.path ?? '.')),
                    manager: s.manager,
                    filter: dedupe(s.filter),
                    legacyPeerDeps: s.legacyPeerDeps ?? BUILD().install.items.properties.legacyPeerDeps.default,
                })),
                prepare: (b.prepare ?? []).map((s) => {
                    const cwd = s.cwd == null ? '' : containedPath(s.cwd);
                    const senv = sortedMap(s.env);
                    return { name: s.name, run: [...s.run], ...(cwd ? { cwd } : {}), ...(Object.keys(senv).length ? { env: senv } : {}) };
                }),
                inputs: (b.inputs ?? []).map((s) => ({ name: s.name, path: containedPath(s.path), ...(s.sha256 ? { sha256: s.sha256 } : {}) })),
                downloads: (b.downloads ?? []).map((s) => ({ name: s.name, url: s.url, sha256: s.sha256, path: containedPath(s.path), unpack: s.unpack ?? BUILD().downloads.items.properties.unpack.default })),
                architectures: b.architectures ? dedupe(b.architectures) : [...DEFAULT_ARCHITECTURES],
                runtime: b.runtime ?? BUILD().runtime.default,
                ...(Object.keys(env).length ? { env } : {}),
            };
        }),
        channels: channels.map((c) => ({
            name: c.name,
            platform: c.platform,
            build: c.build,
            ...(c.content !== undefined ? { content: c.content } : {}),
            default: c.default ?? CHANNEL().default.default,
            autoPublish: c.autoPublish ?? CHANNEL().autoPublish.default,
            audience: c.audience ?? CHANNEL().audience.default,
        })),
    };
}
