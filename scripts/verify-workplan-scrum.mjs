// End-to-end verification of the `qwirq workplan` verbs (#200): drives a REAL `qwirq login`
// (device flow, approved out-of-band), ensures the tenant's app DB exists, installs the six
// Workplan type policies via `workplan init`, then exercises every verb — create, set, transition
// (incl. guarded + terminal), move, link, sprint assign, ls, show — for each of the six types
// (request, project, epic, story, task, sprint). Validates --json shapes. Cleans up at the end.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AUTH = 'http://localhost:4000'
const API = 'http://localhost:5000'
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-cli-wpscrum-'))
const TAG = 'v' + Date.now().toString(36).slice(-5) // unique suffix per run

function devCreds() {
  let env = ''
  try { env = readFileSync('../auth/.env.local', 'utf8') } catch { /* fall through */ }
  const get = (k) => { const l = env.split(/\r?\n/).find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1) : undefined }
  const email = process.env.QWIRQ_DEV_LOGIN_EMAIL || get('NEXT_PUBLIC_DEV_LOGIN_EMAIL')
  const password = process.env.QWIRQ_DEV_LOGIN_PASSWORD || get('NEXT_PUBLIC_DEV_LOGIN_PASSWORD')
  if (!email || !password) throw new Error('dev-login creds missing: set QWIRQ_DEV_LOGIN_EMAIL + QWIRQ_DEV_LOGIN_PASSWORD')
  return { email, password }
}

const baseEnv = () => ({ ...process.env, QWIRQ_HOME: HOME, QWIRQ_API_URL: API, QWIRQ_AUTH_URL: AUTH })

function run(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: baseEnv() })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (input !== undefined) { child.stdin.write(input); child.stdin.end() }
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

const post = (path, body) => fetch(AUTH + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function runLoginWithApproval() {
  const { email, password } = devCreds()
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['bin/qwirq.mjs', 'login', '--no-browser'], { env: baseEnv() })
    let stdout = '', approved = false
    child.stdout.on('data', async (d) => {
      stdout += d
      const m = stdout.match(/confirm the code:\s*([A-Z0-9-]+)/)
      if (m && !approved) {
        approved = true
        try {
          let a = await (await post('/api/device/approve', { user_code: m[1], email, password })).json()
          if (a.choose) a = await (await post('/api/device/approve/select', { user_code: m[1], ticket: a.ticket, tenantQID: '1' })).json()
          if (!a.ok) reject(new Error('approval failed: ' + JSON.stringify(a)))
        } catch (e) { reject(e) }
      }
    })
    child.on('close', () => resolve(stdout.trim()))
    child.on('error', reject)
  })
}

let failures = 0
function check(label, cond, detail = '') {
  out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}
function out(s) { process.stdout.write(s + '\n') }
// Extract the first short-id (e.g. PRJ-1) from output
const idFrom = (s) => (s.match(/([A-Z]+-\d+)/) || [])[1]
// Parse --json output safely
const parseJson = (s) => { try { return JSON.parse(s) } catch { return null } }

// ─── login ───────────────────────────────────────────────────────────────────
out(`config home: ${HOME}\nrun tag: ${TAG}\n`)
out('login:')
const loginOut = await runLoginWithApproval()
check('login stored token', /Signed in/.test(loginOut), loginOut.split('\n').pop())

// Ensure app DB (idempotent)
const dbStatus = await run(['data', 'status'])
if (!/ready/.test(dbStatus.stdout)) {
  out('provisioning app DB…')
  const prov = await run(['data', 'provision'])
  check('data provision', /Provisioned|already exists/.test(prov.stdout), prov.stdout || prov.stderr)
} else check('app DB ready', true, dbStatus.stdout)

// ─── workplan init ───────────────────────────────────────────────────────────
out('\nworkplan init:')
const init1 = await run(['workplan', 'init'])
check('workplan init exits 0', init1.code === 0, init1.stderr)
check('workplan init defined/updated all types', /Workplan types ready/.test(init1.stdout), init1.stdout || init1.stderr)

// idempotent: run again (all types already exist → update path)
const init2 = await run(['workplan', 'init'])
check('workplan init idempotent (2nd run)', init2.code === 0, init2.stderr)

// workplan types
const types = await run(['workplan', 'types'])
check('workplan types lists all 6', ['REQ', 'PRJ', 'EPC', 'STY', 'TSK', 'SPR'].every((p) => types.stdout.includes(p)), types.stdout)

