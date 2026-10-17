// M2 WP12 build/release/channel CLI verbs — offline, against an in-memory mock of the human /api/v1 build,
// channel and release routes (WP12 API contract, M12-SPEC §7). Drives the REAL binary so arg parsing, request
// shape (method/path/query/body), output and exit codes (0/1/2/130) are exercised: fresh request UUIDs, the
// expected snapshot passed through untouched, notes from a file or stdin, async publish (202 → polling →
// published), replay, stale_channel (one POST, never retried), publication_forbidden, release again's forward
// roll-back via /recover with the preview's baseline, Ctrl+C leaving publication alone, and no signed URL in
// any output. Ctrl+C on the real binary needs POSIX signals; on Windows the same handler is driven in-process.
//   node scripts/verify-release-cli.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const AT = '2026-10-16T14:41:00.000Z'
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SIGNED = 'https://files.example.test/blob/700?g=SIGNEDGRANT'

// --- mock api: each test installs `route(req) -> [status, body]` ---
const reqs = []
let route = () => [404, { error: 'not_found', code: 'not_found', message: 'not found' }]
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization }
    reqs.push(r)
    const [code, body] = route(r)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-wp12-'))
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qwirq.mjs')
const ENV = { QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock', QWIRQ_HOME: HOME, QWIRQ_POLL_MS: '20', QWIRQ_RECONNECT_MS: '5000' }

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++ }
const envelope = (status, code, message, extra = {}) => [status, { error: code, code, message, requestId: 'req-1', ...extra }]
const ndjson = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l))
const allOutput = [] // every stdout/stderr the binary printed: none may carry a signed URL

function run(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: HOME, env: { ...process.env, ...ENV, ...env } })
    let so = '', se = ''
    child.stdout.on('data', (d) => (so += d))
    child.stderr.on('data', (d) => (se += d))
    child.stdin.end(input ?? '')
    const guard = setTimeout(() => { se += ' [verify: killed after 30 s]'; child.kill() }, 30_000) // a hung verb fails, never hangs the suite
    child.on('close', (code) => { clearTimeout(guard); allOutput.push(so, se); resolve({ code, stdout: so.trim(), stderr: se.trim() }) })
  })
}
const since = (n) => reqs.slice(n)
const mutations = (list) => list.filter((x) => x.method !== 'GET')

// --- fixtures ---
const entry = (extra = {}) => ({
  role: 'native', slot: 'apk', buildQID: '501', artifactQID: '700', sha256: 'd'.repeat(64), sizeBytes: 12_345_678, storageGeneration: 1,
  commitSha: SHA_A, applicationId: 'com.chalktally.app', versionName: '0.5.2', versionCode: 222, runtimeVersion: '0.5', runtimeSource: 'fingerprint',
  signingCertSha256: 'c'.repeat(64), imageName: null, carriedFromReleaseQID: null, ...extra,
})
const release = (qid, seq, extra = {}) => ({
  qid, repositoryQID: '42', channelQID: '77', publicationSeq: seq, operation: 'publish', notesMd: 'Fixes the sync bug', actor: { kind: 'user', qid: '7' },
  publishedAt: AT, previousReleaseQID: null, sourceReleaseQID: null, recoveryQID: null, requestQID: '950', setSha256: 'e'.repeat(64), entries: [entry()], current: true, ...extra,
})
const build = (extra = {}) => ({
  qid: '501', requestID: 'x', repositoryQID: '42', kind: 'normal', target: 'android-apk', name: 'android', commitSha: SHA_A, checkSetQID: '300', jobQID: '31', attempt: 1,
  state: 'queued', applicationId: 'com.chalktally.app', versionCode: 222, versionName: '0.5.2', runtimeVersion: '0.5', runtimeSource: 'fingerprint',
  signingCertSha256: 'c'.repeat(64), primaryArtifactQID: '700', distributionBinding: { channelQID: '77', audienceKeyVersion: 1 }, rollbackOfBuildQID: null,
  retryOfBuildQID: null, requestedBy: { kind: 'user', userQID: '7' }, failureReason: null, createdAt: AT, finishedAt: null, ...extra,
})
const chan = (qid, name, extra = {}) => ({
  qid, repositoryQID: '42', platform: 'android', name, production: false, applicationId: 'com.chalktally.app', audience: 'members', audienceKeyVersion: 1,
  signingIdentityQID: '5', currentReleaseQID: null, publicationSeq: 0, revision: 1, autoPublish: { state: 'off', ref: null, ruleRevision: 1, pausedByUserQID: null, pausedAt: null },
  createdAt: AT, updatedAt: AT, currentRelease: null, permissions: { read: true, publish: true, configure: true, recover: true }, ...extra,
})
const INTERNAL = chan('77', 'internal', { currentReleaseQID: '900', publicationSeq: 3, revision: 4, currentRelease: release('900', 3), autoPublish: { state: 'on', ref: 'refs/heads/main', ruleRevision: 2, pausedByUserQID: null, pausedAt: null } })
const PRODUCTION = chan('78', 'production', { production: true, revision: 2, autoPublish: { state: 'paused', ref: 'refs/heads/main', ruleRevision: 1, pausedByUserQID: '7', pausedAt: AT } })
const CHANNELS = {
  channels: [INTERNAL, PRODUCTION],
  links: { 77: { appPage: 'https://apps.example.test/get/sample/internal', download: 'https://apps.example.test/get/sample/internal/download?g=SIGNEDGRANT' }, 78: { appPage: null, download: null } },
  updatedAt: AT,
}
const request = (state, extra = {}) => ({
  qid: '950', requestID: 'u', repositoryQID: '42', channelQID: '77', operation: 'publish', actor: { kind: 'user', qid: '7' }, state, expectedCurrentReleaseQID: '900',
  expectedChannelRevision: 4, entries: [entry()], setSha256: 'e'.repeat(64), notesMd: '', sourceReleaseQID: null, recoveryQID: null,
  rejection: null, verifiedAt: null, resultReleaseQID: state === 'published' ? '901' : null, createdAt: AT, expiresAt: AT, decidedAt: null, ...extra,
})
const PREVIEW = {
  channel: { qid: '77', currentReleaseQID: '900', revision: 4, production: false }, stale: false, releasable: true, entries: [entry()], setSha256: 'e'.repeat(64),
  effects: [{ type: 'native', changed: true, from: { versionName: '0.5.1', versionCode: 221 }, to: { versionName: '0.5.2', versionCode: 222 } }, { type: 'auto_publish_pauses' }],
  blockers: [],
}
const isChannels = (r) => r.method === 'GET' && r.path === '/api/v1/projects/sample/channels'

