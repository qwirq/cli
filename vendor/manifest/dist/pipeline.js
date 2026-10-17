/**
 * qwirq.yaml `pipeline.checks` -> JobPlan[] (the engine's input), and the engine-side normalizer of that
 * contract. Pure: no IO beyond the bundled schema, no clock, no randomness. The schema owns structure,
 * bounds and defaults (one home per fact); this module adds what a schema cannot say — unique names,
 * known/acyclic needs, contained paths, matrix expansion, env inheritance — and emits a canonical plan
 * (defaults filled, maps key-sorted, absent-when-empty) so equal manifests hash equal.
 *
 * Canonical form rules (stable since 0.4.0; an M0 manifest plans byte-identically):
 *  - JobPlan keys: name, required, labels, needs, spec, [on], [matrix]; spec keys: adapter, image, steps,
 *    outputs, limits, [services], [caches], [reports]. Bracketed keys appear only when non-empty.
 *  - labels/needs: de-duplicated in declared order. needs naming a matrix check = all its jobs.
 *  - step env = check env overlaid by step env (step wins per key), keys sorted, absent when empty.
 *    Platform-injected variables (proxy settings on `dependencies` steps) override both at run time.
 *  - ${matrix.<axis>} is replaced in step run items and env values only; nothing is evaluated.
 *  - services: key-sorted map; caches: declared order, inputs sorted; reports/outputs: declared order.
 *  - inputs (0.6): canonical per inputs.ts (sorted by name), last spec key, absent when empty.
 */
import { checkSchemaNode, loadSchema } from './validate.js';
import { containedPath, DEFAULT_TARGET_REF, matchPathGlob, normalizeGlob, schemaIssuesToPipeline, validBranchRef, } from './grammar.js';
import { canonInputs, CHECK_INPUT_KINDS, checkInputs, npmCachePath } from './inputs.js';
/** Maximum jobs per submission after matrix expansion (lib/pipeline MAX_JOBS_PER_SUBMISSION). */
export const MAX_JOBS = 50;
const ALL_EVENTS = ['manual', 'pull_request', 'push'];
const RESERVED_SERVICE = /^(?:localhost$|qwirq)/;
const MATRIX_TOKEN = /\$\{matrix\.([^}]*)\}/g;
const NAME_RE = new RegExp(loadSchema().$defs.pipelineName.pattern);
const NAME_MAX = loadSchema().$defs.pipelineName.maxLength;
const ENV_MAX = loadSchema().$defs.pipelineEnv.maxProperties;
const dedupe = (xs) => [...new Set(xs ?? [])];
const sortedMap = (o) => Object.fromEntries(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
/** Schema defaults for an object node's properties (the schema is the one home of every default). */
function defaults(pointer) {
    let node = loadSchema();
    for (const part of pointer.slice(2).split('/'))
        node = node[part];
    return Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, v.default]));
}
let cachedDefaults = null;
function loadDefaults() {
    const check = loadSchema().properties.pipeline.properties.checks.items.properties;
    return {
        limits: defaults('#/$defs/pipelineLimits'),
        ready: defaults('#/$defs/pipelineService/properties/ready'),
        serviceLimits: defaults('#/$defs/pipelineService/properties/limits'),
        report: defaults('#/$defs/pipelineReports/items'),
        failFast: check.failFast.default,
    };
}
const D = () => (cachedDefaults ??= loadDefaults());
/** The canonical machine name of one matrix combination: <group>-<axis>-<value>... with axes in name order. */
export function matrixJobName(group, values) {
    return [group, ...Object.keys(values).sort().flatMap((a) => [a, String(values[a])])].join('-');
}
/** Whether a job applies in a context. changedPaths null = unknown (base/diff not computable): run it.
 *  paths filter push and pull_request events; a manual run ignores them. Inapplicable is not success. */
