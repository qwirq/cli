// `qwirq signing …` (NATHAN-GATES gap C-1) — offline, against an in-memory mock of the human /api/v1 signing
// identity routes (API m2/releases: GET/POST /projects/:slug/signing-identities, POST
// /signing-identities/:qid/{approve,pin,unpin}). Drives the REAL binary: arg parsing, request shape
// (method/path/body), name → identity resolution, words, --json, error words and exit codes (0 / 2).
// Nothing but vault entry names (by prefix) and public certificate digests may leave the CLI.
//   node scripts/verify-signing-cli.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AT = '2026-10-17T14:41:00.000Z'
const CERT = 'ab'.repeat(32)
const CERT_COLONS = CERT.toUpperCase().match(/../g).join(':')

const reqs = []
let route = () => [404, { error: 'not_found', code: 'not_found', message: 'not found' }]
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const r = { method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization }
    reqs.push(r)
    const [code, body] = route(r)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-c1-'))
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qwirq.mjs')
const ENV = { QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock', QWIRQ_HOME: HOME }

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++ }
const envelope = (status, code, message, extra = {}) => [status, { error: code, code, message, requestId: 'req-1', ...extra }]
const allOutput = []

function run(args, { env } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: HOME, env: { ...process.env, ...ENV, ...env } })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d))
    child.stderr.on('data', (d) => (se += d))
    child.stdin.end('')
    const guard = setTimeout(() => { se += ' [verify: killed after 30 s]'; child.kill() }, 30_000)
    child.on('close', (code) => { clearTimeout(guard); allOutput.push(so, se); done({ code, stdout: so.trim(), stderr: se.trim() }) })
  })
}
const since = (n) => reqs.slice(n)
const mutations = (list) => list.filter((x) => x.method !== 'GET')

const identity = (extra = {}) => ({
  qid: '5', repositoryQID: '42', applicationId: 'com.chalktally.app', name: 'chalktally-upload', status: 'active', revision: 3,
  certificate: { importedSha256: CERT, approvedSha256: CERT, approvedByUserQID: '7', approvedAt: AT, state: 'approved' },
  channels: [{ channel: 'internal', certSha256: CERT, pinned: true }, { channel: 'production', certSha256: null, pinned: false }],
  machineQIDs: ['11'], createdAt: AT, ...extra,
})
const LIST = '/api/v1/projects/sample/signing-identities'
const list = (ids) => [200, { identities: ids, updatedAt: AT }]

