// #115 token/agent CLI verbs — offline, against an in-memory mock of the auth token endpoints.
// Drives the REAL binary so arg parsing, the authBase routing, request shape (method/path/body), and
// the mint/ls/revoke output are exercised. The dev-DB integration of the underlying lib is proven
// separately (apps/auth/scripts/verify-tokens.ts). No auth server or DB needed.
import { spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'

const reqs = []
const tokens = [
  { qid: '1', name: 'laptop', scope: null, createdAt: '2026-06-01T00:00:00Z', lastUsedAt: '2026-06-09T00:00:00Z', expiresAt: null, revokedAt: null },
  { qid: '2', name: 'old', scope: 'web', createdAt: '2026-05-01T00:00:00Z', lastUsedAt: null, expiresAt: '2026-05-09T00:00:00Z', revokedAt: '2026-05-10T00:00:00Z' },
]
const agents = [{ userQID: '7', email: 'claude@qwirq.com', roleName: 'owner' }, { userQID: '8', email: 'pursuit@qwirq.com', roleName: 'builder' }]

const server = httpServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    reqs.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (url.pathname === '/api/tokens' && req.method === 'POST') return send(200, { token: 'qwirq_pat_MOCKMINTED', qid: '99', for: body?.forEmail || 'me@x.com' })
    if (url.pathname === '/api/tokens' && req.method === 'GET') {
      const who = url.searchParams.get('email') || 'me@x.com'
      return send(200, { tokens, for: who })
    }
    if (url.pathname.startsWith('/api/tokens/') && req.method === 'DELETE') return send(200, { ok: true, qid: url.pathname.split('/').pop() })
    if (url.pathname === '/api/agents' && req.method === 'GET') return send(200, { agents })
    return send(404, { error: 'not_found' })
  })
})

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, QWIRQ_AUTH_URL: BASE, QWIRQ_TOKEN: 'mock' } })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d)); child.stderr.on('data', (d) => (se += d))
    child.on('close', (code) => resolve({ code, stdout: so.trim(), stderr: se.trim() }))
  })
}
const lastReq = (m, pathStarts) => [...reqs].reverse().find((r) => r.method === m && r.path.startsWith(pathStarts))

let BASE
await new Promise((r) => server.listen(0, '127.0.0.1', r))
BASE = `http://127.0.0.1:${server.address().port}`

// token mint: token to stdout, guidance to stderr, body carries flags
let r = await run(['token', 'mint', '--name', 'ci', '--scope', 'web', '--expires', '30'])
check('token mint prints the token to stdout', r.stdout === 'qwirq_pat_MOCKMINTED', JSON.stringify(r.stdout))
check('token mint guidance + "shown once" to stderr', /Minted token #99/.test(r.stderr) && /once/i.test(r.stderr))
let p = lastReq('POST', '/api/tokens')
check('token mint POST body maps name/scope/ttlDays', p.body.name === 'ci' && p.body.scope === 'web' && p.body.ttlDays === 30, JSON.stringify(p.body))

// --no-expiry => ttlDays null; default => ttlDays absent
await run(['token', 'mint', '--no-expiry'])
check('--no-expiry maps ttlDays:null', lastReq('POST', '/api/tokens').body.ttlDays === null)
await run(['token', 'mint'])
check('default mint omits ttlDays (server default)', !('ttlDays' in lastReq('POST', '/api/tokens').body))

// token ls
r = await run(['token', 'ls'])
check('token ls shows active + revoked rows', /laptop/.test(r.stdout) && /REVOKED/.test(r.stdout) && /no expiry/.test(r.stdout), r.stdout)
check('token ls never prints a token value', !r.stdout.includes('qwirq_pat_'))

// token revoke (confirm via --yes), DELETE the right path
r = await run(['token', 'revoke', '1', '--yes'])
check('token revoke hits DELETE /api/tokens/1', !!lastReq('DELETE', '/api/tokens/1') && /Revoked token #1/.test(r.stdout), r.stdout)
// revoke without --yes in a non-TTY refuses (no DELETE sent)
const before = reqs.filter((x) => x.method === 'DELETE').length
r = await run(['token', 'revoke', '5'])
check('token revoke without --yes refuses non-interactively', r.code === 1 && reqs.filter((x) => x.method === 'DELETE').length === before)

// agent ls
r = await run(['agent', 'ls'])
check('agent ls lists agent principals', r.stdout.includes('claude@qwirq.com') && r.stdout.includes('pursuit@qwirq.com'), r.stdout)

// agent token <email> --scope web => POST with forEmail
r = await run(['agent', 'token', 'claude@qwirq.com', '--scope', 'web', '--name', 'web-session'])
check('agent token prints the token', r.stdout === 'qwirq_pat_MOCKMINTED')
p = lastReq('POST', '/api/tokens')
check('agent token POST carries forEmail + scope', p.body.forEmail === 'claude@qwirq.com' && p.body.scope === 'web' && p.body.name === 'web-session', JSON.stringify(p.body))
check('agent token stderr names the agent', /agent claude@qwirq.com/.test(r.stderr))

// agent tokens <email> => GET ?email=
r = await run(['agent', 'tokens', 'claude@qwirq.com'])
p = lastReq('GET', '/api/tokens')
check('agent tokens GET ?email=<agent>', p.query.email === 'claude@qwirq.com' && r.stdout.includes('laptop'))

// agent revoke <email> <qid> => DELETE ?email=
r = await run(['agent', 'revoke', 'claude@qwirq.com', '2', '--yes'])
p = lastReq('DELETE', '/api/tokens/2')
check('agent revoke DELETE /api/tokens/2 ?email=<agent>', !!p && p.query.email === 'claude@qwirq.com' && /Revoked agent claude@qwirq.com/.test(r.stdout), r.stdout)

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