// workplan types --json
const typesJson = await run(['workplan', 'types', '--json'])
const typesJ = parseJson(typesJson.stdout)
check('workplan types --json ok', typesJ?.ok === true && Array.isArray(typesJ.types), typesJson.stdout)
check('workplan types --json has 6 types', typesJ?.types?.length === 6, JSON.stringify(typesJ?.types?.map((t) => t.name)))

// ─── project ─────────────────────────────────────────────────────────────────
out('\nproject:')
const prjNew = await run(['workplan', 'create', 'project', '--title', `P_${TAG}`])
const PRJ = idFrom(prjNew.stdout)
check('workplan create project -> PRJ-N', !!PRJ && PRJ.startsWith('PRJ-'), prjNew.stdout || prjNew.stderr)

const prjSet = await run(['workplan', 'set', PRJ, '--assignee', 'tester'])
check('workplan set project assignee', /updated/.test(prjSet.stdout), prjSet.stdout || prjSet.stderr)

// transition: planning->active (guarded: requires assignee; we set it above via set)
const prjAct = await run(['workplan', 'transition', PRJ, 'active'])
check('project planning->active (gate: assignee set)', /→ active/.test(prjAct.stdout), prjAct.stdout || prjAct.stderr)

// project show --json
const prjShowJ = await run(['workplan', 'show', PRJ, '--json'])
const pJ = parseJson(prjShowJ.stdout)
check('workplan show project --json', pJ?.ok === true && pJ?.item?.shortId === PRJ, prjShowJ.stdout)

// ─── sprint ───────────────────────────────────────────────────────────────────
out('\nsprint:')
const sprNew = await run(['workplan', 'create', 'sprint', '--title', `Sprint_${TAG}`, '--parent', PRJ, '--start', '2026-07-01', '--end', '2026-07-14'])
const SPR = idFrom(sprNew.stdout)
check('workplan create sprint -> SPR-N', !!SPR && SPR.startsWith('SPR-'), sprNew.stdout || sprNew.stderr)

// sprint missing --start should fail
const sprBad = await run(['workplan', 'create', 'sprint', '--title', 'Bad'])
check('sprint without --start fails (exit 1)', sprBad.code === 1, sprBad.stderr)
check('sprint without --start has useful message', /requires --start/.test(sprBad.stderr), sprBad.stderr)

// transition: planning->active
const sprAct = await run(['workplan', 'transition', SPR, 'active'])
check('sprint planning->active', /→ active/.test(sprAct.stdout), sprAct.stdout || sprAct.stderr)

// terminal: active->closed
const sprClose = await run(['workplan', 'transition', SPR, 'closed'])
check('sprint active->closed (terminal)', /→ closed/.test(sprClose.stdout), sprClose.stdout || sprClose.stderr)

// ─── epic ─────────────────────────────────────────────────────────────────────
out('\nepic:')
// epic without parent should fail (requireParent: true)
const epcBad = await run(['workplan', 'create', 'epic', '--title', 'Orphan epic'])
check('epic without parent fails (exit 1)', epcBad.code === 1, epcBad.stderr)
check('epic without parent has useful message', /requires a parent/.test(epcBad.stderr), epcBad.stderr)

const epcNew = await run(['workplan', 'create', 'epic', '--title', `E_${TAG}`, '--project', PRJ])
const EPC = idFrom(epcNew.stdout)
check('workplan create epic -> EPC-N', !!EPC && EPC.startsWith('EPC-'), epcNew.stdout || epcNew.stderr)

const epcTrans = await run(['workplan', 'transition', EPC, 'in-progress'])
check('epic open->in-progress', /→ in-progress/.test(epcTrans.stdout), epcTrans.stdout || epcTrans.stderr)

// illegal transition: in-progress->submitted (nonsense)
const epcBadTrans = await run(['workplan', 'transition', EPC, 'submitted'])
check('epic illegal transition rejected (exit 1)', epcBadTrans.code === 1, epcBadTrans.stderr)

// terminal: in-progress->cancelled
const epcCancel = await run(['workplan', 'transition', EPC, 'cancelled'])
check('epic in-progress->cancelled (terminal)', /→ cancelled/.test(epcCancel.stdout), epcCancel.stdout || epcCancel.stderr)

// create a fresh epic for story tests
const epcNew2 = await run(['workplan', 'create', 'epic', '--title', `E2_${TAG}`, '--parent', PRJ])
const EPC2 = idFrom(epcNew2.stdout)
check('workplan create epic #2 for story tests', !!EPC2 && EPC2.startsWith('EPC-'), epcNew2.stdout || epcNew2.stderr)

