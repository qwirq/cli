// Verifies the qwirq.yaml manifest validator (#44 / DX-5) against the bundled schema. Pure, offline.
//   node scripts/verify-manifest.mjs
import { parseManifestText, validateManifest, planPipeline, ensureModeline, loadSchema } from '../src/manifest.mjs'

let fail = 0
const check = (label, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) fail++ }

// The full canonical manifest from DEV-EXPERIENCE-PLAN.md §3 must validate clean.
const good = `
id: helpdesk
name: Help Desk
icon: ticket
nav: { section: apps, order: 30 }
requires: { action: read, resourceType: helpdesk }
provides:
  app: { entry: src/app/index.tsx }
  functions:
    - { name: assignTicket, entry: src/server/assign.ts, http: "POST /assign" }
  jobs:
    - { name: nightlySla, entry: src/server/sla.ts, schedule: "0 2 * * *" }
data: { migrations: ./migrations }
runtime: node20
platform: "2026.06"
`
check('canonical §3 manifest validates clean', validateManifest(parseManifestText(good)).length === 0, JSON.stringify(validateManifest(parseManifestText(good))))

// Each rule the schema enforces should produce an error.
const cases = [
  ['missing id', 'name: X\nprovides: { app: { entry: a.tsx } }', /missing required "id"/],
  ['bad id pattern', 'id: Bad_Id\nname: X\nprovides: { app: { entry: a.tsx } }', /does not match/],
  ['empty name', 'id: ok\nname: ""\nprovides: { app: { entry: a.tsx } }', /name: must not be empty/],
  ['no provides capability', 'id: ok\nname: X\nprovides: {}', /at least 1 of app/],
  ['unknown top-level field', 'id: ok\nname: X\nprovides: { app: { entry: a.tsx } }\nbogus: 1', /bogus: unknown field/],
  ['bad runtime enum', 'id: ok\nname: X\nprovides: { app: { entry: a.tsx } }\nruntime: cobol', /not one of node20/],
  ['bad platform pattern', 'id: ok\nname: X\nprovides: { app: { entry: a.tsx } }\nplatform: "26.6"', /does not match/],
  ['function missing name', 'id: ok\nname: X\nprovides: { functions: [ { entry: a.ts } ] }', /missing required "name"/],
  ['unknown nested field', 'id: ok\nname: X\nprovides: { app: { entry: a.tsx, oops: 1 } }', /oops: unknown field/],
]
for (const [label, yaml, re] of cases) {
  const errs = validateManifest(parseManifestText(yaml))
  check(label + ' -> error', errs.some((e) => re.test(e)), errs.join(' | '))
}

// modeline is idempotent.
const withLine = '# yaml-language-server: $schema=x\nid: a\n'
check('ensureModeline adds when missing', ensureModeline('id: a\n', 'x').startsWith('# yaml-language-server:'))
check('ensureModeline is idempotent', ensureModeline(withLine, 'y') === withLine)

// schema file is loadable + well-formed.
check('bundled schema loads + has $id', typeof loadSchema().$id === 'string')

// M0 pipeline (vendored @qwirq/manifest 0.4.0: dist/pipeline.js + schema `pipeline`).
const IMAGE = 'node:20-bookworm-slim@sha256:' + 'a'.repeat(64)
const pipelineOnly = `id: sample
name: Sample
pipeline:
  checks:
    - name: test
      adapter: command
      image: ${IMAGE}
      labels: [linux]
      steps:
        - { name: test, run: [node, test.mjs], network: none }
`
const po = parseManifestText(pipelineOnly)
check('pipeline-only manifest validates without provides', validateManifest(po).length === 0, validateManifest(po).join(' | '))
const plan = planPipeline(po)
check('planPipeline -> one canonical JobPlan (defaults filled)', plan.ok && plan.jobs.length === 1 && plan.jobs[0].spec.limits.seconds === 1800 && plan.jobs[0].required === true, JSON.stringify(plan))
check('schema declares pipeline', !!loadSchema().properties?.pipeline)
const neither = validateManifest(parseManifestText('id: ok\nname: X'))
check('neither provides nor pipeline -> error', neither.some((e) => /provides/.test(e) && /pipeline/.test(e)), neither.join(' | '))
const badAdapter = planPipeline(parseManifestText(pipelineOnly.replace('adapter: command', 'adapter: gradle')))
check('unknown adapter -> adapter_unknown', !badAdapter.ok && badAdapter.issues.some((i) => i.code === 'adapter_unknown'), JSON.stringify(badAdapter))
// 0.5.0 (vendored 410cbf3): network profiles + the build/channel planner ship in the runtime.
const deps = parseManifestText(pipelineOnly.replace('network: none', 'network: dependencies'))
check('0.5.0: step network "dependencies" validates and plans', validateManifest(deps).length === 0 && planPipeline(deps).ok, validateManifest(deps).join(' | '))
const rt = await import('../vendor/manifest/dist/index.js')
check('0.5.0: runtime exports planBuilds + normalizeJobPlans + NETWORK_PROFILES', typeof rt.planBuilds === 'function' && typeof rt.normalizeJobPlans === 'function' && rt.NETWORK_PROFILES != null)

console.log('')
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`)
process.exit(fail ? 1 : 0)
