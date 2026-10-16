/**
 * qwirq.yaml `pipeline.checks` -> JobPlan[] (M0 engine input). Pure: no IO beyond the bundled schema,
 * no clock, no randomness. The schema owns structure, bounds, and defaults (one home per fact); this
 * module adds what a schema cannot say — unique names, known/acyclic needs, contained paths — and
 * emits a canonical plan (defaults filled, env keys sorted) so equal manifests hash equal.
 * Issue codes are the engine's 400 codes, so the worker/API can relay them unchanged.
 */
import { checkManifest, loadSchema } from './validate.js';
const ADAPTER_FIELD = /^pipeline\.checks\[\d+\]\.adapter$/;
const NETWORK_FIELD = /^pipeline\.checks\[\d+\]\.steps\[\d+\]\.network$/;
/** Map a schema issue to the engine code: unknown fields or values inside `pipeline` are features this
 *  platform version does not support (services, caches, matrix, network egress, ...). */
function classify(i) {
    if (i.keyword === 'enum' && ADAPTER_FIELD.test(i.path))
        return 'adapter_unknown';
    if (i.keyword === 'enum' && NETWORK_FIELD.test(i.path))
        return 'unsupported_feature';
    if (i.keyword === 'additionalProperties' && i.path.startsWith('pipeline.'))
        return 'unsupported_feature';
    return 'manifest_invalid';
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
const dedupe = (xs) => [...new Set(xs ?? [])];
function limitDefaults() {
    const props = loadSchema().$defs.pipelineLimits.properties;
    return { seconds: props.seconds.default, memoryMb: props.memoryMb.default, cpus: props.cpus.default, pids: props.pids.default };
}
/** Find one dependency cycle (as a name path a -> b -> a) or null. Needs must already be known names. */
function findCycle(checks) {
    const needs = new Map(checks.map((c) => [c.name, dedupe(c.needs)]));
    const state = new Map(); // 1 = on stack, 2 = done
    const stack = [];
    const visit = (n) => {
        if (state.get(n) === 2)
            return null;
        if (state.get(n) === 1)
            return [...stack.slice(stack.indexOf(n)), n];
        state.set(n, 1);
        stack.push(n);
        for (const d of needs.get(n) ?? []) {
            const c = visit(d);
            if (c)
                return c;
        }
        stack.pop();
        state.set(n, 2);
        return null;
    };
    for (const c of checks) {
        const cyc = visit(c.name);
        if (cyc)
            return cyc;
    }
    return null;
}
/**
 * Validate a parsed qwirq.yaml value (the whole manifest) and normalize `pipeline.checks` into
 * JobPlan[] in declaration order. A manifest without `pipeline` is valid with jobs: []. Any issue
 * anywhere in the manifest fails the plan; nothing is silently ignored.
 */
export function planPipeline(value) {
    const schemaIssues = checkManifest(value);
    if (schemaIssues.length) {
        return {
            ok: false,
            issues: schemaIssues.map((i) => {
                const code = classify(i);
                const message = code === 'unsupported_feature' && i.keyword === 'additionalProperties'
                    ? `${i.path}: not supported by this platform version (unknown field)` : i.message;
                return { code, path: i.path, message };
            }),
        };
    }
    const checks = value.pipeline?.checks ?? [];
    const issues = [];
    const bad = (path, message, code = 'manifest_invalid') => issues.push({ code, path, message: `${path}: ${message}` });
    const names = new Set();
    checks.forEach((c, i) => {
        const at = `pipeline.checks[${i}]`;
        if (names.has(c.name))
            bad(`${at}.name`, `duplicate check name "${c.name}"`);
        names.add(c.name);
        const stepNames = new Set();
        c.steps.forEach((s, j) => {
            const sat = `${at}.steps[${j}]`;
            if (stepNames.has(s.name))
                bad(`${sat}.name`, `duplicate step name "${s.name}"`);
            stepNames.add(s.name);
            if (s.run[0] === '')
                bad(`${sat}.run[0]`, 'the executable must not be empty');
            if (s.cwd != null && containedPath(s.cwd) == null)
                bad(`${sat}.cwd`, `"${s.cwd}" escapes the workspace`);
        });
        const outNames = new Set();
        (c.outputs ?? []).forEach((o, j) => {
            const oat = `${at}.outputs[${j}]`;
            if (outNames.has(o.name))
                bad(`${oat}.name`, `duplicate output name "${o.name}"`);
            outNames.add(o.name);
            const p = containedPath(o.path);
            if (p == null)
                bad(`${oat}.path`, `"${o.path}" escapes the workspace`);
            else if (p === '')
                bad(`${oat}.path`, 'must name a file inside the workspace, not the workspace itself');
        });
    });
    checks.forEach((c, i) => {
        dedupe(c.needs).forEach((n) => {
            const j = c.needs.indexOf(n);
            if (n === c.name)
                bad(`pipeline.checks[${i}].needs[${j}]`, `check "${c.name}" cannot need itself`, 'dependency_cycle');
            else if (!names.has(n))
                bad(`pipeline.checks[${i}].needs[${j}]`, `unknown check "${n}"`);
        });
    });
    if (issues.length)
        return { ok: false, issues };
    const cycle = findCycle(checks);
    if (cycle) {
        const i = checks.findIndex((c) => c.name === cycle[0]);
        bad(`pipeline.checks[${i}].needs`, `dependency cycle ${cycle.join(' -> ')}`, 'dependency_cycle');
        return { ok: false, issues };
    }
    const defaults = limitDefaults();
    const jobs = checks.map((c) => ({
        name: c.name,
        required: c.required ?? true,
        labels: dedupe(c.labels),
        needs: dedupe(c.needs),
        spec: {
            adapter: c.adapter,
            image: c.image,
            steps: c.steps.map((s) => {
                const cwd = s.cwd == null ? '' : containedPath(s.cwd);
                const env = Object.keys(s.env ?? {}).sort();
                return {
                    name: s.name,
                    run: [...s.run],
                    ...(cwd ? { cwd } : {}),
                    ...(env.length ? { env: Object.fromEntries(env.map((k) => [k, s.env[k]])) } : {}),
                    network: 'none',
                };
            }),
            outputs: (c.outputs ?? []).map((o) => ({ name: o.name, path: containedPath(o.path), when: o.when ?? 'always' })),
            limits: { ...defaults, ...c.limits },
        },
    }));
    return { ok: true, jobs };
}
