// #98 robustness verification — offline, no servers needed.
// Covers the client-found defects: logout must keep endpoints, compiled defaults must be production,
// fetch failures must name their URL, and error paths must exit 1 CLEANLY (no UV_HANDLE_CLOSING /
// clobbered 127). The fetch-failure checks spawn the REAL binary so the teardown path is exercised
// on the host OS (run this on Windows for the platform-specific assertion).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
function check(label, cond, detail = '') {
  out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

// A throwaway, isolated config home per check (so nothing touches the real ~/.qwirq).
function freshHome() {
  const h = mkdtempSync(join(tmpdir(), 'qwirq-98-'))
  mkdirSync(h, { recursive: true })
  return h
}
const cfgFile = (home) => join(home, 'config.json')

// Spawn the real CLI and capture {code, stdout, stderr}. UNREACHABLE points an endpoint at a
// closed port so fetch rejects at the network layer (ECONNREFUSED) without any server.
function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}
const UNREACHABLE = 'http://127.0.0.1:9' // discard port: connection refused fast on every OS

// --- 1. Compiled-in defaults are PRODUCTION (fix #98.2) ---
{
  const home = freshHome()
  const cfgMod = await import(pathToFileURL(join(process.cwd(), 'src', 'config.mjs')).href)
  // loadConfig reads QWIRQ_HOME live; set it + clear any endpoint env overrides for this check.
  const saved = { h: process.env.QWIRQ_HOME, a: process.env.QWIRQ_AUTH_URL, p: process.env.QWIRQ_API_URL, g: process.env.QWIRQ_GIT_URL }
  process.env.QWIRQ_HOME = home
  delete process.env.QWIRQ_AUTH_URL; delete process.env.QWIRQ_API_URL; delete process.env.QWIRQ_GIT_URL
  const cfg = cfgMod.loadConfig()
  check('defaults: authBase is production', cfg.authBase === 'https://auth.qwirq.com', cfg.authBase)
  check('defaults: apiBase is production', cfg.apiBase === 'https://api.qwirq.com', cfg.apiBase)
  check('defaults: gitBase is production', cfg.gitBase === 'https://git.qwirq.com', cfg.gitBase)

  // --- 2. logout keeps endpoint overrides, drops token + company (fix #98.1) ---
  // legacy plaintext token (no keychain marker) so clearConfig() doesn't shell out to DPAPI here.
  writeFileSync(cfgFile(home), JSON.stringify({
    authBase: 'http://localhost:4000', apiBase: 'http://localhost:5000', gitBase: 'https://git.example',
    token: 'plaintext-tok', company: { name: 'Acme', role: 'owner' },
  }))
  cfgMod.clearConfig()
  const after = existsSync(cfgFile(home)) ? JSON.parse(readFileSync(cfgFile(home), 'utf8')) : {}
  check('logout keeps authBase override', after.authBase === 'http://localhost:4000', JSON.stringify(after))
  check('logout keeps apiBase override', after.apiBase === 'http://localhost:5000')
  check('logout keeps gitBase override', after.gitBase === 'https://git.example')
  check('logout drops the token', after.token === undefined)
  check('logout drops the active company', after.company === undefined)

  // and a logout with NO endpoint overrides removes the file entirely (clean slate -> prod defaults)
  writeFileSync(cfgFile(home), JSON.stringify({ token: 'plaintext-tok', company: { name: 'Acme' } }))
  cfgMod.clearConfig()
  check('logout with no overrides removes the file', !existsSync(cfgFile(home)))

  process.env.QWIRQ_HOME = saved.h; if (saved.a) process.env.QWIRQ_AUTH_URL = saved.a
  if (saved.p) process.env.QWIRQ_API_URL = saved.p; if (saved.g) process.env.QWIRQ_GIT_URL = saved.g
}

// --- 3. An API fetch failure NAMES the URL + endpoint hint, and exits 1 CLEANLY (fix #98.3 + B) ---
{
  const home = freshHome()
  // QWIRQ_TOKEN gets past the "Not signed in" guard so we actually reach the fetch.
  const r = await run(['whoami'], { QWIRQ_HOME: home, QWIRQ_TOKEN: 'fake', QWIRQ_API_URL: UNREACHABLE })
  check('api failure exits 1 (not 127/clobbered)', r.code === 1, `code=${r.code}`)
  check('api failure names the URL it tried', r.stderr.includes(UNREACHABLE), r.stderr)
  check('api failure points at apiBase config', /apiBase|QWIRQ_API_URL/.test(r.stderr))
  check('api failure is not a bare "fetch failed"', !/error:\s*fetch failed\s*$/.test(r.stderr), r.stderr)
}

// --- 4. A login fetch failure names the URL + auth hint, exits 1 cleanly (fix #98.3 + B) ---
{
  const home = freshHome()
  const r = await run(['login', '--no-browser'], { QWIRQ_HOME: home, QWIRQ_AUTH_URL: UNREACHABLE, QWIRQ_NO_BROWSER: '1' })
  check('login failure exits 1 cleanly', r.code === 1, `code=${r.code}`)
  check('login failure names the auth URL', r.stderr.includes(UNREACHABLE), r.stderr)
  check('login failure points at authBase config', /authBase|QWIRQ_AUTH_URL/.test(r.stderr))
}

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
