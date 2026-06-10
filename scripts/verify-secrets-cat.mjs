// #87 secret-categories CLI verification — offline, against an in-memory mock of the api category +
// secret endpoints. Drives the REAL binary so arg parsing, request shape (method/path/body), and the
// grouped-ls / show / cat output formatting are all exercised. No auth or DB needed (the mock ignores
// the bearer token). The api routes themselves are typechecked + run against dev separately.
import { spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'

// --- in-memory state the mock mutates, so the flow is realistic ---
let categories = [] // { name, description }
const secrets = [
  { name: 'api_key', label: null, key: null, description: 'prod api key', scope: 'user', owner: null, category: null },
  { name: 'db_url', label: null, key: null, description: null, scope: 'user', owner: null, category: null },
]
const reqs = [] // recorded {method, path, body}
const findCat = (n) => categories.find((c) => c.name.toLowerCase() === String(n).toLowerCase())
const countIn = (n) => secrets.filter((s) => (s.category || '').toLowerCase() === n.toLowerCase()).length
const catView = () => categories.map((c) => ({ qid: c.name, name: c.name, description: c.description ?? null, secretCount: countIn(c.name), createdAt: '2026-06-10' })).sort((a, b) => a.name.localeCompare(b.name))

const server = httpServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    reqs.push({ method: req.method, path, body })
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    // categories collection
    if (path === '/api/v1/secrets/categories' && req.method === 'GET') return send(200, { categories: catView() })
    if (path === '/api/v1/secrets/categories' && req.method === 'POST') {
      if (findCat(body.name)) return send(400, { message: `a category named ${body.name} already exists` })
      categories.push({ name: body.name, description: body.description ?? null })
      return send(200, { qid: body.name, name: body.name })
    }
    // categories item
    const m = path.match(/^\/api\/v1\/secrets\/categories\/(.+)$/)
    if (m) {
      const target = decodeURIComponent(m[1])
      const cat = findCat(target)
      if (!cat) return send(400, { message: `category not found: ${target}` })
      if (req.method === 'PATCH') { const old = cat.name; cat.name = body.newName; secrets.forEach((s) => { if ((s.category || '').toLowerCase() === old.toLowerCase()) s.category = body.newName }); return send(200, { ok: true, name: body.newName }) }
      if (req.method === 'DELETE') { const n = countIn(cat.name); secrets.forEach((s) => { if ((s.category || '').toLowerCase() === cat.name.toLowerCase()) s.category = null }); categories = categories.filter((c) => c !== cat); return send(200, { ok: true, name: target, unfiled: n }) }
    }
    // secrets list
    if (path === '/api/v1/secrets' && req.method === 'GET') return send(200, { secrets })
    // secret item (show / set)
    const sm = path.match(/^\/api\/v1\/secrets\/([^/]+)$/)
    if (sm) {
      const sname = decodeURIComponent(sm[1])
      const s = secrets.find((x) => x.name === sname)
      if (req.method === 'GET') return s ? send(200, { secret: s }) : send(404, { error: 'not_found' })
      if (req.method === 'PUT') {
        if (!s) return send(404, { error: 'not_found' })
        if (body.category !== undefined) s.category = body.category === '' || body.category === null ? null : body.category
        if (body.description !== undefined) s.description = body.description
        return send(200, { ok: true, name: sname })
      }
    }
    return send(404, { error: 'not_found' })
  })
})

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
function check(label, cond, detail = '') { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock' } })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d)); child.stderr.on('data', (d) => (se += d))
    child.on('close', (code) => resolve({ code, stdout: so.trim(), stderr: se.trim() }))
  })
}

let BASE
await new Promise((r) => server.listen(0, '127.0.0.1', r))
BASE = `http://127.0.0.1:${server.address().port}`

