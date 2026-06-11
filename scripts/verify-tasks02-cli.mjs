// #124 tasks/cmdb 0.2 CLI verbs — offline, against an in-memory mock of the api /api/v1/data/{tasks,cmdb}
// op-dispatch routes. Drives the REAL binary so flag parsing → policy / link-type structures → request
// shape (op + body) and output are exercised. The 0.2 lib behavior (updateType safety contract, link
// constraints) is covered by @qwirq/tasks 0.2.1's own dev acceptance; this proves the CLI half.
import { spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'

const reqs = []
// canned state the mock echoes for type-get (so `update` can fetch+merge an existing policy).
const existingWorkType = {
  name: 'task', prefix: 'T',
  policy: { initialState: 'todo', states: ['todo', 'doing', 'done'], transitions: { todo: ['doing'], doing: ['done'] }, allowedParentTypes: null, requiredFields: [], hasExtension: false },
}
const existingCiType = { name: 'build', prefix: 'BLD', attributeSchema: { repo: 'string' } }

const server = httpServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const lib = req.url.endsWith('/cmdb') ? 'cmdb' : 'tasks'
    reqs.push({ lib, op: body.op, body })
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    switch (body.op) {
      case 'type-get': return send(lib === 'cmdb' ? { type: existingCiType } : { type: existingWorkType })
      case 'type-define': return send({ type: { name: body.name, prefix: body.prefix, policy: body.policy, attributeSchema: body.attributeSchema } })
      case 'type-update': return send({ type: { name: body.name, prefix: body.prefix ?? (lib === 'cmdb' ? existingCiType.prefix : existingWorkType.prefix) } })
      case 'link-type-define': return send({ linkType: body.linkType })
      case 'link-type-ls': return send({ linkTypes: [{ name: 'blocks', fromTypes: ['task'], toTypes: null, fromStates: null, maxFrom: null, maxTo: 1, createdAt: '2026-06-11' }] })
      case 'link-type-get': return send({ linkType: { name: 'blocks', fromTypes: ['task'], toTypes: null, fromStates: ['todo', 'doing'], maxFrom: null, maxTo: 1, createdAt: '2026-06-11' } })
      case 'link-type-rm': return send({ ok: true })
      case 'transition': return send({ item: { shortId: 'T-1', state: body.toState } })
      case 'get': return send({ item: { shortId: 'T-1', title: 't', type: 'task', state: 'doing' } })
      case 'links': return send({ links: { outgoing: [], incoming: [] } })
      case 'cis': return send({ cis: [] })
      case 'events': return send({ events: [{ at: '2026-06-11T00:00:00Z', kind: 'transition', fromState: 'todo', toState: 'doing', actor: 'me@x.com', note: 'spec ready' }] })
      default: return send({ ok: true })
    }
  })
})

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/qwirq.mjs', ...args], { env: { ...process.env, QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock' } })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d)); child.stderr.on('data', (d) => (se += d))
    child.on('close', (code) => resolve({ code, stdout: so.trim(), stderr: se.trim() }))
  })
}
const lastOp = (op) => [...reqs].reverse().find((r) => r.op === op)

let BASE
await new Promise((r) => server.listen(0, '127.0.0.1', r))
BASE = `http://127.0.0.1:${server.address().port}`

// --- work-type define with 0.2 keys ---
let r = await run(['work-type', 'define', 'task', '--prefix', 'T', '--states', 'todo,doing,done', '--transitions', 'todo>doing,doing>done',
  '--require-parent', '--transition-rule', 'todo>doing:assignee,note', '--transition-rule', 'doing>done:fields(points|est)',
  '--field-type', 'points:numeric-enum(1|2|3|5|8)', '--field-type', 'status:enum(open|closed)'])