/** Channels + a publish that 202s pending, then the request polls `pending` `pendingPolls` times before `final`. */
function publishRoute({ pendingPolls = 2, final = 'published', replayed = false, first = 'pending_verification', rejection = null, path = '/api/v1/channels/77/publish' } = {}) {
  let polls = 0
  return (r) => {
    if (isChannels(r)) return [200, CHANNELS]
    if (r.method === 'POST' && r.path === path) return [202, { request: request(first, first === 'published' ? {} : {}), replayed }]
    if (r.method === 'GET' && r.path === '/api/v1/release-requests/950') {
      polls++
      if (polls <= pendingPolls) return [200, { request: request('pending_verification') }]
      return [200, { request: request(final, final === 'rejected' ? { rejection } : {}) }]
    }
    return envelope(404, 'not_found', 'nope')
  }
}

// ============ build <repo> (request) ============
{
  route = (r) => (r.method === 'POST' && r.path === '/api/v1/pipeline/builds' ? [202, { build: build(), replayed: false }] : envelope(404, 'not_found', 'nope'))
  let n = reqs.length
  let r = await run(['build', 'sample', '--target', 'android-apk', '--sha', SHA_A, '--channel', 'internal'])
  const p = since(n)[0]
  check('build: POST /api/v1/pipeline/builds with the bearer token', p?.method === 'POST' && p.path === '/api/v1/pipeline/builds' && p.auth === 'Bearer mock', JSON.stringify(p))
  check('build: body {requestID(uuid v4), repo, commitSha, target, channel}', UUID4.test(p?.body?.requestID) && p.body.repo === 'sample' && p.body.commitSha === SHA_A && p.body.target === 'android-apk' && p.body.channel === 'internal' && Object.keys(p.body).length === 5, JSON.stringify(p?.body))
  check('build: prints qid, state, version code, next commands; exit 0', r.code === 0 && /^Build 501 queued · android-apk · a1b2c3d · version 0\.5\.2 \(code 222\)$/m.test(r.stdout) && /qwirq build show 501/.test(r.stdout) && /qwirq jobs logs 31 --attempt 1 --follow/.test(r.stdout), `exit=${r.code} ${r.stdout}`)
  n = reqs.length
  r = await run(['build', 'sample', '--target', 'android-apk', '--sha', SHA_A.toUpperCase(), '--json'])
  const p2 = since(n)[0]
  check('build: no --channel → channel null; sha lowercased; a fresh requestID per run', p2.body.channel === null && p2.body.commitSha === SHA_A && UUID4.test(p2.body.requestID) && p2.body.requestID !== p.body.requestID)
  check('build --json prints the response, exit 0', r.code === 0 && JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify({ build: build(), replayed: false }), r.stdout)
  route = () => [202, { build: build(), replayed: true }]
  r = await run(['build', 'sample', '--target', 'android-apk', '--sha', SHA_A])
  check('build: replayed answer said in words', r.code === 0 && /replayed: this request was already accepted/.test(r.stdout), r.stdout)

  n = reqs.length
  r = await run(['build', 'sample', '--target', 'android-apk', '--sha', SHA_A, '--channel', 'Internal'])
  check('build: bad channel name → exit 2 usage, nothing sent', r.code === 2 && since(n).length === 0 && /not a channel name/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  r = await run(['build', 'sample', '--target', 'android-apk', '--sha', 'a1b2c3d'])
  check('build: short sha → exit 2, nothing sent', r.code === 2 && since(n).length === 0 && /40-character/.test(r.stderr))
  r = await run(['build', 'sample', '--sha', SHA_A, '--json'])
  check('build: missing --target → exit 2, JSON {code:usage}', r.code === 2 && JSON.parse(r.stderr).code === 'usage' && since(n).length === 0, r.stderr)
  route = () => envelope(409, 'allocator_not_seeded', 'version codes for com.chalktally.app are not seeded')
  r = await run(['build', 'sample', '--target', 'android-apk', '--sha', SHA_A])
  check('build: 409 allocator_not_seeded → exit 2 with [code] + server words', r.code === 2 && /\[allocator_not_seeded\]/.test(r.stderr) && /not seeded/.test(r.stderr), r.stderr)
}

// ============ build show / retry / builds ls ============
{
  const detail = {
    build: build({ state: 'succeeded', finishedAt: AT }), job: { qid: '31', state: 'succeeded', attempt: 1 },
    artifacts: [{ qid: '700', name: 'app-release.apk', kind: 'apk', sizeBytes: 12_345_678, sha256: 'd'.repeat(64), downloadUrl: SIGNED }],
    checks: { checkSetQID: '300', state: 'failing', blockers: [{ code: 'check_failed', reason: 'required check test failed', slot: null, buildQID: '501' }] },
    releases: [{ channelQID: '77', channelName: 'internal', releaseQID: '900', publicationSeq: 3, current: true }],
  }
  route = (r) => {
    if (r.path === '/api/v1/pipeline/builds/501') return [200, detail]
    if (r.path === '/api/v1/pipeline/builds/501/retry') return [202, { build: build({ qid: '502', versionCode: 223, retryOfBuildQID: '501', jobQID: '32' }), replayed: false }]
    if (r.path === '/api/v1/pipeline/builds') return [200, { builds: [build({ state: 'succeeded' })], nextCursor: '501', verification: { 501: { state: 'passing', blockers: [] } }, releases: { 501: [detail.releases[0]] }, updatedAt: AT }]
    return envelope(404, 'not_found', 'build not found')
  }
  let r = await run(['build', 'show', '501'])
  check('build show: header, commit, version/runtime, cert', /^Build 501 · android · succeeded · attempt 1/.test(r.stdout) && r.stdout.includes(`Commit ${SHA_A} · normal`) && /Version 0\.5\.2 \(code 222\) · com\.chalktally\.app · runtime 0\.5 \(fingerprint\)/.test(r.stdout) && r.stdout.includes('c'.repeat(64)), r.stdout)
  check('build show: checks + blockers in words, artifacts, releases', /Checks: checks failing/.test(r.stdout) && /required check test failed · build 501 \[check_failed\]/.test(r.stdout) && /app-release\.apk · apk · 11\.8 MB/.test(r.stdout) && /internal #3 · release 900 \(current\)/.test(r.stdout), r.stdout)
  check('build show: exit 0, no signed artifact URL printed', r.code === 0 && !r.stdout.includes('g=SIGNED'))
  r = await run(['build', 'show', '501', '--json'])
  const j = JSON.parse(r.stdout)
  check('build show --json: the response, with the signed URL withheld (null)', r.code === 0 && j.build.qid === '501' && j.artifacts[0].downloadUrl === null && j.artifacts[0].sha256 === 'd'.repeat(64), r.stdout.slice(0, 200))

  let n = reqs.length
  r = await run(['build', 'retry', '501'])
  const p = since(n)[0]
  check('build retry: POST /retry {requestID uuid} only', p.method === 'POST' && p.path === '/api/v1/pipeline/builds/501/retry' && UUID4.test(p.body.requestID) && Object.keys(p.body).length === 1, JSON.stringify(p.body))
  check('build retry: prints the new build + version code, exit 0', r.code === 0 && /^Build 502 queued · android-apk · a1b2c3d · version 0\.5\.2 \(code 223\)/.test(r.stdout), r.stdout)
  r = await run(['build', 'retry', '501', '--json'])
  check('build retry --json', r.code === 0 && JSON.parse(r.stdout).build.qid === '502')

  n = reqs.length
  r = await run(['builds', 'ls', 'sample', '--target', 'android-apk'])
  check('builds ls: GET ?repo=&target=, one line per build, next page', since(n)[0].query.repo === 'sample' && since(n)[0].query.target === 'android-apk' && /^501 {2}a1b2c3d {2}android .*succeeded .*version 0\.5\.2 \(code 222\) · checks passing · released: internal\*$/m.test(r.stdout) && /More: qwirq builds ls sample --cursor 501/.test(r.stdout) && r.code === 0, r.stdout)
  r = await run(['builds', 'sample', '--json'])
  check('builds <repo> --json', r.code === 0 && JSON.parse(r.stdout).builds[0].qid === '501')

  r = await run(['build', 'show', '999'])
  check('build show 404 → exit 2 [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr) && /build not found/.test(r.stderr), r.stderr)
  r = await run(['build', 'show', 'abc'])
  check('build show <non-number> → exit 2', r.code === 2 && /expected a build number/.test(r.stderr))
}

// ============ release list / show ============
{
  route = (r) => {
    if (r.path === '/api/v1/projects/sample/releases') return [200, { releases: [release('900', 3), release('880', 2, { current: false, operation: 'publish', entries: [entry({ versionName: '0.5.1', versionCode: 221, buildQID: '480' })] })], nextCursor: null }]
    if (r.path === '/api/v1/releases/900') return [200, { release: release('900', 3, { previousReleaseQID: '880', notesMd: 'Fixes the sync bug\nAnd a crash' }), channel: { qid: '77', name: 'internal', production: false, platform: 'android' } }]
    return envelope(404, 'not_found', 'release not found')
  }
  let n = reqs.length
  let r = await run(['release', 'list', 'sample', '--channel', 'internal'])
  check('release list: GET /projects/sample/releases?channel=internal', since(n)[0].query.channel === 'internal', JSON.stringify(since(n)[0]))
  check('release list: one line per release, current marked, exit 0', /^900 {2}internal #3 · publish · 0\.5\.2 \(code 222\) · build 501 · .*\(current\)$/m.test(r.stdout) && /^880 {2}internal #2 · publish · 0\.5\.1 \(code 221\) · build 480 · /m.test(r.stdout) && !/880.*current/.test(r.stdout) && r.code === 0, r.stdout)
  r = await run(['release', 'ls', 'sample', '--json'])
  check('release ls --json (no channel → no channel query)', r.code === 0 && JSON.parse(r.stdout).releases.length === 2 && reqs[reqs.length - 1].query.channel === undefined)

  r = await run(['release', 'show', '900'])
  const s = r.stdout
  check('release show: header + provenance', /^Release 900 · internal #3 · publish · current/.test(s) && /replaced release 880/.test(s) && s.includes(`Set sha256 ${'e'.repeat(64)}`), s)
  check('release show: every entry\'s build, commit, version, runtime, sha256, size, cert', s.includes(`native apk · build 501 · commit ${SHA_A}`) && /com\.chalktally\.app 0\.5\.2 \(code 222\) · runtime 0\.5 \(fingerprint\)/.test(s) && s.includes(`sha256 ${'d'.repeat(64)} · 11.8 MB · cert sha256 ${'c'.repeat(64)}`), s)
  check('release show: notes shown, exit 0', /Notes:\n {2}Fixes the sync bug\n {2}And a crash/.test(s) && r.code === 0)
  r = await run(['release', 'show', '900', '--json'])
  check('release show --json', r.code === 0 && JSON.parse(r.stdout).release.entries[0].sha256 === 'd'.repeat(64))
  r = await run(['release', 'show', '12'])
  check('release show 404 → exit 2 [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr))
  r = await run(['release', 'list', 'sample', '--channel', 'no_such'])
  check('release list: invalid channel name → exit 2', r.code === 2 && /not a channel name/.test(r.stderr))
}

// ============ release preview ============
{
  route = (r) => (isChannels(r) ? [200, CHANNELS] : r.path === '/api/v1/channels/77/preview' ? [200, PREVIEW] : envelope(404, 'not_found', 'nope'))
  let n = reqs.length
  let r = await run(['release', 'preview', 'sample', '--channel', 'internal', '--build', '501'])
  const s = since(n)
  check('preview: resolves the channel by name (GET channels?platform=android), then POST /channels/77/preview {buildQID}', s.length === 2 && isChannels(s[0]) && s[0].query.platform === 'android' && s[1].method === 'POST' && s[1].path === '/api/v1/channels/77/preview' && JSON.stringify(s[1].body) === '{"buildQID":"501"}', JSON.stringify(s.map((x) => [x.method, x.path, x.body])))
  check('preview: effects in words', /Native app: 0\.5\.1 \(code 221\) → 0\.5\.2 \(code 222\) \(phones install an update\)/.test(r.stdout) && /Auto-publish on this channel pauses/.test(r.stdout), r.stdout)
  check('preview: current snapshot + the exact publish command', /Channel now: release 900 · revision 4/.test(r.stdout) && r.stdout.includes('qwirq release publish sample --channel internal --build 501 --expected-current 900 --expected-revision 4') && r.code === 0, r.stdout)
  r = await run(['release', 'preview', 'sample', '--channel', 'internal', '--build', '501', '--json'])
  check('preview --json is the response', r.code === 0 && JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify(PREVIEW))
  route = (r) => (isChannels(r) ? [200, CHANNELS] : [200, { ...PREVIEW, releasable: false, blockers: [{ code: 'checks_failing', reason: 'required checks are failing', slot: null, buildQID: '501' }] }])
  r = await run(['release', 'preview', 'sample', '--channel', 'internal', '--build', '501'])
  check('preview with blockers: listed, no publish command offered', /Not releasable:\n {2}- required checks are failing · build 501 \[checks_failing\]/.test(r.stdout) && !/release publish/.test(r.stdout) && r.code === 0, r.stdout)
  n = reqs.length
  r = await run(['release', 'preview', 'sample', '--channel', 'beta', '--build', '501'])
  check('preview: unknown channel → exit 2 [not_found], names the channels, no POST', r.code === 2 && /no channel "beta" in sample \(channels: internal, production\)/.test(r.stderr) && /\[not_found\]/.test(r.stderr) && mutations(since(n)).length === 0, r.stderr)
}

// ============ release publish: async 202 → pending → published ============
const NOTES = join(HOME, 'notes.md')
writeFileSync(NOTES, '## 0.5.2\n- Fixes the sync bug\n')
const PUB = ['release', 'publish', 'sample', '--channel', 'internal', '--build', '501', '--expected-current', '900', '--expected-revision', '4']
{
  route = publishRoute()
  let n = reqs.length
  let r = await run([...PUB, '--notes-file', NOTES])
  const s = since(n)
  const post = s.find((x) => x.method === 'POST')
  check('publish: POST /channels/77/publish once', mutations(s).length === 1 && post.path === '/api/v1/channels/77/publish')
  check('publish: body {requestID uuid, buildQID, notesMd(file), expectedCurrentReleaseQID, expectedChannelRevision}', UUID4.test(post.body.requestID) && post.body.buildQID === '501' && post.body.notesMd === '## 0.5.2\n- Fixes the sync bug\n' && post.body.expectedCurrentReleaseQID === '900' && post.body.expectedChannelRevision === 4 && Object.keys(post.body).length === 5, JSON.stringify(post.body))
  check('publish: follows the durable request (GET /release-requests/950 until published)', s.filter((x) => x.path === '/api/v1/release-requests/950').length === 3, String(s.filter((x) => x.path === '/api/v1/release-requests/950').length))
  check('publish: accepted → pending → published, exit 0', r.code === 0 && /Publication request 950 accepted · build 501 → internal/.test(r.stdout) && /pending verification/.test(r.stdout) && /Ctrl\+C stops watching; publication continues/.test(r.stdout) && /Published: release 901 is now current on internal\./.test(r.stdout), `exit=${r.code} ${r.stdout}`)

  route = publishRoute()
  r = await run([...PUB, '--json'])
  const ev = ndjson(r.stdout)
  check('publish --json: NDJSON response objects; first the 202 {request, replayed}, last the published request', r.code === 0 && ev[0].request.state === 'pending_verification' && ev[0].replayed === false && ev[ev.length - 1].request.state === 'published' && ev[ev.length - 1].request.resultReleaseQID === '901', r.stdout)
  check('publish --json: each state change printed once', ev.filter((e) => e.request.state === 'pending_verification').length === 1, String(ev.length))

  route = publishRoute()
  n = reqs.length
  r = await run([...PUB.slice(0, 7), '--expected-current', 'none', '--expected-revision', '0', '--stdin'], { input: 'notes from stdin' })
  const post2 = since(n).find((x) => x.method === 'POST')
  check('publish: --expected-current none → null; --expected-revision 0; notes from --stdin', post2.body.expectedCurrentReleaseQID === null && post2.body.expectedChannelRevision === 0 && post2.body.notesMd === 'notes from stdin' && r.code === 0, JSON.stringify(post2.body))
  check('publish: a fresh requestID per invocation', post2.body.requestID !== post.body.requestID)

  route = publishRoute()
  n = reqs.length
  r = await run(PUB)
  check('publish without notes → notesMd ""', since(n).find((x) => x.method === 'POST').body.notesMd === '' && r.code === 0)

  // replayed: the server already published this request → no polling at all
  route = publishRoute({ first: 'published', replayed: true })
  n = reqs.length
  r = await run(PUB)
  check('publish replayed:true (already published): says so, no polling, exit 0', r.code === 0 && /replayed: this request was already made/.test(r.stdout) && /Published: release 901/.test(r.stdout) && !since(n).some((x) => x.path.startsWith('/api/v1/release-requests/')), r.stdout)
  route = publishRoute({ first: 'published', replayed: true })
  r = await run([...PUB, '--json'])
  check('publish replayed --json: one line {request, replayed:true}', r.code === 0 && ndjson(r.stdout).length === 1 && ndjson(r.stdout)[0].replayed === true)

  route = publishRoute()
  n = reqs.length
  r = await run([...PUB, '--no-wait'])
  check('publish --no-wait: returns after the 202, names how to watch, exit 0', r.code === 0 && /qwirq release wait 950/.test(r.stdout) && !since(n).some((x) => x.path.startsWith('/api/v1/release-requests/')), r.stdout)
  route = publishRoute()
  r = await run([...PUB, '--no-wait', '--json'])
  check('publish --no-wait --json: the 202 response only', r.code === 0 && ndjson(r.stdout).length === 1 && ndjson(r.stdout)[0].request.qid === '950')

  route = publishRoute({ final: 'rejected', rejection: { code: 'artifact_unavailable', message: 'artifact 700 could not be read back', blockers: [{ code: 'artifact_unavailable', reason: 'apk missing from storage', slot: 'apk', buildQID: '501' }] } })
  r = await run(PUB)
  check('publish rejected during verification → exit 1, code + blockers in words', r.code === 1 && /Not published: artifact 700 could not be read back \[artifact_unavailable\]/.test(r.stdout) && /apk missing from storage \(apk\)/.test(r.stdout), `exit=${r.code} ${r.stdout}`)
  route = publishRoute({ final: 'rejected', rejection: { code: 'stale_channel', message: 'channel moved' } })
  r = await run(PUB)
  check('publish rejected stale_channel at verification → exit 1, "re-run preview"', r.code === 1 && /channel moved before verification finished; re-run preview/.test(r.stdout), r.stdout)

  // resume watching a request made earlier
  route = publishRoute({ pendingPolls: 1 })
  r = await run(['release', 'wait', '950'])
  check('release wait <requestQID>: follows to published, exit 0', r.code === 0 && /Publication request 950: pending verification/.test(r.stdout) && /Published: release 901/.test(r.stdout), r.stdout)

  // usage: the snapshot is required, nothing is sent without it
  n = reqs.length
  r = await run(['release', 'publish', 'sample', '--channel', 'internal', '--build', '501', '--expected-current', '900'])
  check('publish without --expected-revision → exit 2, no request', r.code === 2 && /--expected-revision <n> is required/.test(r.stderr) && since(n).length === 0, r.stderr)
  r = await run(['release', 'publish', 'sample', '--channel', 'internal', '--build', '501', '--expected-revision', '4'])
  check('publish without --expected-current → exit 2, no request', r.code === 2 && /--expected-current <releaseQID\|none> is required/.test(r.stderr) && since(n).length === 0)
  r = await run([...PUB.slice(0, 9), '--expected-revision', '-1'])
  check('publish --expected-revision -1 → exit 2', r.code === 2 && since(n).length === 0)
  r = await run([...PUB, '--notes-file', join(HOME, 'missing.md')])
  check('publish --notes-file missing → exit 2, no request', r.code === 2 && /can't read notes file/.test(r.stderr) && since(n).length === 0, r.stderr)
  r = await run([...PUB, '--notes-file', NOTES, '--stdin'])
  check('publish --notes-file with --stdin → exit 2', r.code === 2 && since(n).length === 0)
}

// ============ stale_channel (409): one POST, never retried, says re-run preview ============
{
  route = (r) => (isChannels(r) ? [200, CHANNELS] : envelope(409, 'stale_channel', 'the channel changed since your preview', { detail: { currentReleaseQID: '902', revision: 5 } }))
  let n = reqs.length
  let r = await run(PUB)
  check('stale_channel → exit 2, exactly one POST (no retry, no refresh)', r.code === 2 && mutations(since(n)).length === 1 && !since(n).some((x) => x.path.includes('/preview')), `exit=${r.code} ${JSON.stringify(since(n).map((x) => x.path))}`)
  check('stale_channel: explains the channel moved + re-run preview + [stale_channel]', /the channel moved since your preview \(it now serves release 902 at revision 5\); re-run preview/.test(r.stderr) && /qwirq release preview sample --channel internal --build 501/.test(r.stderr) && /\[stale_channel\]/.test(r.stderr), r.stderr)
  n = reqs.length
  r = await run([...PUB, '--json'])
  const e = JSON.parse(r.stderr)
  check('stale_channel --json: {code:stale_channel, status:409, detail}', r.code === 2 && e.code === 'stale_channel' && e.status === 409 && e.detail.revision === 5 && mutations(since(n)).length === 1, r.stderr)

  route = (r) => (isChannels(r) ? [200, CHANNELS] : envelope(409, 'build_not_releasable', 'build 501 is not releasable', { blockers: [{ code: 'checks_failing', reason: 'required checks are failing', slot: null, buildQID: '501' }] }))
  r = await run(PUB)
  check('409 build_not_releasable: message + blockers, exit 2', r.code === 2 && /build 501 is not releasable \[build_not_releasable\]/.test(r.stderr) && /required checks are failing · build 501 \[checks_failing\]/.test(r.stderr), r.stderr)
  r = await run([...PUB, '--json'])
  check('… --json carries blockers', r.code === 2 && JSON.parse(r.stderr).blockers[0].code === 'checks_failing')
}

// ============ 403 publication_forbidden (agent token) / 401 / scope_denied ============
{
  route = (r) => (isChannels(r) ? [200, CHANNELS] : envelope(403, 'publication_forbidden', 'agent principals cannot publish'))
  let n = reqs.length
  let r = await run(PUB)
  check('403 publication_forbidden: plain words, exit 2, one POST, no wait', r.code === 2 && /agent tokens can't publish, recover, or change channel settings; a person has to run this/.test(r.stderr) && /\[publication_forbidden\]/.test(r.stderr) && mutations(since(n)).length === 1 && !since(n).some((x) => x.path.startsWith('/api/v1/release-requests')), r.stderr)
  r = await run([...PUB, '--json'])
  const e = JSON.parse(r.stderr)
  check('403 publication_forbidden --json: {code, status:403}', r.code === 2 && e.code === 'publication_forbidden' && e.status === 403, r.stderr)
  r = await run(['channel', 'pause', 'sample', 'internal', '--expected-revision', '4'])
  check('channel pause as an agent → 403 publication_forbidden, exit 2', r.code === 2 && /\[publication_forbidden\]/.test(r.stderr))
  route = () => envelope(403, 'scope_denied', 'token scope pipeline:rw cannot reach releases routes')
  r = await run(['channel', 'list', 'sample'])
  check('403 scope_denied → exit 2 with the server words', r.code === 2 && /\[scope_denied\]/.test(r.stderr) && /releases routes/.test(r.stderr), r.stderr)
  route = () => envelope(401, 'unauthorized', 'missing token')
  r = await run(['release', 'list', 'sample'])
  check('401 → exit 2 + login hint', r.code === 2 && /qwirq login/.test(r.stderr) && /\[unauthorized\]/.test(r.stderr))
  route = () => envelope(404, 'not_found', 'repository not found')
  r = await run(['channel', 'list', 'nope'])
  check('404 → exit 2 [not_found]', r.code === 2 && /repository not found/.test(r.stderr) && /\[not_found\]/.test(r.stderr))
}

// ============ release promote ============
{
  let toProduction = publishRoute({ path: '/api/v1/channels/78/publish' })
  route = (r) => {
    if (isChannels(r)) return [200, CHANNELS]
    if (r.path === '/api/v1/channels/78/preview') return [200, { ...PREVIEW, channel: { qid: '78', currentReleaseQID: null, revision: 2, production: true }, effects: [{ type: 'production_audience' }] }]
    return toProduction(r)
  }
  let n = reqs.length
  let r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production'])
  let s = since(n)
  check('promote without the snapshot: previews the --from current release on --to', s.some((x) => x.path === '/api/v1/channels/78/preview' && JSON.stringify(x.body) === '{"sourceReleaseQID":"900"}'), JSON.stringify(s.map((x) => [x.path, x.body])))
  check('promote without the snapshot: refuses to publish (no publish POST), exit 2', r.code === 2 && !s.some((x) => x.path.endsWith('/publish')) && /\[expected_snapshot_required\]/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  check('promote preview: effects + the exact promote command', /Production: everyone with access/.test(r.stdout) && r.stdout.includes('qwirq release promote sample --from internal --to production --source 900 --expected-current none --expected-revision 2'), r.stdout)
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--expected-revision', '2'])
  check('promote with only one expected flag: still refuses', r.code === 2 && /expected_snapshot_required/.test(r.stderr))
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--json'])
  check('promote refusal --json: preview on stdout, {code:expected_snapshot_required} on stderr', r.code === 2 && JSON.parse(r.stdout).channel.qid === '78' && JSON.parse(r.stderr).code === 'expected_snapshot_required')

  toProduction = publishRoute({ path: '/api/v1/channels/78/publish' })
  n = reqs.length
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--expected-current', 'none', '--expected-revision', '2', '--notes-file', NOTES])
  check('promote with the destination snapshot but no --source: refuses (exit 2, no publish)', r.code === 2 && !since(n).some((x) => x.path.endsWith('/publish')) && /expected_snapshot_required/.test(r.stderr), r.stderr)
  n = reqs.length
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--source', '900', '--expected-current', 'none', '--expected-revision', '2', '--notes-file', NOTES])
  s = since(n)
  const post = s.find((x) => x.method === 'POST')
  check('promote with the snapshot: POST /channels/78/publish {sourceReleaseQID: from\'s current}', mutations(s).length === 1 && post.path === '/api/v1/channels/78/publish' && post.body.sourceReleaseQID === '900' && post.body.buildQID === undefined && post.body.expectedCurrentReleaseQID === null && post.body.expectedChannelRevision === 2 && UUID4.test(post.body.requestID) && post.body.notesMd.startsWith('## 0.5.2'), JSON.stringify(post?.body))
  check('promote: waits to published, exit 0', r.code === 0 && /release 900 from internal → production/.test(r.stdout) && /Published: release 901 is now current on production/.test(r.stdout), r.stdout)

  // Codex r4: the preview showed release 900; Internal then moved to 901. The confirmation must not promote 901.
  const moved = { ...CHANNELS, channels: CHANNELS.channels.map((c) => (c.name === 'internal' ? { ...c, currentReleaseQID: '901' } : c)) }
  toProduction = publishRoute({ path: '/api/v1/channels/78/publish' })
  route = (r) => (isChannels(r) ? [200, moved] : toProduction(r))
  n = reqs.length
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--source', '900', '--expected-current', 'none', '--expected-revision', '2', '--notes-file', NOTES])
  check('source moved (reviewed 900, internal now 901): refuses, exit 1 [source_changed], no publish POST', r.code === 1 && !mutations(since(n)).length &&
    /internal now serves release 901, not release 900 you reviewed/.test(r.stderr) && /\[source_changed\]/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  n = reqs.length
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--source', '900', '--expected-current', 'none', '--expected-revision', '2', '--notes-file', NOTES, '--json'])
  check('source moved --json: {code:source_changed, reviewed:900, current:901}, exit 1', r.code === 1 && JSON.parse(r.stderr).code === 'source_changed' &&
    JSON.parse(r.stderr).reviewed === '900' && JSON.parse(r.stderr).current === '901' && !mutations(since(n)).length, r.stderr)
  route = (r) => (isChannels(r) ? [200, CHANNELS] : toProduction(r))
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production', '--source', 'x9', '--expected-current', 'none', '--expected-revision', '2'])
  check('--source not a number -> exit 2', r.code === 2 && /--source must be a release number/.test(r.stderr), r.stderr)

  route = (r) => (isChannels(r) ? [200, { ...CHANNELS, channels: [{ ...INTERNAL, currentReleaseQID: null, currentRelease: null }, PRODUCTION] }] : envelope(500, 'server_error', 'x'))
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'production'])
  check('promote from an empty channel → exit 2 [no_published_release]', r.code === 2 && /\[no_published_release\]/.test(r.stderr), r.stderr)
  r = await run(['release', 'promote', 'sample', '--from', 'internal', '--to', 'internal'])
  check('promote --from = --to → exit 2', r.code === 2 && /same channel/.test(r.stderr))
}

// ============ release again: forward roll-back via /recover; republish via /release-again ============
function againRoute({ mode = 'forward_rollback', stale = false, recoveryEnd = 'published', recPolls = 2 } = {}) {
  let rp = 0, qp = 0
  const recovery = (state, extra = {}) => ({
    qid: '60', requestID: 'r', channelQID: '77', targetReleaseQID: '880', targetBuildQID: '480', sourceSha: SHA_A, expectedCurrentReleaseQID: '900', expectedChannelRevision: 4,
    baselineSha256: 'b'.repeat(64), baselineRevision: 3, buildQID: '503', versionCode: 224, approvedByUserQID: '7', state, stateCode: null, compatibility: null,
    publicationRequestQID: null, resultReleaseQID: null, notesMd: '', createdAt: AT, decidedAt: null, ...extra,
  })
  return (r) => {
    if (r.path === '/api/v1/releases/880') return [200, { release: release('880', 2, { current: false }), channel: { qid: '77', name: 'internal', production: false, platform: 'android' } }]
    if (r.path === '/api/v1/channels/77/release-again/preview') {
      return [200, { preview: { mode, stale, entries: null, effects: mode === 'forward_rollback' ? [{ type: 'forward_rollback', rebuildsCommit: SHA_A, currentKeepsServing: true }, { type: 'auto_publish_pauses' }] : [{ type: 'auto_publish_pauses' }], blockers: [] }, baseline: mode === 'forward_rollback' ? { baselineSha256: 'b'.repeat(64), revision: 3 } : null }]
    }
    if (r.path === '/api/v1/channels/77/recover') return [202, { recovery: recovery('building'), replayed: false, autoPublishPaused: true }]
    if (r.path === '/api/v1/recoveries/60') {
      rp++
      if (rp < recPolls) return [200, { recovery: recovery('building'), build: build({ qid: '503', state: 'running' }) }]
      if (recoveryEnd !== 'published') return [200, { recovery: recovery(recoveryEnd, { stateCode: 'build_failed' }), build: build({ qid: '503', state: 'failed' }) }]
      return [200, { recovery: recovery('publishing', { publicationRequestQID: '950' }), build: build({ qid: '503', state: 'succeeded' }) }]
    }
    if (r.path === '/api/v1/channels/77/release-again') return [202, { request: request('pending_verification', { operation: 'release_again' }), replayed: false, autoPublishPaused: true }]
    if (r.path === '/api/v1/release-requests/950') { qp++; return [200, { request: request(qp < 2 ? 'pending_verification' : 'published') }] }
    return envelope(404, 'not_found', 'nope')
  }
}
const AGAIN = ['release', 'again', '880', '--expected-current', '900', '--expected-revision', '4']
{
  route = againRoute()
  let n = reqs.length
  let r = await run([...AGAIN, '--notes-file', NOTES])
  let s = since(n)
  const pv = s.find((x) => x.path.endsWith('/release-again/preview'))
  const rec = s.find((x) => x.path.endsWith('/recover'))
  check('again: previews with the target + expected snapshot', pv && JSON.stringify(pv.body) === '{"targetReleaseQID":"880","expectedCurrentReleaseQID":"900","expectedChannelRevision":4}', JSON.stringify(pv?.body))
  check('again (forward_rollback): POST /recover with the preview\'s baseline, never /release-again', rec && rec.body.baselineSha256 === 'b'.repeat(64) && rec.body.targetReleaseQID === '880' && rec.body.expectedCurrentReleaseQID === '900' && rec.body.expectedChannelRevision === 4 && UUID4.test(rec.body.requestID) && rec.body.notesMd.startsWith('## 0.5.2') && !s.some((x) => x.path.endsWith('/release-again')), JSON.stringify(rec?.body))
  check('again: exactly two POSTs (preview + recover)', mutations(s).length === 2)
  check('again: follows the recovery, then its publication request', s.some((x) => x.path === '/api/v1/recoveries/60') && s.some((x) => x.path === '/api/v1/release-requests/950') && s.findIndex((x) => x.path === '/api/v1/recoveries/60') < s.findIndex((x) => x.path === '/api/v1/release-requests/950'))
  check('again: forward roll-back in words + the auto-publish pause notice, exit 0', r.code === 0 && /forward roll-back \(rebuild the earlier commit with a higher version code\)/.test(r.stdout) && /Forward roll-back: rebuilds commit a1b2c3d/.test(r.stdout) && /Recovery 60 accepted: rebuilding commit a1b2c3d forward as build 503/.test(r.stdout) && /Auto-publish on internal is paused/.test(r.stdout) && /qwirq channel resume <repo> internal --expected-revision <n>/.test(r.stdout) && /Published: release 901 is now current on internal/.test(r.stdout), `exit=${r.code} ${r.stdout}`)

  route = againRoute()
  r = await run([...AGAIN, '--json'])
  const ev = ndjson(r.stdout)
  check('again --json: preview, 202 {recovery,autoPublishPaused}, recovery + request objects, last published', r.code === 0 && ev[0].preview.mode === 'forward_rollback' && ev[1].recovery.qid === '60' && ev[1].autoPublishPaused === true && ev[ev.length - 1].request.state === 'published', r.stdout)

  route = againRoute({ mode: 'republish' })
  n = reqs.length
  r = await run(AGAIN)
  s = since(n)
  const ra = s.find((x) => x.path.endsWith('/release-again'))
  check('again (republish): POST /release-again (no /recover), body with snapshot + uuid', ra && UUID4.test(ra.body.requestID) && ra.body.targetReleaseQID === '880' && ra.body.expectedCurrentReleaseQID === '900' && ra.body.expectedChannelRevision === 4 && ra.body.notesMd === '' && ra.body.baselineSha256 === undefined && !s.some((x) => x.path.endsWith('/recover')), JSON.stringify(ra?.body))
  check('again (republish): pause notice, published, exit 0', r.code === 0 && /Auto-publish on internal is paused/.test(r.stdout) && /Published: release 901/.test(r.stdout), r.stdout)

  route = againRoute({ stale: true })
  n = reqs.length
  r = await run(AGAIN)
  check('again: stale preview → exit 2 [stale_channel], no recover/release-again POST', r.code === 2 && /\[stale_channel\]/.test(r.stderr) && /re-run preview/.test(r.stderr) && mutations(since(n)).length === 1, `exit=${r.code} ${r.stderr}`)

  route = againRoute({ recoveryEnd: 'failed' })
  r = await run(AGAIN)
  check('again: recovery fails → exit 1, nothing published', r.code === 1 && /Recovery 60 failed \[build_failed\]\. Nothing was published/.test(r.stdout), `exit=${r.code} ${r.stdout}`)

  route = againRoute()
  n = reqs.length
  r = await run([...AGAIN, '--no-wait'])
  check('again --no-wait: returns after the 202, names how to watch the recovery', r.code === 0 && /qwirq release wait --recovery 60/.test(r.stdout) && !since(n).some((x) => x.path === '/api/v1/recoveries/60'), r.stdout)
  route = againRoute()
  r = await run(['release', 'wait', '--recovery', '60'])
  check('release wait --recovery: follows to published, exit 0', r.code === 0 && /Published: release 901/.test(r.stdout), r.stdout)

  n = reqs.length
  r = await run(['release', 'again', '880', '--expected-revision', '4'])
  check('again without --expected-current → exit 2, nothing sent', r.code === 2 && since(n).length === 0)
  route = (r) => (r.path === '/api/v1/releases/880' ? againRoute()(r) : envelope(403, 'publication_forbidden', 'agents cannot recover'))
  r = await run(AGAIN)
  check('again as an agent → 403 publication_forbidden, exit 2', r.code === 2 && /\[publication_forbidden\]/.test(r.stderr) && /agent tokens can't publish, recover/.test(r.stderr), r.stderr)
}

// ============ channel list / pause / resume / link ============
{
  route = (r) => {
    if (isChannels(r)) return [200, CHANNELS]
    if (r.path === '/api/v1/channels/77/pause') return r.body.expectedRevision === 4 ? [200, { channel: { ...INTERNAL, revision: 5, autoPublish: { ...INTERNAL.autoPublish, state: 'paused', pausedByUserQID: '7' } } }] : envelope(409, 'stale_channel', 'revision moved', { detail: { currentReleaseQID: '900', revision: 5 } })
    if (r.path === '/api/v1/channels/77/resume') return [200, { channel: { ...INTERNAL, revision: 6 } }]
    return envelope(404, 'not_found', 'nope')
  }
  let r = await run(['channel', 'list', 'sample'])
  check('channel list: one state line per channel', r.stdout.split('\n').length === 2 && r.stdout.includes('internal · release 900 · 0.5.2 (code 222) · build 501 · auto-publish on (refs/heads/main) · revision 4') && r.stdout.includes('production (production) · nothing published yet · auto-publish paused by user 7 · revision 2') && r.code === 0, r.stdout)
  r = await run(['channel', 'ls', 'sample', '--json'])
  const j = JSON.parse(r.stdout)
  check('channel list --json: the response; signed URLs withheld', r.code === 0 && j.channels.length === 2 && j.links['77'].appPage === 'https://apps.example.test/get/sample/internal' && j.links['77'].download === null, r.stdout.slice(0, 300))

  let n = reqs.length
  r = await run(['channel', 'pause', 'sample', 'internal', '--expected-revision', '4'])
  const p = since(n).find((x) => x.method === 'POST')
  check('channel pause: POST /channels/77/pause {expectedRevision}', p.path === '/api/v1/channels/77/pause' && JSON.stringify(p.body) === '{"expectedRevision":4}', JSON.stringify(p))
  check('channel pause: says paused + how to resume, exit 0', r.code === 0 && /Auto-publish on internal is paused \(revision 5\)\. Resume: qwirq channel resume sample internal --expected-revision 5/.test(r.stdout), r.stdout)
  r = await run(['channel', 'pause', 'sample', 'internal', '--expected-revision', '3'])
  check('channel pause stale revision → exit 2 [stale_channel], points at channel list', r.code === 2 && /\[stale_channel\]/.test(r.stderr) && /qwirq channel list sample/.test(r.stderr), r.stderr)
  n = reqs.length
  r = await run(['channel', 'resume', 'sample', 'internal', '--expected-revision', '5', '--json'])
  check('channel resume --json: POST /resume, the response', r.code === 0 && since(n).some((x) => x.path === '/api/v1/channels/77/resume' && x.body.expectedRevision === 5) && JSON.parse(r.stdout).channel.revision === 6)
  r = await run(['channel', 'resume', 'sample', 'internal', '--expected-revision', '5'])
  check('channel resume: words, exit 0', r.code === 0 && /Auto-publish on internal is on again \(revision 6\)/.test(r.stdout), r.stdout)
  n = reqs.length
  r = await run(['channel', 'pause', 'sample', 'internal'])
  check('channel pause without --expected-revision → exit 2, nothing sent', r.code === 2 && since(n).length === 0)

  r = await run(['channel', 'link', 'sample', 'internal'])
  check('channel link: prints exactly the permanent app page URL', r.code === 0 && r.stdout === 'https://apps.example.test/get/sample/internal', r.stdout)
  r = await run(['channel', 'link', 'sample', 'internal', '--json'])
  check('channel link --json: {channelQID, channel, appPage} only', r.code === 0 && JSON.stringify(JSON.parse(r.stdout)) === '{"channelQID":"77","channel":"internal","appPage":"https://apps.example.test/get/sample/internal"}', r.stdout)
  r = await run(['channel', 'link', 'sample', 'production'])
  check('channel link with no verified host → exit 2 [link_unavailable]', r.code === 2 && /\[link_unavailable\]/.test(r.stderr), r.stderr)
  r = await run(['channel', 'link', 'sample', 'beta'])
  check('channel link unknown channel → exit 2 [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr))
  r = await run(['channel', 'link', 'sample', '9lives'])
  check('channel name must start with a letter → exit 2', r.code === 2 && /not a channel name/.test(r.stderr))
  r = await run(['channel', 'link', 'sample', 'a'.repeat(33)])
  check('channel name longer than 32 → exit 2', r.code === 2 && /not a channel name/.test(r.stderr))
}

// ============ Ctrl+C during a publish/recovery wait: stops watching, never touches publication ============
{
  const recoveringForever = againRoute({ recPolls: 1e9 })
  const pendingForever = (r) => {
    if (isChannels(r)) return [200, CHANNELS]
    if (r.method === 'POST' && r.path === '/api/v1/channels/77/publish') return [202, { request: request('pending_verification'), replayed: false }]
    if (r.path === '/api/v1/release-requests/950') return [200, { request: request('pending_verification') }]
    return recoveringForever(r)
  }
  if (process.platform !== 'win32') {
    route = pendingForever
    const before = reqs.length
    let sigAt = -1
    const r = await new Promise((res) => {
      const child = spawn(process.execPath, [BIN, ...PUB], { cwd: HOME, env: { ...process.env, ...ENV } })
      let so = '', se = ''
      child.stdout.on('data', (d) => { so += d; if (sigAt < 0 && /Ctrl\+C/.test(so)) setTimeout(() => { sigAt = reqs.length; child.kill('SIGINT') }, 100) })
      child.stderr.on('data', (d) => (se += d))
      child.stdin.end()
      child.on('close', (code) => { allOutput.push(so, se); res({ code, stdout: so, stderr: se }) })
    })
    check('real binary: SIGINT during publish wait → exit 130, names the request + how to resume', r.code === 130 && /Publication continues on the server \(request 950\)\. Resume watching: qwirq release wait 950/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
    check('real binary: no POST/DELETE after the signal (publication untouched)', mutations(reqs.slice(sigAt)).length === 0 && mutations(reqs.slice(before)).length === 1)
  } else {
    out('note  win32: a parent cannot deliver SIGINT to a child (Node hard-kills); driving the same handler in-process')
  }
  // in-process (every platform): the verb's own SIGINT handler, via process.emit
  Object.assign(process.env, ENV)
  const { releaseVerb } = await import('../src/verbs/release.mjs')
  const cap = () => { const o = { so: '', se: '' }; o.io = { out: (s = '') => (o.so += s + '\n'), err: (s = '') => (o.se += s + '\n') }; return o }
  let sigAt = 0
  const fire = (cond) => new Promise((resolve) => { const t = setInterval(() => { if (cond()) { clearInterval(t); sigAt = reqs.length; process.emit('SIGINT'); resolve() } }, 10) })
  const pubFlags = { channel: 'internal', build: '501', 'expected-current': '900', 'expected-revision': '4' }

  route = pendingForever
  let start = reqs.length
  let c = cap()
  let [code] = await Promise.all([releaseVerb(['publish', 'sample'], pubFlags, c.io), fire(() => reqs.slice(start).filter((x) => x.path === '/api/v1/release-requests/950').length >= 3)])
  await new Promise((r) => setTimeout(r, 100)) // anything the verb might still send after the signal lands here
  check('in-process: SIGINT during publish wait → 130, request id + resume command', code === 130 && /Stopped watching\. Publication continues on the server \(request 950\)\. Resume watching: qwirq release wait 950/.test(c.se), `code=${code} ${c.se}`)
  check('in-process: no POST/DELETE after the signal; exactly one publish POST overall', mutations(reqs.slice(sigAt)).length === 0 && mutations(reqs.slice(start)).length === 1, JSON.stringify(mutations(reqs.slice(start)).map((x) => x.path)))
  check('in-process: SIGINT handler released after the wait', process.listenerCount('SIGINT') === 0)
  allOutput.push(c.so, c.se)

  start = reqs.length
  c = cap()
  ;[code] = await Promise.all([releaseVerb(['publish', 'sample'], { ...pubFlags, json: true }, c.io), fire(() => reqs.slice(start).filter((x) => x.path === '/api/v1/release-requests/950').length >= 2)])
  let e = {}
  try { e = JSON.parse(c.se.trim()) } catch { /* checked below */ }
  check('in-process --json: SIGINT → 130 + {code:interrupted, requestQID, resume} on stderr', code === 130 && e.code === 'interrupted' && e.requestQID === '950' && e.resume === 'qwirq release wait 950', c.se)
  allOutput.push(c.so, c.se)

  route = pendingForever
  start = reqs.length
  c = cap()
  ;[code] = await Promise.all([releaseVerb(['again', '880'], { 'expected-current': '900', 'expected-revision': '4' }, c.io), fire(() => reqs.slice(start).filter((x) => x.path === '/api/v1/recoveries/60').length >= 3)])
  await new Promise((r) => setTimeout(r, 100))
  check('in-process: SIGINT during a recovery wait → 130, resume with --recovery, nothing sent after', code === 130 && /Resume watching: qwirq release wait --recovery 60/.test(c.se) && mutations(reqs.slice(sigAt)).length === 0 && process.listenerCount('SIGINT') === 0, `code=${code} ${c.se}`)
  allOutput.push(c.so, c.se)
}

// ============ help + transport ============
{
  let r = await run(['help'])
  check('help lists the build/release/channel verbs and their exit codes', /qwirq release publish <repo> --channel <name> --build <buildQID> --expected-current <qid\|none>/.test(r.stdout) && /qwirq channel link <repo> <channel>/.test(r.stdout) && /build\/release\/channel: same codes/.test(r.stdout) && /130 Ctrl\+C stopped watching \(publication continues/.test(r.stdout))
  r = await run(['release', 'list', 'sample'], { env: { QWIRQ_API_URL: 'http://127.0.0.1:9' } })
  check('unreachable API → exit 2 [unreachable]', r.code === 2 && /\[unreachable\]/.test(r.stderr), r.stderr)
}

check('no output anywhere carried a signed URL (?g= / &g=)', !allOutput.some((s) => /[?&]g=/.test(s)), allOutput.find((s) => /[?&]g=/.test(s))?.slice(0, 200) ?? '')

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
