// #147 / FRICTION-15 — the CLI error path: a server 500 must surface as a NAMED error AND a non-zero
// exit, never a bare "server_error" that slips past `set -e`. Two parts: (1) unit-test httpError's
// status→Error mapping; (2) drive the REAL binary against a mock api that 500s on `work link`, asserting
// it exits 1 with a clear, named message. Offline. Run with: node scripts/verify-error-path.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { httpError } from '../src/api.mjs'

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }

// --- 1. httpError mapping ---
{
  const e500 = httpError(500, { error: 'server_error' })
  check('500 is NOT a bare "server_error" token', e500.message !== 'server_error' && e500.message.length > 20)
  check('500 names it an internal / platform-side error', /internal error/i.test(e500.message) && /platform-side bug/i.test(e500.message))
  check('500 carries a stable code + status', e500.code === 'server_error' && e500.status === 500)
  check('500 surfaces a detail message when present', /boom/.test(httpError(500, { error: 'server_error', message: 'boom' }).message))
  const e503 = httpError(503, null)
  check('503 (no body) still named + coded', e503.status === 503 && e503.code === 'server_error' && /internal error/i.test(e503.message))
  const e400 = httpError(400, { error: 'bad_request', message: 'op is required' })
  check('400 keeps the human message + code', e400.message === 'op is required' && e400.code === 'bad_request')
  const eDom = httpError(400, { error: 'tasks_error', code: 'link_not_allowed', message: 'nope' })
  check('400 domain error preserves the stable code', eDom.code === 'link_not_allowed' && eDom.message === 'nope')
  check('401 → login hint', /qwirq login/.test(httpError(401, null).message))
  check('403 → permission message', /permission/i.test(httpError(403, null).message))
  check('404 → names the resource', httpError(404, { resource: 'secret' }).message === 'Not found: secret.')
  check('auth host appears in a 5xx', /QWIRQ auth/.test(httpError(500, { error: 'server_error' }, { host: 'QWIRQ auth' }).message))
}

// --- 2. end-to-end: `qwirq work link` against a 500 → exit 1 + named error (the literal FRICTION-15) ---
const server = createServer((req, res) => {
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'server_error' }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const run = (args) => new Promise((resolve) => {
  const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock' } })
  let se = ''
  child.stderr.on('data', (d) => (se += d))
  child.on('close', (code) => resolve({ code, stderr: se.trim() }))
})
const r = await run(['work', 'link', 'STORY-1', 'SPR-1', '--type', 'in-sprint'])
check('a server 500 makes `qwirq work link` exit NON-ZERO (set -e stops)', r.code === 1, `exit=${r.code}`)
check('the 500 prints a NAMED error, not a bare server_error', /internal error/i.test(r.stderr) && /platform-side bug/i.test(r.stderr), r.stderr)
server.close()

out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