let p = lastOp('type-define')
check('define sends policy.states', JSON.stringify(p.body.policy.states) === JSON.stringify(['todo', 'doing', 'done']), JSON.stringify(p.body.policy))
check('define parses transitions to a from→[to] map', JSON.stringify(p.body.policy.transitions) === JSON.stringify({ todo: ['doing'], doing: ['done'] }))
check('define sets requireParent', p.body.policy.requireParent === true)
check('define builds transitionRules (booleans)', JSON.stringify(p.body.policy.transitionRules['todo>doing']) === JSON.stringify({ requireAssignee: true, requireNote: true }), JSON.stringify(p.body.policy.transitionRules))
check('define builds transitionRules (fields list)', JSON.stringify(p.body.policy.transitionRules['doing>done']) === JSON.stringify({ requireFields: ['points', 'est'] }))
check('define builds fieldTypes (numeric-enum)', JSON.stringify(p.body.policy.fieldTypes.points) === JSON.stringify({ kind: 'numeric-enum', values: [1, 2, 3, 5, 8] }))
check('define builds fieldTypes (enum)', JSON.stringify(p.body.policy.fieldTypes.status) === JSON.stringify({ kind: 'enum', values: ['open', 'closed'] }))
check('define output ok', /defined work-item type task/.test(r.stdout), r.stdout || r.stderr)

// --- work-type update: merges onto the existing policy, overrides only provided keys ---
r = await run(['work-type', 'update', 'task', '--prefix', 'TASK', '--transition-rule', 'doing>done:note'])
p = lastOp('type-update')
check('update sends type-update with prefix', p.body.op === 'type-update' && p.body.prefix === 'TASK')
check('update preserves existing states (merge, not replace)', JSON.stringify(p.body.policy.states) === JSON.stringify(['todo', 'doing', 'done']), JSON.stringify(p.body.policy?.states))
check('update merges the new transition rule onto existing policy', p.body.policy.transitionRules['doing>done'].requireNote === true)
check('update output ok', /updated work-item type/.test(r.stdout), r.stdout || r.stderr)
// prefix-only update sends no policy
r = await run(['work-type', 'update', 'task', '--prefix', 'X'])
p = lastOp('type-update')
check('prefix-only update sends no policy', p.body.policy === undefined && p.body.prefix === 'X')
// no-op update refuses
r = await run(['work-type', 'update', 'task'])
check('empty update refuses', r.code === 1 && /nothing to change/.test(r.stderr))

// --- link-type ---
r = await run(['link-type', 'define', 'blocks', '--from-types', 'task,bug', '--max-to', '1'])
p = lastOp('link-type-define')
check('link-type define sends the LinkType object', p.body.linkType.name === 'blocks' && JSON.stringify(p.body.linkType.fromTypes) === JSON.stringify(['task', 'bug']) && p.body.linkType.maxTo === 1 && p.body.linkType.toTypes === null, JSON.stringify(p.body.linkType))
check('link-type define output', /registered link type "blocks"/.test(r.stdout), r.stdout || r.stderr)
r = await run(['link-type', 'ls'])
check('link-type ls renders constraints', r.stdout.includes('blocks') && r.stdout.includes('maxTo:1') && r.stdout.includes('to:any'), r.stdout)
r = await run(['link-type', 'show', 'blocks'])
check('link-type show renders any/unlimited', r.stdout.includes('to types:    any') && r.stdout.includes('max from:    unlimited') && r.stdout.includes('from states: todo, doing'), r.stdout)
r = await run(['link-type', 'rm', 'blocks'])
check('link-type rm', !!lastOp('link-type-rm') && /removed link type "blocks"/.test(r.stdout))

// --- transition --note flows through + work show renders the note ---
r = await run(['work', 'transition', 'T-1', 'doing', '--note', 'started it'])
p = lastOp('transition')
check('transition passes the note to the api', p.body.op === 'transition' && p.body.toState === 'doing' && p.body.note === 'started it', JSON.stringify(p.body))
r = await run(['work', 'show', 'T-1'])
check('work show renders the transition note in events', r.stdout.includes('— "spec ready"'), r.stdout)

// --- ci-type update (cmdb 0.2.0) merges attribute schema ---
r = await run(['ci-type', 'update', 'build', '--attr', 'url=string'])
p = lastOp('type-update')
check('ci-type update merges attribute schema onto existing', p.lib === 'cmdb' && JSON.stringify(p.body.attributeSchema) === JSON.stringify({ repo: 'string', url: 'string' }), JSON.stringify(p.body.attributeSchema))
check('ci-type update output', /updated CI type/.test(r.stdout))

// --- bad input is rejected client-side with a clear message ---
r = await run(['work-type', 'define', 'x', '--prefix', 'X', '--states', 'a', '--field-type', 'points:bogus'])
check('a bad field-type kind is refused with a message', r.code === 1 && /unknown field-type kind "bogus"/.test(r.stderr), r.stderr)

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