export function evaluateTrigger(on, ctx) {
    if (!on)
        return { applicable: true, reason: null };
    if (!on.events.includes(ctx.event))
        return { applicable: false, reason: 'event_not_selected' };
    if (!on.paths || ctx.event === 'manual' || ctx.changedPaths == null)
        return { applicable: true, reason: null };
    return ctx.changedPaths.some((p) => on.paths.some((g) => matchPathGlob(g, p)))
        ? { applicable: true, reason: null } : { applicable: false, reason: 'no_matching_paths' };
}
function canonSpec(adapter, image, f, jobEnv) {
    const d = D();
    const spec = {
        adapter,
        image,
        steps: f.steps.map((s) => {
            const cwd = s.cwd == null ? '' : containedPath(s.cwd);
            const env = sortedMap({ ...jobEnv, ...s.env });
            return {
                name: s.name,
                run: [...s.run],
                ...(cwd ? { cwd } : {}),
                ...(Object.keys(env).length ? { env } : {}),
                network: s.network ?? 'none',
            };
        }),
        outputs: (f.outputs ?? []).map((o) => ({ name: o.name, path: containedPath(o.path), when: o.when ?? 'always' })),
        limits: { ...d.limits, ...f.limits },
    };
    const svc = Object.keys(f.services ?? {}).sort();
    if (svc.length) {
        spec.services = Object.fromEntries(svc.map((k) => {
            const s = f.services[k];
            return [k, {
                    image: s.image,
                    env: sortedMap(s.env),
                    ready: {
                        command: [...s.ready.command],
                        intervalSeconds: s.ready.intervalSeconds ?? d.ready.intervalSeconds,
                        timeoutSeconds: s.ready.timeoutSeconds ?? d.ready.timeoutSeconds,
                        attempts: s.ready.attempts ?? d.ready.attempts,
                    },
                    limits: {
                        memoryMb: s.limits?.memoryMb ?? d.serviceLimits.memoryMb,
                        cpus: s.limits?.cpus ?? d.serviceLimits.cpus,
                        pids: s.limits?.pids ?? d.serviceLimits.pids,
                    },
                }];
        }));
    }
    if (f.caches?.length) {
        spec.caches = f.caches.map((c) => ({ name: c.name, path: c.path, inputs: dedupe(c.inputs.map((p) => containedPath(p))).sort() }));
    }
    if (f.reports?.length) {
        spec.reports = f.reports.map((r) => ({
            name: r.name,
            paths: dedupe(r.paths.map((p) => containedPath(p))),
            when: r.when ?? d.report.when,
            retentionDays: r.retentionDays ?? d.report.retentionDays,
        }));
    }
    if (f.inputs?.length)
        spec.inputs = canonInputs(f.inputs);
    return spec;
}
function canonTrigger(on) {
    if (!on)
        return undefined;
    const events = on.events ? ALL_EVENTS.filter((e) => on.events.includes(e)) : [...ALL_EVENTS];
    return { events, ...(on.paths ? { paths: dedupe(on.paths.map((g) => normalizeGlob(g))) } : {}) };
}
/**
 * What a schema cannot say about a check (authoring) or a job spec (engine contract): unique names,
 * contained paths, network/service coherence, cache layout. `matrixAxes` = the authored axes (a token
 * naming another axis is matrix_invalid), or null for an expanded plan (any token left is invalid).
 */
