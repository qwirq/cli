// End-to-end verification of the work/ci verbs (#58): drives a REAL `qwirq login` (device flow,
// approved out-of-band like the browser), ensures the tenant's app DB exists, then exercises every
// `qwirq work` / `qwirq work-type` / `qwirq ci` / `qwirq ci-type` verb against the live api (:5000) +
// auth (:4000) -> @qwirq/tasks/@qwirq/cmdb over the tenant's Neon DB. Isolated config via QWIRQ_HOME.
// Names are run-tagged so the suite is re-runnable, and everything it creates is cleaned up at the end.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AUTH = 'http://localhost:4000'
const API = 'http://localhost:5000'
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-cli-wp-'))
const TAG = 'v' + Date.now().toString(36).slice(-5) // unique, short suffix per run

// Dev-login creds for the device-flow approval. No baked secret: take QWIRQ_DEV_LOGIN_* from the env
// if set, else read apps/auth/.env.local (the local dev source of truth), else fail loudly. The repo is
// public, so nothing personal or secret is hardcoded here.
function devCreds() {
  let env = ''
  try { env = readFileSync('../auth/.env.local', 'utf8') } catch { /* fall through to env vars / error */ }
  const get = (k) => { const l = env.split(/\r?\n/).find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1) : undefined }
  const email = process.env.QWIRQ_DEV_LOGIN_EMAIL || get('NEXT_PUBLIC_DEV_LOGIN_EMAIL')
  const password = process.env.QWIRQ_DEV_LOGIN_PASSWORD || get('NEXT_PUBLIC_DEV_LOGIN_PASSWORD')
  if (!email || !password) {
    throw new Error('dev-login creds missing: set QWIRQ_DEV_LOGIN_EMAIL + QWIRQ_DEV_LOGIN_PASSWORD, or run from apps/cli with ../auth/.env.local providing NEXT_PUBLIC_DEV_LOGIN_EMAIL + NEXT_PUBLIC_DEV_LOGIN_PASSWORD')
  }
  return { email, password }
}

const baseEnv = () => ({ ...process.env, QWIRQ_HOME: HOME, QWIRQ_API_URL: API, QWIRQ_AUTH_URL: AUTH })

function run(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...baseEnv(), ...env } })
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
const idFrom = (s) => (s.match(/created (\S+)/) || [])[1]

// --- run ---
out(`config home: ${HOME}\nrun tag: ${TAG}\n`)

out('login:')
const loginOut = await runLoginWithApproval()
check('login stored token + company', /Signed in/.test(loginOut), loginOut.split('\n').pop())

// Ensure the tenant has an app database (provision is idempotent; may be slow on first creation).
const status = await run(['data', 'status'])
if (!/ready/.test(status.stdout)) { out('provisioning app DB (first run, may take ~1 min)…'); const prov = await run(['data', 'provision']); check('data provision', /Provisioned|already exists/.test(prov.stdout), prov.stdout || prov.stderr) }
else check('app DB ready', true, status.stdout)

const wt = `task_${TAG}`, ct = `service_${TAG}`

out('\nwork:')
const winit = await run(['work', 'init'])
check('work init (migrate tasks)', /tables/.test(winit.stdout), winit.stdout || winit.stderr)

const wtdef = await run(['work-type', 'define', wt, '--prefix', `T${TAG}`.toUpperCase(), '--states', 'open,doing,done', '--transitions', 'open>doing,doing>done,doing>open'])
check('work-type define', /defined work-item type/.test(wtdef.stdout), wtdef.stdout || wtdef.stderr)

const wnew = await run(['work', 'new', '--type', wt, '--title', 'Root task'])
const T1 = idFrom(wnew.stdout)
check('work new -> short id', !!T1, wnew.stdout || wnew.stderr)

const wls = await run(['work', 'ls', '--type', wt])
check('work ls lists it', wls.stdout.includes(T1), wls.stdout)

const wtrans = await run(['work', 'transition', T1, 'doing'])
check('work transition open->doing', new RegExp(`${T1} → doing`).test(wtrans.stdout), wtrans.stdout || wtrans.stderr)

