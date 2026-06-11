// #129 agent lifecycle CLI verbs — offline, against an in-memory mock of the auth agent endpoints.
// Drives the REAL binary so `agent new` / `agent suspend` request shapes + output are exercised. The
// auth lib (createAgent/suspendAgent) is proven against the dev DB (apps/auth/scripts/verify-agents.ts).
import { spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'

const reqs = []
const server = httpServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    reqs.push({ method: req.method, path: url.pathname, body })
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (url.pathname === '/api/agents' && req.method === 'POST') return send(200, { agent: { userQID: '9', email: body?.email, roleName: body?.role || 'builder' } })
    const sm = url.pathname.match(/^\/api\/agents\/([^/]+)\/suspend$/)
    if (sm && req.method === 'POST') return send(200, { ok: true, email: decodeURIComponent(sm[1]), revoked: 3 })
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
const last = (m, pathStarts) => [...reqs].reverse().find((r) => r.method === m && r.path.startsWith(pathStarts))

let BASE
await new Promise((r) => server.listen(0, '127.0.0.1', r))
BASE = `http://127.0.0.1:${server.address().port}`

// agent new
let r = await run(['agent', 'new', 'claude2@qwirq.com', '--role', 'builder'])
let p = last('POST', '/api/agents')
check('agent new POSTs /api/agents with email+role', p && p.body.email === 'claude2@qwirq.com' && p.body.role === 'builder' && p.path === '/api/agents', JSON.stringify(p?.body))
check('agent new output names the agent + next step', /Created agent claude2@qwirq.com \(builder\)/.test(r.stdout) && /agent token claude2@qwirq.com/.test(r.stdout), r.stdout || r.stderr)
// new without email refuses
r = await run(['agent', 'new'])
check('agent new without email refuses', r.code === 1 && /usage: qwirq agent new/.test(r.stderr))

// agent suspend (confirm via --yes)
r = await run(['agent', 'suspend', 'claude2@qwirq.com', '--yes'])
p = last('POST', '/api/agents/claude2')
check('agent suspend POSTs /api/agents/<email>/suspend', !!p && p.path === '/api/agents/claude2%40qwirq.com/suspend', p?.path)
check('agent suspend reports the revoked count', /Suspended agent claude2@qwirq.com\. Revoked 3 tokens/.test(r.stdout), r.stdout || r.stderr)
// suspend without --yes refuses non-interactively (no POST)
const before = reqs.filter((x) => x.method === 'POST' && /\/suspend$/.test(x.path)).length
r = await run(['agent', 'suspend', 'other@qwirq.com'])
check('agent suspend without --yes refuses non-interactively (no POST)', r.code === 1 && reqs.filter((x) => x.method === 'POST' && /\/suspend$/.test(x.path)).length === before)

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