function checkSpecFields(f, at, bad, matrixAxes, jobEnv) {
    const tokens = (s, path) => {
        for (const m of s.matchAll(MATRIX_TOKEN)) {
            if (matrixAxes == null)
                bad(path, `unexpanded matrix reference ${m[0]}`);
            else if (!matrixAxes.has(m[1])) {
                bad(path, matrixAxes.size ? `${m[0]} names no axis of this check's matrix` : `${m[0]} used in a check without a matrix`, 'matrix_invalid');
            }
        }
    };
    for (const [k, v] of Object.entries(jobEnv ?? {}))
        tokens(v, `${at}.env.${k}`);
    const hasServices = Object.keys(f.services ?? {}).length > 0;
    const stepNames = new Set();
    f.steps.forEach((s, j) => {
        const sat = `${at}.steps[${j}]`;
        if (stepNames.has(s.name))
            bad(`${sat}.name`, `duplicate step name "${s.name}"`);
        stepNames.add(s.name);
        if (s.run[0] === '')
            bad(`${sat}.run[0]`, 'the executable must not be empty');
        if (s.cwd != null && containedPath(s.cwd) == null)
            bad(`${sat}.cwd`, `"${s.cwd}" escapes the workspace`);
        s.run.forEach((a, k) => tokens(a, `${sat}.run[${k}]`));
        for (const [k, v] of Object.entries(s.env ?? {}))
            tokens(v, `${sat}.env.${k}`);
        if (s.network === 'services' && !hasServices)
            bad(`${sat}.network`, 'network "services" needs at least one service declared on the check');
        const merged = Object.keys({ ...jobEnv, ...s.env }).length;
        if (jobEnv && merged > ENV_MAX)
            bad(`${sat}.env`, `check env and step env merge to ${merged} variables; at most ${ENV_MAX} per step`);
    });
    const artifactNames = new Set();
    (f.outputs ?? []).forEach((o, j) => {
        const oat = `${at}.outputs[${j}]`;
        if (artifactNames.has(o.name))
            bad(`${oat}.name`, `duplicate output name "${o.name}"`);
        artifactNames.add(o.name);
        const p = containedPath(o.path);
        if (p == null)
            bad(`${oat}.path`, `"${o.path}" escapes the workspace`);
        else if (p === '')
            bad(`${oat}.path`, 'must name a file inside the workspace, not the workspace itself');
    });
    (f.reports ?? []).forEach((r, j) => {
        const rat = `${at}.reports[${j}]`;
        if (artifactNames.has(r.name))
            bad(`${rat}.name`, `duplicate output/report name "${r.name}"`);
        artifactNames.add(r.name);
        r.paths.forEach((raw, k) => {
            const p = containedPath(raw);
            if (p == null)
                bad(`${rat}.paths[${k}]`, `"${raw}" escapes the workspace`);
            else if (p === '')
                bad(`${rat}.paths[${k}]`, 'must name a file or directory inside the workspace, not the workspace itself');
        });
    });
    for (const name of Object.keys(f.services ?? {})) {
        if (RESERVED_SERVICE.test(name))
            bad(`${at}.services.${name}`, `service name "${name}" is reserved by the platform`);
    }
    const cacheNames = new Set();
    const cachePaths = [];
    (f.caches ?? []).forEach((c, j) => {
        const cat = `${at}.caches[${j}]`;
        if (cacheNames.has(c.name))
            bad(`${cat}.name`, `duplicate cache name "${c.name}"`);
        cacheNames.add(c.name);
        const clash = cachePaths.find((p) => p === c.path || p.startsWith(c.path + '/') || c.path.startsWith(p + '/'));
        if (clash)
            bad(`${cat}.path`, `"${c.path}" overlaps another cache at "${clash}"`);
        cachePaths.push(c.path);
        c.inputs.forEach((raw, k) => {
            const p = containedPath(raw);
            if (p == null)
                bad(`${cat}.inputs[${k}]`, `"${raw}" escapes the workspace`);
            else if (p === '')
                bad(`${cat}.inputs[${k}]`, 'must name a file, not the workspace itself');
            else if (/[*?[\]{}]/.test(p))
                bad(`${cat}.inputs[${k}]`, `"${raw}" must be an exact file path (no globs)`);
        });
    });
    const inputs = f.inputs ?? [];
    checkInputs(inputs.map((x, j) => [x, `${at}.inputs[${j}]`]), { kinds: CHECK_INPUT_KINDS, owner: 'check' }, bad);
    inputs.forEach((x, j) => {
        if (x.kind !== 'npm')
            return;
        const seed = npmCachePath(x.name);
        (f.caches ?? []).forEach((c, k) => {
            if (c.path === seed || c.path.startsWith(seed + '/') || seed.startsWith(c.path + '/')) {
                bad(`${at}.caches[${k}].path`, `"${c.path}" overlaps ${seed}, the writable copy of npm input ${at}.inputs[${j}] ("${x.name}")`);
            }
        });
    });
}
function checkTrigger(on, at, bad) {
    ;
    (on?.paths ?? []).forEach((g, k) => {
        if (normalizeGlob(g) == null)
            bad(`${at}.on.paths[${k}]`, `"${g}" is not a supported glob inside the repository`);
    });
}
/** Find one dependency cycle (as a name path a -> b -> a) or null. Needs must already be known names. */
function findCycle(nodes) {
    const needs = new Map(nodes.map((c) => [c.name, dedupe(c.needs)]));
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
    for (const c of nodes) {
        const cyc = visit(c.name);
        if (cyc)
            return cyc;
    }
    return null;
}
function checkGraph(nodes, noun, at, issues, bad) {
    const names = new Set(nodes.map((n) => n.name));
    nodes.forEach((c, i) => {
        dedupe(c.needs).forEach((n) => {
            const j = c.needs.indexOf(n);
            if (n === c.name)
                bad(`${at(i)}.needs[${j}]`, `${noun} "${c.name}" cannot need itself`, 'dependency_cycle');
            else if (!names.has(n))
                bad(`${at(i)}.needs[${j}]`, `unknown ${noun} "${n}"`);
        });
    });
    if (issues.length)
        return false;
    const cycle = findCycle(nodes);
    if (cycle) {
        const i = nodes.findIndex((c) => c.name === cycle[0]);
        bad(`${at(i)}.needs`, `dependency cycle ${cycle.join(' -> ')}`, 'dependency_cycle');
        return false;
    }
    return true;
}
const collector = () => {
    const issues = [];
    const bad = (path, message, code = 'manifest_invalid') => { issues.push({ code, path, message: `${path}: ${message}` }); };
    return { issues, bad };
};
// ------------------------------------------------------------------ authoring: checks -> JobPlan[]
/** Combinations of a matrix, axes in name order, first axis outermost, values in declared order. */
function combinations(matrix) {
    let out = [{}];
    for (const axis of Object.keys(matrix).sort())
        out = out.flatMap((c) => matrix[axis].map((v) => ({ ...c, [axis]: v })));
    return out;
}
const substitute = (s, values) => s.replace(MATRIX_TOKEN, (_t, axis) => String(values[axis]));
/**
 * Semantic analysis of a schema-valid manifest's checks: issues, or the canonical JobPlan[] (matrix
 * expanded, env merged) and the non-default target ref. Used by planPipeline; not a public entry.
 */