// ============ status ============
{
  route = (r) => (r.method === 'GET' && r.path === LIST ? list([identity()]) : envelope(404, 'not_found', 'nope'))
  let r = await run(['signing', 'status', 'sample'])
  check('status → exit 0, identity line with app, state, revision', r.code === 0 && /chalktally-upload \(identity 5\) · app com\.chalktally\.app · active · certificate approved · revision 3/.test(r.stdout), r.stdout)
  check('status → full certificate digest + approval, channels in words', r.stdout.includes(`certificate ${CERT} (approved ${AT} by user 7)`)
    && /internal: pinned/.test(r.stdout) && /production: unpinned \(signing for it refuses\)/.test(r.stdout) && /signing machines: 11/.test(r.stdout), r.stdout)
  r = await run(['signing', 'status', 'sample', '--json'])
  let j = {}
  try { j = JSON.parse(r.stdout) } catch { /* checked */ }
  check('status --json → the API body verbatim', r.code === 0 && j.identities?.[0]?.qid === '5' && j.updatedAt === AT, r.stdout)
  route = (r) => (r.method === 'GET' && r.path === LIST ? list([]) : envelope(404, 'not_found', 'nope'))
  r = await run(['signing', 'status', 'sample'])
  check('status with none → exit 0 + how to register', r.code === 0 && /No signing identity in sample yet/.test(r.stdout) && /qwirq signing identity create <repo>/.test(r.stdout), r.stdout)
  route = () => envelope(404, 'not_found', 'repository not found')
  r = await run(['signing', 'status', 'nope'])
  check('status of an unknown repo → exit 2 [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr), r.stderr)
  r = await run(['signing', 'status'])
  check('status without <repo> → exit 2 usage, no request', r.code === 2 && /usage: qwirq signing status <repo>/.test(r.stderr), r.stderr)
}

// ============ identity create ============
{
  const pending = identity({ revision: 1, certificate: { importedSha256: CERT, approvedSha256: null, approvedByUserQID: null, approvedAt: null, state: 'pending_approval' }, channels: [], machineQIDs: [] })
  route = (r) => (r.method === 'POST' && r.path === LIST ? [201, { identity: pending, created: true }] : envelope(404, 'not_found', 'nope'))
  let n = reqs.length
  let r = await run(['signing', 'identity', 'create', 'sample', '--name', 'chalktally-upload', '--app', 'com.chalktally.app', '--cert', CERT_COLONS, '--secret-prefix', 'chalktally_android'])
  const post = since(n).find((x) => x.method === 'POST')
  check('create → one POST with name, app id, NORMALIZED digest and the vault prefix only',
    r.code === 0 && mutations(since(n)).length === 1 && post?.path === LIST && post.auth === 'Bearer mock'
      && JSON.stringify(post.body) === JSON.stringify({ name: 'chalktally-upload', applicationId: 'com.chalktally.app', certSha256: CERT, secretPrefix: 'chalktally_android' }), JSON.stringify(post))
  check('create → words + the approve hint', /Registered signing identity chalktally-upload \(identity 5\) for com\.chalktally\.app/.test(r.stdout)
    && /certificate NOT approved yet/.test(r.stdout) && /qwirq signing approve sample chalktally-upload --cert <sha256>/.test(r.stdout), r.stdout)
  route = (r) => (r.method === 'POST' && r.path === LIST ? [200, { identity: pending, created: false }] : envelope(404, 'not_found', 'nope'))
  r = await run(['signing', 'identity', 'create', 'sample', '--name', 'chalktally-upload', '--app', 'com.chalktally.app', '--cert', CERT, '--secret-prefix', 'chalktally_android'])
  check('create replayed (200 created=false) → exit 0, "nothing changed"', r.code === 0 && /already registered with exactly these settings; nothing changed/.test(r.stdout), r.stdout)
  route = (r) => (r.method === 'POST' && r.path === LIST ? envelope(409, 'signing_conflict', 'An identity with this name already exists in the project with a different binding.', { detail: { reason: 'identity_exists' } }) : envelope(404, 'not_found', 'nope'))
  r = await run(['signing', 'identity', 'create', 'sample', '--name', 'chalktally-upload', '--app', 'com.chalktally.app', '--cert', CERT, '--secret-prefix', 'chalktally_android', '--json'])
  let e = {}
  try { e = JSON.parse(r.stderr) } catch { /* checked */ }
  check('create conflict --json → exit 2, {code: signing_conflict, reason: identity_exists} on stderr', r.code === 2 && e.code === 'signing_conflict' && e.reason === 'identity_exists' && e.status === 409, r.stderr)
  route = (r) => (r.method === 'POST' && r.path === LIST ? envelope(403, 'publication_forbidden', 'Agent principals cannot change signing settings.', { detail: { reason: 'agent_principal' } }) : envelope(404, 'not_found', 'nope'))
  r = await run(['signing', 'identity', 'create', 'sample', '--name', 'k', '--app', 'com.chalktally.app', '--cert', CERT, '--secret-prefix', 'p'])
  check('create as an agent → exit 2 [publication_forbidden] in words', r.code === 2 && /agent tokens can't change signing settings/.test(r.stderr) && /\[publication_forbidden\]/.test(r.stderr), r.stderr)
  route = (r) => (r.method === 'POST' && r.path === LIST ? envelope(403, 'forbidden', 'Signing settings are changed by a company owner.', { detail: { reason: 'owner_only' } }) : envelope(404, 'not_found', 'nope'))
  r = await run(['signing', 'identity', 'create', 'sample', '--name', 'k', '--app', 'com.chalktally.app', '--cert', CERT, '--secret-prefix', 'p'])
  check('create as a non-owner → exit 2 [forbidden], owner words', r.code === 2 && /only a company owner changes signing settings/.test(r.stderr) && /\[forbidden\]/.test(r.stderr), r.stderr)
  n = reqs.length
  for (const [label, args, re] of [
    ['missing --cert', ['--name', 'k', '--app', 'a.b', '--secret-prefix', 'p'], /--cert <sha256> is required/],
    ['short --cert', ['--name', 'k', '--app', 'a.b', '--secret-prefix', 'p', '--cert', 'abcd'], /--cert must be a SHA-256/],
    ['missing --secret-prefix', ['--name', 'k', '--app', 'a.b', '--cert', CERT], /--secret-prefix <prefix> is required/],
    ['missing --app', ['--name', 'k', '--secret-prefix', 'p', '--cert', CERT], /--app <applicationId> is required/],
    ['missing --name', ['--app', 'a.b', '--secret-prefix', 'p', '--cert', CERT], /--name <name> is required/],
  ]) {
    r = await run(['signing', 'identity', 'create', 'sample', ...args])
    check(`create ${label} → exit 2 usage`, r.code === 2 && re.test(r.stderr), r.stderr)
  }
  check('usage errors sent no request', since(n).length === 0, JSON.stringify(since(n)))
}

// ============ approve / pin / unpin (name → identity resolution) ============
{
  const pending = identity({ certificate: { importedSha256: CERT, approvedSha256: null, approvedByUserQID: null, approvedAt: null, state: 'pending_approval' } })
  route = (r) => {
    if (r.method === 'GET' && r.path === LIST) return list([pending, identity({ qid: '6', name: 'other' })])
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/approve') {
      return r.body?.certSha256 === CERT ? [200, { identity: identity({ revision: 4 }) }]
        : envelope(409, 'signing_mismatch', 'The certificate does not match the one the import verified.', { detail: { reason: 'cert_mismatch' } })
    }
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/pin') return [200, { identity: identity({ revision: 5 }) }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/unpin') return [200, { identity: identity({ revision: 6 }) }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/6/pin') return envelope(409, 'signing_conflict', 'The channel is pinned to another signing identity of this project; unpin it there first.', { detail: { reason: 'channel_bound_elsewhere' } })
    return envelope(404, 'not_found', 'nope')
  }
  let n = reqs.length
  let r = await run(['signing', 'approve', 'sample', 'chalktally-upload', '--cert', CERT_COLONS])
  let m = mutations(since(n))
  check('approve by NAME → resolves to identity 5, one POST /approve with the normalized digest', r.code === 0 && m.length === 1
    && m[0].path === '/api/v1/signing-identities/5/approve' && JSON.stringify(m[0].body) === JSON.stringify({ certSha256: CERT })
    && /Certificate approved for chalktally-upload \(revision 4\)/.test(r.stdout), `${r.stdout} ${JSON.stringify(m)}`)
  n = reqs.length
  r = await run(['signing', 'approve', 'sample', '5', '--cert', CERT])
  check('approve by NUMBER → same identity', r.code === 0 && mutations(since(n))[0]?.path === '/api/v1/signing-identities/5/approve', r.stderr)
  r = await run(['signing', 'approve', 'sample', 'chalktally-upload', '--cert', 'cd'.repeat(32)])
  check('approve a different digest → exit 2 [signing_mismatch] + where to compare', r.code === 2 && /\[signing_mismatch\]/.test(r.stderr) && /certificate-sha256 \(vault round trip\)/.test(r.stderr), r.stderr)
  n = reqs.length
  r = await run(['signing', 'approve', 'sample', 'nope', '--cert', CERT])
  check('approve an unknown identity → exit 2 [not_found] listing the identities, no POST', r.code === 2 && /no signing identity "nope" in sample \(identities: chalktally-upload, other\)/.test(r.stderr)
    && /\[not_found\]/.test(r.stderr) && mutations(since(n)).length === 0, r.stderr)
  r = await run(['signing', 'approve', 'sample', 'chalktally-upload'])
  check('approve without --cert → exit 2 usage', r.code === 2 && /--cert <sha256> is required/.test(r.stderr), r.stderr)

  n = reqs.length
  r = await run(['signing', 'pin', 'sample', 'chalktally-upload', 'internal'])
  m = mutations(since(n))
  check('pin → one POST /pin {channel}', r.code === 0 && m.length === 1 && m[0].path === '/api/v1/signing-identities/5/pin' && JSON.stringify(m[0].body) === JSON.stringify({ channel: 'internal' })
    && /internal is pinned to chalktally-upload's approved certificate \(revision 5\)/.test(r.stdout), r.stdout)
  n = reqs.length
  r = await run(['signing', 'unpin', 'sample', 'chalktally-upload', 'internal', '--json'])
  m = mutations(since(n))
  let j = {}
  try { j = JSON.parse(r.stdout) } catch { /* checked */ }
  check('unpin --json → one POST /unpin, the API body on stdout', r.code === 0 && m.length === 1 && m[0].path === '/api/v1/signing-identities/5/unpin' && j.identity?.revision === 6, r.stdout)
  r = await run(['signing', 'unpin', 'sample', 'chalktally-upload', 'production'])
  check('unpin words: releases refuse until pinned again', r.code === 0 && /production is unpinned from chalktally-upload \(revision 6\); signing and publication for it refuse/.test(r.stdout), r.stdout)
  r = await run(['signing', 'pin', 'sample', 'other', 'internal'])
  check('pin a channel live on another identity → exit 2 [signing_conflict] + status hint', r.code === 2 && /\[signing_conflict\]/.test(r.stderr) && /qwirq signing status sample/.test(r.stderr), r.stderr)
  n = reqs.length
  r = await run(['signing', 'pin', 'sample', 'chalktally-upload', 'Prod_1'])
  check('pin a bad channel name → exit 2 usage, no request', r.code === 2 && /is not a channel name/.test(r.stderr) && since(n).length === 0, r.stderr)
  r = await run(['signing', 'pin', 'sample', 'chalktally-upload'])
  check('pin without <channel> → exit 2 usage', r.code === 2 && /<channel> <channel> is required|usage: qwirq signing pin/.test(r.stderr), r.stderr)
  r = await run(['signing', 'frobnicate'])
  check('unknown subcommand → exit 2 with every signing usage line', r.code === 2 && /qwirq signing status <repo>/.test(r.stderr) && /qwirq signing unpin <repo> <identity> <channel>/.test(r.stderr), r.stderr)
}

// ============ grant / revoke / disable / enable ============
{
  const ok = identity({ revision: 7 })
  route = (r) => {
    if (r.method === 'GET' && r.path === LIST) return list([identity(), identity({ qid: '6', name: 'other' })])
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/grant') return [200, { identity: ok, grantQID: '31' }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/revoke') return [200, { identity: ok, revoked: r.body?.machine === 'MCH-3' }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/disable') return [200, { identity: identity({ status: 'disabled', revision: 8 }) }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/5/enable') return [200, { identity: identity({ revision: 9 }) }]
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/6/grant') return envelope(403, 'publication_forbidden', 'Agent principals cannot change signing settings.', { detail: { reason: 'agent_principal' } })
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/6/disable') return envelope(403, 'forbidden', 'Signing settings are changed by a company owner.', { detail: { reason: 'owner_only' } })
    if (r.method === 'POST' && r.path === '/api/v1/signing-identities/6/revoke') return envelope(404, 'not_found', 'machine not found.', { detail: { reason: 'machine' } })
    return envelope(404, 'not_found', 'nope')
  }
  let n = reqs.length
  let r = await run(['signing', 'grant', 'sample', 'chalktally-upload', '--machine', 'MCH-3'])
  let m = mutations(since(n))
  check('grant → one POST /grant {machine}, words with the grant', r.code === 0 && m.length === 1 && m[0].path === '/api/v1/signing-identities/5/grant'
    && JSON.stringify(m[0].body) === JSON.stringify({ machine: 'MCH-3' }) && /MCH-3 may sign with chalktally-upload \(grant 31, revision 7\)/.test(r.stdout), r.stdout)
  n = reqs.length
  r = await run(['signing', 'revoke', 'sample', '5', '--machine', 'MCH-3', '--json'])
  let j = {}
  try { j = JSON.parse(r.stdout) } catch { /* checked */ }
  check('revoke by number --json → one POST /revoke, API body on stdout', r.code === 0 && mutations(since(n))[0]?.path === '/api/v1/signing-identities/5/revoke' && j.revoked === true, r.stdout)
  r = await run(['signing', 'revoke', 'sample', 'chalktally-upload', '--machine', 'MCH-4'])
  check('revoke without a grant → exit 0, "nothing changed"', r.code === 0 && /MCH-4 had no grant on chalktally-upload; nothing changed/.test(r.stdout), r.stdout)
  r = await run(['signing', 'grant', 'sample', 'other', '--machine', 'MCH-3'])
  check('grant as an agent → exit 2 [publication_forbidden] in words', r.code === 2 && /agent tokens can't change signing settings/.test(r.stderr) && /\[publication_forbidden\]/.test(r.stderr), r.stderr)
  r = await run(['signing', 'revoke', 'sample', 'other', '--machine', 'MCH-99', '--json'])
  let e = {}
  try { e = JSON.parse(r.stderr) } catch { /* checked */ }
  check('revoke of an unknown machine --json → exit 2 {code: not_found, status: 404}', r.code === 2 && e.code === 'not_found' && e.status === 404, r.stderr)
  n = reqs.length
  for (const [label, args, re] of [
    ['grant without --machine', ['signing', 'grant', 'sample', 'chalktally-upload'], /--machine <MCH-n> is required/],
    ['grant with a malformed --machine', ['signing', 'grant', 'sample', 'chalktally-upload', '--machine', 'box1'], /--machine must be a machine id like MCH-3/],
    ['revoke without <identity>', ['signing', 'revoke', 'sample'], /usage: qwirq signing revoke <repo> <identity> --machine <MCH-n>/],
    ['disable without <identity>', ['signing', 'disable', 'sample'], /usage: qwirq signing disable <repo> <identity>/],
  ]) {
    r = await run(args)
    check(`${label} → exit 2 usage`, r.code === 2 && re.test(r.stderr), r.stderr)
  }
  check('usage errors sent no request', since(n).length === 0, JSON.stringify(since(n)))
  n = reqs.length
  r = await run(['signing', 'disable', 'sample', 'chalktally-upload'])
  m = mutations(since(n))
  check('disable → one POST /disable {} and words', r.code === 0 && m.length === 1 && m[0].path === '/api/v1/signing-identities/5/disable' && JSON.stringify(m[0].body) === '{}'
    && /chalktally-upload is disabled \(revision 8\): signing with it refuses; pins and grants are kept/.test(r.stdout) && /qwirq signing enable sample chalktally-upload/.test(r.stdout), r.stdout)
  n = reqs.length
  r = await run(['signing', 'enable', 'sample', 'chalktally-upload'])
  check('enable → one POST /enable and words', r.code === 0 && mutations(since(n))[0]?.path === '/api/v1/signing-identities/5/enable' && /chalktally-upload is active again \(revision 9\)/.test(r.stdout), r.stdout)
  r = await run(['signing', 'disable', 'sample', 'other'])
  check('disable as a non-owner → exit 2 [forbidden], owner words', r.code === 2 && /only a company owner changes signing settings/.test(r.stderr), r.stderr)
}

// ============ help + transport ============
{
  let r = await run(['help'])
  check('help lists the signing verbs and their exit codes', /qwirq signing identity create <repo> --name <name> --app <applicationId> --cert <sha256> --secret-prefix <prefix>/.test(r.stdout)
    && /qwirq signing approve <repo> <identity> --cert <sha256>/.test(r.stdout) && /qwirq signing pin <repo> <identity> <channel>/.test(r.stdout)
    && /qwirq signing grant\|revoke <repo> <identity> --machine <MCH-n>/.test(r.stdout) && /qwirq signing disable\|enable <repo> <identity>/.test(r.stdout)
    && /signing: 0 success; 2 usage, auth, permission \(incl\. publication_forbidden/.test(r.stdout), r.stdout.slice(0, 200))
  r = await run(['signing', 'status', 'sample'], { env: { QWIRQ_API_URL: 'http://127.0.0.1:9' } })
  check('unreachable API → exit 2 [unreachable]', r.code === 2 && /\[unreachable\]/.test(r.stderr), r.stderr)
}

check('every request carried the bearer token', reqs.every((x) => x.auth === 'Bearer mock'))
check('no request body ever carried anything but names, app id, prefix, channel and digests',
  reqs.filter((x) => x.body).every((x) => Object.keys(x.body).every((k) => ['name', 'applicationId', 'certSha256', 'secretPrefix', 'channel', 'machine'].includes(k))))

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
