/**
 * The planner entry points. Each validates the WHOLE manifest (schema, then every semantic rule for
 * checks, builds and channels) and projects its part; any issue anywhere fails the plan, nothing is
 * silently ignored. Issue codes are the engine's 400 codes, so the worker/API relay them unchanged.
 */
import { checkManifest } from './validate.js';
import { schemaIssuesToPipeline } from './grammar.js';
import { analyzeChecks } from './pipeline.js';
import { analyzeBuilds } from './builds.js';
function analyze(value) {
    const schemaIssues = checkManifest(value);
    if (schemaIssues.length)
        return { issues: schemaIssuesToPipeline(schemaIssues) };
    const m = value;
    const checks = analyzeChecks(m);
    const builds = analyzeBuilds(m);
    return { issues: [...checks.issues, ...builds.issues], checks, builds };
}
/**
 * Validate a parsed qwirq.yaml value (the whole manifest) and normalize `pipeline.checks` into the
 * engine's JobPlan[]. A manifest without `pipeline` is valid with jobs: [].
 */
export function planPipeline(value) {
    const a = analyze(value);
    if (a.issues.length || !a.checks)
        return { ok: false, issues: a.issues };
    return { ok: true, jobs: a.checks.jobs, ...(a.checks.targetRef ? { targetRef: a.checks.targetRef } : {}) };
}
/** Validate the whole manifest and normalize `pipeline.builds` and `releases.channels`. */
export function planBuilds(value) {
    const a = analyze(value);
    if (a.issues.length || !a.builds)
        return { ok: false, issues: a.issues };
    return { ok: true, builds: a.builds.builds, channels: a.builds.channels };
}