export function analyzeChecks(m) {
    const checks = m.pipeline?.checks ?? [];
    const { issues, bad } = collector();
    const tr = m.pipeline?.targetRef;
    if (tr !== undefined && !validBranchRef(tr))
        bad('pipeline.targetRef', `"${tr}" is not a well-formed refs/heads/<branch>`);
    const names = new Set();
    checks.forEach((c, i) => {
        const at = `pipeline.checks[${i}]`;
        if (names.has(c.name))
            bad(`${at}.name`, `duplicate check name "${c.name}"`);
        names.add(c.name);
        const axes = new Set(Object.keys(c.matrix ?? {}));
        checkSpecFields(c, at, bad, axes, c.env);
        checkTrigger(c.on, at, bad);
        if (c.failFast !== undefined && !c.matrix)
            bad(`${at}.failFast`, 'failFast applies only to a check with a matrix');
        for (const [axis, values] of Object.entries(c.matrix ?? {})) {
            const seen = new Set();
            values.forEach((v, k) => {
                if (seen.has(String(v)))
                    bad(`${at}.matrix.${axis}[${k}]`, `duplicate value ${JSON.stringify(v)}`, 'matrix_invalid');
                seen.add(String(v));
            });
        }
    });
    if (issues.length)
        return { issues, jobs: [] };
    if (!checkGraph(checks, 'check', (i) => `pipeline.checks[${i}]`, issues, bad))
        return { issues, jobs: [] };
    // expansion bound before expanding (4 axes x 50 values would otherwise be 6.25M objects)
    const sizes = checks.map((c) => (c.matrix ? Object.values(c.matrix).reduce((n, v) => n * v.length, 1) : 1));
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total > MAX_JOBS) {
        const i = Math.max(0, checks.findIndex((c) => !!c.matrix));
        bad(checks[i]?.matrix ? `pipeline.checks[${i}].matrix` : 'pipeline.checks', `expands to ${total} jobs; at most ${MAX_JOBS} per push (${checks.map((c, k) => `${c.name}=${sizes[k]}`).join(', ')})`, 'matrix_invalid');
        return { issues, jobs: [] };
    }
    const children = new Map();
    const taken = new Map(); // job name -> producing check
    checks.forEach((c, i) => {
        const list = c.matrix
            ? combinations(c.matrix).map((values) => ({ name: matrixJobName(c.name, values), values }))
            : [{ name: c.name, values: null }];
        for (const job of list) {
            const at = c.matrix ? `pipeline.checks[${i}].matrix` : `pipeline.checks[${i}].name`;
            if (c.matrix && (job.name.length > NAME_MAX || !NAME_RE.test(job.name))) {
                bad(at, `expanded job name "${job.name}" is not a valid name (lowercase, at most ${NAME_MAX} characters)`, 'matrix_invalid');
            }
            else if (taken.has(job.name)) {
                bad(at, `expanded job name "${job.name}" collides with a job from check "${taken.get(job.name)}"`, 'matrix_invalid');
            }
            taken.set(job.name, c.name);
        }
        children.set(c.name, list);
    });
    if (issues.length)
        return { issues, jobs: [] };
    const d = D();
    const origin = []; // job index -> authored check index
    const jobs = checks.flatMap((c, ci) => children.get(c.name).map(({ name, values }) => {
        origin.push(ci);
        const sub = (s) => (values ? substitute(s, values) : s);
        const subEnv = (e) => e && Object.fromEntries(Object.entries(e).map(([k, v]) => [k, sub(v)]));
        const spec = canonSpec(c.adapter, c.image, {
            ...c,
            steps: c.steps.map((s) => ({ ...s, run: s.run.map(sub), env: subEnv(s.env) })),
        }, subEnv(c.env));
        const on = canonTrigger(c.on);
        return {
            name,
            required: c.required ?? true,
            labels: dedupe(c.labels),
            needs: dedupe(dedupe(c.needs).flatMap((n) => children.get(n).map((j) => j.name))),
            spec,
            ...(on ? { on } : {}),
            ...(values ? { matrix: { group: c.name, values: sortedMap(values), failFast: c.failFast ?? d.failFast } } : {}),
        };
    }));
    // The expanded, merged plan must satisfy the engine contract exactly (substitution can lengthen strings;
    // merging can grow maps). Any residual issue is reported at the authored path, never as jobs[i].
    const engine = normalizeJobPlans(jobs);
    if (!engine.ok)
        return { issues: engine.issues.map((i) => toAuthoring(i, checks, jobs, origin)), jobs: [] };
    return { issues, jobs, ...(tr !== undefined && tr !== DEFAULT_TARGET_REF ? { targetRef: tr } : {}) };
}
/** Map an engine-contract issue on expanded job i back to the authored check that produced it. */
function toAuthoring(i, checks, jobs, origin) {
    const m = /^jobs\[(\d+)\](?:\.spec)?(.*)$/.exec(i.path);
    if (!m)
        return i;
    const k = origin[Number(m[1])];
    let rest = m[2];
    const env = /^\.steps\[(\d+)\]\.env\.([^.]+)$/.exec(rest);
    if (env && !(env[2] in (checks[k].steps[Number(env[1])].env ?? {})))
        rest = `.env.${env[2]}`; // inherited from the check env
    const path = `pipeline.checks[${k}]${rest}`;
    const job = jobs[Number(m[1])].name;
    const suffix = job !== checks[k].name ? ` (in expanded job "${job}")` : '';
    return { code: i.code, path, message: `${path}${i.message.slice(i.path.length)}${suffix}` };
}
// ------------------------------------------------------------------ engine contract: JobPlan[] -> canonical
/**
 * Validate and canonicalize a submission's job plans exactly as the engine must (lib/pipeline imports
 * this): the `#/$defs/jobPlan` schema, then semantics (unique names, known/acyclic needs, contained paths,
 * no unexpanded matrix tokens, matrix names = canonical expansion names, sibling coherence, <= 50 jobs).
 * Idempotent: normalizeJobPlans(planPipeline(m).jobs).jobs deep-equals planPipeline(m).jobs.
 * Operator ceilings and host admission are the engine's policy and are applied after this.
 */
