// #148 identity-assertion guard (FRICTION-9) — offline, against an in-memory mock of /api/v1/whoami +
// the tasks dispatch. Drives the REAL binary so `--as <email>` is exercised end to end: it must verify
// the session's identity (whoami) before a mutating verb and REFUSE on a mismatch (exit 1, no write),
// match case-insensitively, and be skipped for local commands. Run: node scripts/verify-identity-guard.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }

const reqs = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    reqs.push({ method: req.method, path: url.pathname })
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (url.pathname === '/api/v1/whoami' && req.method === 'GET') {
      return send(200, { user: { email: 'claude@qwirq.com' }, company: { name: 'QWIRQ', role: 'owner' } })
    }
    if (url.pathname === '/api/v1/data/tasks' && req.method === 'POST') {
      return send(200, { item: { shortId: 'S-1', title: 'X', state: 'open' } })
    }
    return send(404, { error: 'not_found' })
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const run = (args, env = {}) => new Promise((resolve) => {
  const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock', ...env } })
  let so = '', se = ''
  child.stdout.on('data', (d) => (so += d)); child.stderr.on('data', (d) => (se += d))
  child.on('close', (code) => resolve({ code, stdout: so.trim(), stderr: se.trim() }))
})
const tasksPosts = () => reqs.filter((r) => r.method === 'POST' && r.path === '/api/v1/data/tasks').length
const whoamis = () => reqs.filter((r) => r.method === 'GET' && r.path === '/api/v1/whoami').length

// 1. --as MATCHES → the guard passes and the mutating verb runs.
let before = tasksPosts()
let r = await run(['work', 'new', '--type', 'story', '--title', 'X', '--as', 'claude@qwirq.com'])
check('--as matching the session proceeds (the write happens)', r.code === 0 && tasksPosts() === before + 1, `exit=${r.code} stderr=${r.stderr}`)
check('--as match prints the acting-identity confirmation', /acting as claude@qwirq\.com/.test(r.stderr), r.stderr)

// 2. --as MISMATCH → refuse: exit 1, NO write. (Any email != the mocked session identity; a fake one.)
before = tasksPosts()
r = await run(['work', 'new', '--type', 'story', '--title', 'X', '--as', 'someone-else@example.com'])
check('--as mismatch exits non-zero', r.code === 1, `exit=${r.code}`)
check('--as mismatch does NOT perform the write', tasksPosts() === before, `posts delta=${tasksPosts() - before}`)
check('--as mismatch explains the refusal + the actual identity', /Refusing/.test(r.stderr) && /claude@qwirq\.com/.test(r.stderr), r.stderr)

// 3. case-insensitive match.
before = tasksPosts()
r = await run(['work', 'new', '--type', 'story', '--title', 'X', '--as', 'CLAUDE@QWIRQ.COM'])
check('--as matches case-insensitively', r.code === 0 && tasksPosts() === before + 1, `exit=${r.code}`)

// 4. whoami fails (point at a dead port) → guard refuses with a clear message, no write.
before = tasksPosts()
r = await run(['work', 'new', '--type', 'story', '--title', 'X', '--as', 'claude@qwirq.com'], { QWIRQ_API_URL: 'http://127.0.0.1:1' })
check('--as cannot verify identity → refuse (exit 1)', r.code === 1 && /could not verify the active identity/.test(r.stderr), r.stderr)

// 5. skip-list: a local command (validate) with --as does NOT trigger a whoami call.
const dir = mkdtempSync(join(tmpdir(), 'qwirq-148-'))
writeFileSync(join(dir, 'qwirq.yaml'), 'id: demo\nname: Demo\nprovides:\n  app:\n    entry: ui/App.tsx\n')
const whoamiBefore = whoamis()
r = await run(['validate', '--file', join(dir, 'qwirq.yaml'), '--as', 'someone@else.com'])
check('local `validate` with --as is skipped (no whoami call, validates normally)', whoamis() === whoamiBefore && /is valid/.test(r.stdout), `whoami delta=${whoamis() - whoamiBefore} out=${r.stdout || r.stderr}`)

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
