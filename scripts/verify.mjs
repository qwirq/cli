// End-to-end CLI verification. Drives a REAL `qwirq login` (reads the device code the CLI prints,
// approves it like the browser would, lets the CLI poll and store the token), then runs every
// data command against the live api (:5000) + auth (:4000). Isolated config via QWIRQ_HOME.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AUTH = 'http://localhost:4000'
const API = 'http://localhost:5000'
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-cli-'))
const FAKE_EDITOR = `node "${join(process.cwd(), 'scripts', 'fake-editor.mjs')}"`

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

// Run `qwirq login`, scrape the user_code from its output, approve it out-of-band, await exit.
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
        const userCode = m[1]
        try {
          let a = await (await post('/api/device/approve', { user_code: userCode, email, password })).json()
          if (a.choose) a = await (await post('/api/device/approve/select', { user_code: userCode, ticket: a.ticket, tenantQID: '1' })).json()
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

// --- run ---
out(`config home: ${HOME}\n`)

out('login:')
const loginOut = await runLoginWithApproval()
check('login stored token + company', /Signed in to Acme/.test(loginOut), loginOut.split('\n').pop())

const who = await run(['whoami'])
check('whoami shows active company', who.stdout.includes('Acme'), who.stdout)

const wname = 'CLI Verify Weave'
const wnew = await run(['weave', 'new', wname])
const weaveQID = (wnew.stdout.match(/created weave (\d+)/) || [])[1]
check('weave new', !!weaveQID, wnew.stdout || wnew.stderr)

const wls = await run(['weave', 'ls'])
check('weave ls lists it', wls.stdout.includes(wname))

const body = '# Hello from CLI\n\nFirst line.'
const anew = await run(['article', 'new', '--weave', weaveQID, '--title', 'CLI Doc', '--stdin'], { input: body })
const articleQID = (anew.stdout.match(/created article (\d+)/) || [])[1]
check('article new', !!articleQID, anew.stdout || anew.stderr)

const aget = await run(['article', 'get', articleQID])
check('article get returns body', aget.stdout === body, JSON.stringify(aget.stdout))

const aedit = await run(['article', 'edit', articleQID], { env: { EDITOR: FAKE_EDITOR } })
check('article edit saved', /Saved/.test(aedit.stdout), aedit.stdout || aedit.stderr)
const aget2 = await run(['article', 'get', articleQID])
check('article edit persisted', aget2.stdout.includes('Edited by the CLI test.'))

const tree = await run(['tree', weaveQID])
check('tree shows article', tree.stdout.includes('CLI Doc'), tree.stdout)

const sname = 'cli_verify_secret'
const sset = await run(['secret', 'set', sname, '--stdin'], { input: 's3cr3t-CLI' })
check('secret set', /Set /.test(sset.stdout), sset.stdout || sset.stderr)
const sls = await run(['secret', 'ls'])
check('secret ls lists it', sls.stdout.includes(sname))
const srev = await run(['secret', 'reveal', sname])
check('secret reveal returns value', srev.stdout === 's3cr3t-CLI', JSON.stringify(srev.stdout))
const srm = await run(['secret', 'rm', sname])
check('secret rm', /Deleted/.test(srm.stdout))

// cleanup the test article (the empty test weave is left behind; no weave-delete command yet)
const arm = await run(['article', 'rm', articleQID])
check('article rm', /Deleted/.test(arm.stdout))

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