const wbad = await run(['work', 'transition', T1, 'done'])  // doing->done IS allowed; use an illegal one instead
const wbad2 = await run(['work', 'transition', T1, 'nonsense'])
check('illegal transition rejected (bad_transition)', /not allowed/.test(wbad2.stderr), wbad2.stderr || wbad2.stdout)

const wchild = await run(['work', 'new', '--type', wt, '--title', 'Child task', '--parent', T1])
const T2 = idFrom(wchild.stdout)
check('work new with --parent', !!T2, wchild.stdout || wchild.stderr)

const wtree = await run(['work', 'tree', T1])
check('work tree shows child', wtree.stdout.includes(T2), wtree.stdout)

const wset = await run(['work', 'set', T1, '--assignee', 'nathan', '--priority', '2'])
check('work set assignee+priority', /updated/.test(wset.stdout), wset.stdout || wset.stderr)
const wshow = await run(['work', 'show', T1])
check('work show reflects assignee', /assignee: nathan/.test(wshow.stdout) && /priority: 2/.test(wshow.stdout), wshow.stdout)

const wlink = await run(['work', 'link', T1, T2, '--type', 'relates'])
check('work link', /linked/.test(wlink.stdout), wlink.stdout || wlink.stderr)

out('\nci:')
const ciinit = await run(['ci', 'init'])
check('ci init (migrate cmdb)', /tables/.test(ciinit.stdout), ciinit.stdout || ciinit.stderr)

const ctdef = await run(['ci-type', 'define', ct, '--prefix', `S${TAG}`.toUpperCase()])
check('ci-type define', /defined CI type/.test(ctdef.stdout), ctdef.stdout || ctdef.stderr)

const cinew = await run(['ci', 'new', '--type', ct, '--name', 'Billing API'])
const C1 = idFrom(cinew.stdout)
check('ci new -> short id', !!C1, cinew.stdout || cinew.stderr)

const cinew2 = await run(['ci', 'new', '--type', ct, '--name', 'Postgres'])
const C2 = idFrom(cinew2.stdout)
check('ci new #2', !!C2, cinew2.stdout || cinew2.stderr)

const cils = await run(['ci', 'ls', '--type', ct])
check('ci ls lists both', cils.stdout.includes(C1) && cils.stdout.includes(C2), cils.stdout)

const crel = await run(['ci', 'relate', C1, C2, '--type', 'depends-on'])
check('ci relate', /related/.test(crel.stdout), crel.stdout || crel.stderr)
const cshow = await run(['ci', 'show', C1])
check('ci show reflects relationship', /depends-on/.test(cshow.stdout), cshow.stdout)

out('\nseam:')
const linkci = await run(['work', 'link-ci', T1, C1, '--rel', 'works-on'])
check('work link-ci (resolves CI short id)', /linked/.test(linkci.stdout), linkci.stdout || linkci.stderr)
const wshow2 = await run(['work', 'show', T1])
check('work show lists the CI link', /ci:\s+works-on/.test(wshow2.stdout), wshow2.stdout)

out('\ncleanup:')
const c1 = await run(['work', 'link-ci', T1, C1, '--rel', 'works-on', '--remove'])
const c2 = await run(['work', 'link', T1, T2, '--type', 'relates', '--remove'])
const c3 = await run(['work', 'rm', T2, '--yes'])
const c4 = await run(['work', 'rm', T1, '--yes'])
const c5 = await run(['work-type', 'rm', wt])
const c6 = await run(['ci', 'relate', C1, C2, '--type', 'depends-on', '--remove'])
const c7 = await run(['ci', 'rm', C1, '--yes'])
const c8 = await run(['ci', 'rm', C2, '--yes'])
const c9 = await run(['ci-type', 'rm', ct])
const cleaned = [c1, c2, c3, c4, c5, c6, c7, c8, c9].every((r) => r.code === 0)
check('cleanup removed all test data', cleaned, [c1, c2, c3, c4, c5, c6, c7, c8, c9].filter((r) => r.code !== 0).map((r) => r.stderr).join(' | '))

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