// ─── story ────────────────────────────────────────────────────────────────────
out('\nstory:')
const styNew = await run(['workplan', 'create', 'story', '--title', `S_${TAG}`, '--epic', EPC2])
const STY = idFrom(styNew.stdout)
check('workplan create story -> STY-N', !!STY && STY.startsWith('STY-'), styNew.stdout || styNew.stderr)

// story open->in-progress without assignee should fail (transition rule: requireAssignee)
const styBadTrans = await run(['workplan', 'transition', STY, 'in-progress'])
check('story open->in-progress without assignee fails (gate enforced server-side)', styBadTrans.code === 1, styBadTrans.stderr)

// set assignee, then transition
const styAssign = await run(['workplan', 'set', STY, '--assignee', 'dev1'])
check('workplan set story assignee', /updated/.test(styAssign.stdout), styAssign.stdout || styAssign.stderr)

const styTrans = await run(['workplan', 'transition', STY, 'in-progress'])
check('story open->in-progress (gate: assignee set)', /→ in-progress/.test(styTrans.stdout), styTrans.stdout || styTrans.stderr)

// set story points, then transition to in-review
const styPoints = await run(['workplan', 'set', STY, '--points', '5'])
check('workplan set story --points 5', /updated/.test(styPoints.stdout), styPoints.stdout || styPoints.stderr)

const styReview = await run(['workplan', 'transition', STY, 'in-review'])
check('story in-progress->in-review (gate: points set)', /→ in-review/.test(styReview.stdout), styReview.stdout || styReview.stderr)

// in-review->done (terminal)
const styDone = await run(['workplan', 'transition', STY, 'done'])
check('story in-review->done (terminal)', /→ done/.test(styDone.stdout), styDone.stdout || styDone.stderr)

// create a 2nd story for sprint + task tests
const styNew2 = await run(['workplan', 'create', 'story', '--title', `S2_${TAG}`, '--epic', EPC2, '--assignee', 'dev2'])
const STY2 = idFrom(styNew2.stdout)
check('workplan create story #2', !!STY2 && STY2.startsWith('STY-'), styNew2.stdout || styNew2.stderr)

// sprint assign (second sprint – create a new one in planning to avoid "closed" gate issues)
const sprNew2 = await run(['workplan', 'create', 'sprint', '--title', `Sprint2_${TAG}`, '--parent', PRJ, '--start', '2026-07-15', '--end', '2026-07-28'])
const SPR2 = idFrom(sprNew2.stdout)
check('workplan create sprint #2', !!SPR2, sprNew2.stdout || sprNew2.stderr)

const sprAssign = await run(['workplan', 'sprint', 'assign', STY2, SPR2])
check('workplan sprint assign', /assigned.*to sprint/.test(sprAssign.stdout), sprAssign.stdout || sprAssign.stderr)

// sprint assign --json
const sprAssignJ = await run(['workplan', 'sprint', 'assign', STY2, SPR2, '--remove', '--json'])
const saJ = parseJson(sprAssignJ.stdout)
check('workplan sprint assign --remove --json', saJ?.ok === true && saJ?.action === 'unassigned', sprAssignJ.stdout)

// ─── task ─────────────────────────────────────────────────────────────────────
out('\ntask:')
const tskNew = await run(['workplan', 'create', 'task', '--title', `T_${TAG}`, '--story', STY2])
const TSK = idFrom(tskNew.stdout)
check('workplan create task -> TSK-N', !!TSK && TSK.startsWith('TSK-'), tskNew.stdout || tskNew.stderr)

const tskSetA = await run(['workplan', 'set', TSK, '--assignee', 'dev2'])
check('workplan set task assignee', /updated/.test(tskSetA.stdout), tskSetA.stdout || tskSetA.stderr)

const tskTrans = await run(['workplan', 'transition', TSK, 'doing'])
check('task todo->doing (gate: assignee set)', /→ doing/.test(tskTrans.stdout), tskTrans.stdout || tskTrans.stderr)

const tskDone = await run(['workplan', 'transition', TSK, 'done'])
check('task doing->done (terminal)', /→ done/.test(tskDone.stdout), tskDone.stdout || tskDone.stderr)

// ─── request ──────────────────────────────────────────────────────────────────
out('\nrequest:')
const reqNew = await run(['workplan', 'create', 'request', '--title', `R_${TAG}`])
const REQ = idFrom(reqNew.stdout)
check('workplan create request -> REQ-N', !!REQ && REQ.startsWith('REQ-'), reqNew.stdout || reqNew.stderr)