// 1. empty cat ls
check('cat ls empty', (await run(['secret', 'cat', 'ls'])).stdout.includes('no categories'))
// 2. create category (assert POST body)
let r = await run(['secret', 'cat', 'new', 'work', '--desc', 'work creds'])
check('cat new creates', /Created category "work"/.test(r.stdout), r.stdout || r.stderr)
const post = reqs.find((x) => x.method === 'POST' && x.path === '/api/v1/secrets/categories')
check('cat new POST body', post && post.body.name === 'work' && post.body.description === 'work creds', JSON.stringify(post?.body))
// 3. duplicate -> surfaced error, exit 1
r = await run(['secret', 'cat', 'new', 'work'])
check('cat new duplicate errors (exit 1)', r.code === 1 && /already exists/.test(r.stderr), `code=${r.code} ${r.stderr}`)
// 4. cat ls shows it with 0 count
check('cat ls lists work (0 secrets)', /work\s+\(0 secrets\)\s+— work creds/.test((await run(['secret', 'cat', 'ls'])).stdout))
// 5. set --cat to a missing category: pre-check refuses + lists existing, no PUT sent
const before = reqs.filter((x) => x.method === 'PUT').length
r = await run(['secret', 'set', 'api_key', '--cat', 'nope'])
check('set --cat missing refuses (exit 1) + lists existing', r.code === 1 && /no category "nope"/.test(r.stderr) && /work/.test(r.stderr), r.stderr)
check('set --cat missing sends NO PUT', reqs.filter((x) => x.method === 'PUT').length === before)
// 6. set --cat work (assert PUT body carries category)
r = await run(['secret', 'set', 'api_key', '--cat', 'work'])
check('set --cat files it', /Set api_key \(category=work\)/.test(r.stdout), r.stdout || r.stderr)
const put = reqs.filter((x) => x.method === 'PUT').pop()
check('set --cat PUT body', put && put.body.category === 'work', JSON.stringify(put?.body))
// 7. count reflects it
check('cat ls count is 1', /work\s+\(1 secret\)/.test((await run(['secret', 'cat', 'ls'])).stdout))
// 8. grouped ls: work header before Uncategorized, members indented
r = await run(['secret', 'ls'])
check('ls groups under # work', /# work/.test(r.stdout) && /# Uncategorized/.test(r.stdout), r.stdout)
check('ls order: work before Uncategorized', r.stdout.indexOf('# work') < r.stdout.indexOf('# Uncategorized'))
check('ls indents api_key under work', /# work\n\s+api_key/.test(r.stdout), JSON.stringify(r.stdout))
// 9. --cat filter
r = await run(['secret', 'ls', '--cat', 'work'])
check('ls --cat work shows only api_key', r.stdout.includes('api_key') && !r.stdout.includes('db_url'), r.stdout)
r = await run(['secret', 'ls', '--cat', 'uncategorized'])
check('ls --cat uncategorized shows only db_url', r.stdout.includes('db_url') && !r.stdout.includes('api_key'))
// 10. show includes category
check('show prints category line', /category:\s+work/.test((await run(['secret', 'show', 'api_key'])).stdout))
// 11. rename (assert PATCH body), filed secret follows
r = await run(['secret', 'cat', 'rename', 'work', 'ops'])
check('cat rename', /Renamed category "work" → "ops"/.test(r.stdout), r.stdout || r.stderr)
const patch = reqs.filter((x) => x.method === 'PATCH').pop()
check('cat rename PATCH body', patch && patch.body.newName === 'ops', JSON.stringify(patch?.body))
// 12. rm reports the un-filed count (api_key was filed under ops)
r = await run(['secret', 'cat', 'rm', 'ops'])
check('cat rm reports unfiled', /Deleted category "ops"\. 1 secret became Uncategorized/.test(r.stdout), r.stdout || r.stderr)
// 13. after rm, ls is flat again (no named categories) and api_key is uncategorized
r = await run(['secret', 'ls'])
check('ls flat after all categories gone', !/# Uncategorized/.test(r.stdout) && r.stdout.includes('api_key'), r.stdout)
// 14. clear with --cat "" sends category:'' (was already uncategorized; assert the wire value)
r = await run(['secret', 'set', 'db_url', '--cat', ''])
const clr = reqs.filter((x) => x.method === 'PUT').pop()
check('set --cat "" clears (uncategorized)', /Set db_url \(uncategorized\)/.test(r.stdout) && clr.body.category === '', r.stdout + ' ' + JSON.stringify(clr?.body))

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