export function normalizeJobPlans(jobs) {
    const { issues, bad } = collector();
    if (!Array.isArray(jobs)) {
        bad('jobs', 'must be an array of job plans');
        return { ok: false, issues };
    }
    if (jobs.length > MAX_JOBS) {
        const matrixed = jobs.some((j) => j && typeof j === 'object' && 'matrix' in j);
        bad('jobs', `at most ${MAX_JOBS} jobs per submission, got ${jobs.length}`, matrixed ? 'matrix_invalid' : 'manifest_invalid');
        return { ok: false, issues };
    }
    jobs.forEach((j, i) => issues.push(...schemaIssuesToPipeline(checkSchemaNode(j, '#/$defs/jobPlan', `jobs[${i}]`))));
    if (issues.length)
        return { ok: false, issues };
    const plans = jobs;
    const names = new Set();
    const groups = new Map();
    plans.forEach((p, i) => {
        const at = `jobs[${i}]`;
        if (names.has(p.name))
            bad(`${at}.name`, `duplicate job name "${p.name}"`);
        names.add(p.name);
        checkSpecFields(p.spec, `${at}.spec`, bad, null);
        checkTrigger(p.on, at, bad);
        if (p.matrix) {
            const want = matrixJobName(p.matrix.group, p.matrix.values);
            if (p.name !== want)
                bad(`${at}.name`, `matrix job must be named "${want}" (its group and values)`, 'matrix_invalid');
            const axes = Object.keys(p.matrix.values).sort().join(',');
            const g = groups.get(p.matrix.group);
            if (!g)
                groups.set(p.matrix.group, { failFast: p.matrix.failFast, axes, at });
            else if (g.failFast !== p.matrix.failFast || g.axes !== axes) {
                bad(`${at}.matrix`, `matrix group "${p.matrix.group}" disagrees with ${g.at} on failFast or axes`, 'matrix_invalid');
            }
        }
    });
    if (issues.length)
        return { ok: false, issues };
    if (!checkGraph(plans, 'job', (i) => `jobs[${i}]`, issues, bad))
        return { ok: false, issues };
    return {
        ok: true,
        jobs: plans.map((p) => {
            const on = canonTrigger(p.on);
            return {
                name: p.name,
                required: p.required ?? true,
                labels: dedupe(p.labels),
                needs: dedupe(p.needs),
                spec: canonSpec(p.spec.adapter, p.spec.image, p.spec),
                ...(on ? { on } : {}),
                ...(p.matrix ? { matrix: { group: p.matrix.group, values: sortedMap(p.matrix.values), failFast: p.matrix.failFast } } : {}),
            };
        }),
    };
}
