// D5: the stored token is read (keychain/DPAPI) at most once per process. Before, every API request
// re-read it, and on Windows each read spawns PowerShell for DPAPI (~0.5-1 s), so a polling verb paid
// that on every poll. Drives the REAL binary through a 20-poll `jobs logs --follow` against a mock
// API, counting keychain-helper spawns with a preload that wraps child_process.execFileSync (no
// product hook). Also: QWIRQ_TOKEN still wins (no keychain spawn at all), and login/logout inside one
// process invalidate the memo. Prints inter-poll timing for before/after comparison.
//   node scripts/verify-token-cache.mjs [--bin <path to another checkout's bin/qwirq.mjs>]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const binAt = process.argv.indexOf('--bin')
const BIN = binAt > 0 ? resolve(process.argv[binAt + 1]) : resolve(here, '..', 'bin', 'qwirq.mjs')
const POLLS = 20
const TOKEN = 'qwirq_pat_D5_CACHE_TEST'

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); if (!cond) failures++ }

if (process.platform === 'darwin') {
  out('note  darwin: skipped (the keychain path would write the real login Keychain)')
  process.exit(0)
}

// --- preload: count spawns of the keychain helpers in the child ---
const work = mkdtempSync(join(tmpdir(), 'qwirq-d5-'))
const preload = join(work, 'count-keychain.mjs')
writeFileSync(preload, `import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const orig = cp.execFileSync
let n = 0
cp.execFileSync = function (cmd, ...rest) { if (/^(powershell|security|secret-tool)(\\.exe)?$/i.test(String(cmd))) n++; return orig.call(this, cmd, ...rest) }
syncBuiltinESMExports()
process.on('exit', () => process.stderr.write('\\nKEYCHAIN_SPAWNS=' + n + '\\n'))
`)

// --- mock API: POLLS non-terminal log pages, then a terminal one; the job succeeds ---
let polls = 0
const seen = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  seen.push({ path: url.pathname, auth: req.headers.authorization, at: Date.now() })
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (url.pathname === '/api/v1/pipeline/jobs/31/log') {
    polls++
    const after = Number(url.searchParams.get('after'))
    const terminal = polls > POLLS
    return send(200, { attempt: 1, lines: [{ seq: after + 1, at: new Date().toISOString(), step: 'test', stream: 'out', text: `poll ${polls}` }], nextAfter: after + 1, hasMore: false, terminal, truncated: false })
  }
  if (url.pathname === '/api/v1/pipeline/jobs/31') {
    return send(200, { job: { qid: '31', state: 'succeeded', attempt: 1 }, attempts: [{ attempt: 1, state: 'succeeded' }], artifacts: [], permissions: { retry: false, cancel: false } })
  }
  return send(404, { error: 'not_found', code: 'not_found', message: 'nope' })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

function run(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: work })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d))
    child.stderr.on('data', (d) => (se += d))
    child.on('close', (code) => done({ code, stdout: so, stderr: se, spawns: Number((se.match(/KEYCHAIN_SPAWNS=(\d+)/) || [])[1] ?? NaN) }))
  })
}
const baseEnv = (home) => {
  const e = { ...process.env, QWIRQ_HOME: home, QWIRQ_API_URL: BASE, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` }
  delete e.QWIRQ_TOKEN
  delete e.QWIRQ_POLL_MS // real 500 ms follow cadence, so the timing is the user's
  return e
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN }

// --- 1. stored token: Windows DPAPI keychain; elsewhere the plaintext config (each read used to retry the keychain) ---
const home = mkdtempSync(join(tmpdir(), 'qwirq-d5-home-'))
process.env.QWIRQ_HOME = home
if (process.platform === 'win32') {
  const { keychainStore } = await import('../src/keychain.mjs')
  check('setup: token stored with Windows DPAPI in a temp QWIRQ_HOME', keychainStore(TOKEN) === 'Windows DPAPI')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ tokenStore: 'keychain' }))
} else {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: TOKEN }))
}
const t0 = Date.now()
const r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'], baseEnv(home))
const elapsed = Date.now() - t0
const logReqs = seen.filter((s) => s.path.endsWith('/log'))
const gaps = logReqs.slice(1).map((s, i) => s.at - logReqs[i].at)
out(`info  bin=${BIN}`)
out(`info  ${logReqs.length} log polls in ${elapsed} ms; gap between polls median ${median(gaps)} ms, max ${Math.max(...gaps)} ms (500 ms poll cadence); keychain spawns ${r.spawns}`)
check(`follow over ${POLLS + 1} polls exits 0`, r.code === 0, `exit=${r.code} ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`)
check('every request carried the stored token', seen.length >= POLLS + 2 && seen.every((s) => s.auth === `Bearer ${TOKEN}`))
check('the keychain was touched exactly once for the whole follow', r.spawns === 1, `spawns=${r.spawns}`)

// --- 2. QWIRQ_TOKEN still wins, and never touches the keychain ---
polls = 0
seen.length = 0
const r2 = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'], { ...baseEnv(home), QWIRQ_TOKEN: 'qwirq_pat_FROM_ENV', QWIRQ_POLL_MS: '20' })
check('QWIRQ_TOKEN precedence: every request uses the env token', r2.code === 0 && seen.every((s) => s.auth === 'Bearer qwirq_pat_FROM_ENV'))
check('QWIRQ_TOKEN: zero keychain spawns', r2.spawns === 0, `spawns=${r2.spawns}`)
server.close()

// --- 3. in-process: login (writeToken) and logout (clearConfig) invalidate the memo ---
{
  const h = mkdtempSync(join(tmpdir(), 'qwirq-d5-proc-'))
  process.env.QWIRQ_HOME = h
  delete process.env.QWIRQ_TOKEN
  writeFileSync(join(h, 'config.json'), JSON.stringify({ token: 'tok-1' }))
  const { readToken, writeToken, clearConfig } = await import('../src/config.mjs')
  check('first read resolves the stored token', readToken() === 'tok-1')
  writeToken('tok-2')
  check('login in the same process: the new token is used at once', readToken() === 'tok-2')
  process.env.QWIRQ_TOKEN = 'tok-env'
  check('QWIRQ_TOKEN set later still wins over the memo', readToken() === 'tok-env')
  delete process.env.QWIRQ_TOKEN
  clearConfig()
  check('logout in the same process: no token afterwards', readToken() === null)
}

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