const reqTriage = await run(['workplan', 'transition', REQ, 'triaged'])
check('request submitted->triaged', /→ triaged/.test(reqTriage.stdout), reqTriage.stdout || reqTriage.stderr)

// terminal: triaged->converted
const reqConv = await run(['workplan', 'transition', REQ, 'converted'])
check('request triaged->converted (terminal)', /→ converted/.test(reqConv.stdout), reqConv.stdout || reqConv.stderr)

// create a second request, reject it
const reqNew2 = await run(['workplan', 'create', 'request', '--title', `R2_${TAG}`, '--json'])
const rJ = parseJson(reqNew2.stdout)
check('workplan create request --json', rJ?.ok === true && !!rJ?.item?.shortId, reqNew2.stdout)
const REQ2 = rJ?.item?.shortId

const reqTriage2 = await run(['workplan', 'transition', REQ2, 'triaged'])
const reqReject = await run(['workplan', 'transition', REQ2, 'rejected'])
check('request triaged->rejected (terminal)', /→ rejected/.test(reqReject.stdout), reqReject.stdout || reqReject.stderr)

// ─── link + reparent ──────────────────────────────────────────────────────────
out('\nlink + move:')
const linkRes = await run(['workplan', 'link', STY, STY2, '--type', 'relates-to'])
check('workplan link relates-to', /linked/.test(linkRes.stdout), linkRes.stdout || linkRes.stderr)

const linkJ = await run(['workplan', 'link', STY, STY2, '--type', 'relates-to', '--remove', '--json'])
const lJ = parseJson(linkJ.stdout)
check('workplan link --remove --json', lJ?.ok === true && lJ?.action === 'unlinked', linkJ.stdout)

// create a fresh epic for the reparent test
const epcNew3 = await run(['workplan', 'create', 'epic', '--title', `E3_${TAG}`, '--parent', PRJ])
const EPC3 = idFrom(epcNew3.stdout)
check('workplan create epic #3 (for move test)', !!EPC3, epcNew3.stdout || epcNew3.stderr)

const moveRes = await run(['workplan', 'move', STY2, EPC3])
check('workplan move story to different epic', /moved/.test(moveRes.stdout), moveRes.stdout || moveRes.stderr)

// ─── ls ───────────────────────────────────────────────────────────────────────
out('\nls:')
const lsAll = await run(['workplan', 'ls'])
check('workplan ls returns items', lsAll.code === 0, lsAll.stderr)

const lsReq = await run(['workplan', 'ls', '--type', 'request'])
check('workplan ls --type request', lsReq.stdout.includes(REQ) || lsReq.stdout.includes(REQ2), lsReq.stdout)

const lsBadType = await run(['workplan', 'ls', '--type', 'bogus'])
check('workplan ls --type bogus fails (exit 1)', lsBadType.code === 1, lsBadType.stderr)

const lsJson = await run(['workplan', 'ls', '--json'])
const ljData = parseJson(lsJson.stdout)
check('workplan ls --json ok shape', ljData?.ok === true && Array.isArray(ljData.items), lsJson.stdout)

// ─── show ─────────────────────────────────────────────────────────────────────
out('\nshow:')
const showSty = await run(['workplan', 'show', STY])
check('workplan show story', showSty.stdout.includes(STY), showSty.stdout)

const showStyJ = await run(['workplan', 'show', STY, '--json'])
const sjData = parseJson(showStyJ.stdout)
check('workplan show --json ok shape', sjData?.ok === true && sjData?.item?.shortId === STY, showStyJ.stdout)
check('workplan show --json includes links + events', Array.isArray(sjData?.links?.outgoing) && Array.isArray(sjData?.events), JSON.stringify({ links: sjData?.links, events: sjData?.events?.length }))

// ─── cleanup ──────────────────────────────────────────────────────────────────
out('\ncleanup:')
// Transition anything still in non-terminal to cancelled/done before rm (rm requires no children).
const cleanItems = [TSK, STY2, STY, EPC3, EPC2, EPC, SPR2, SPR]
// Remove task (child of STY2), then stories, epics, sprints, project, requests
const rms = []
for (const ref of [...cleanItems, PRJ, REQ, REQ2]) {
  const r = await run(['work', 'rm', ref, '--yes'])
  rms.push({ ref, ok: r.code === 0 })
}
const rmOk = rms.every((r) => r.ok)
check('cleanup removed all test items', rmOk, rms.filter((r) => !r.ok).map((r) => r.ref).join(', ') || 'all ok')

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
