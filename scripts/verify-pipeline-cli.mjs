// M0 WP8 pipeline CLI verbs — offline, against an in-memory mock of the human /api/v1/pipeline routes
// (M0-SPEC §5). Drives the REAL binary so arg parsing, request shape (method/path/query/body), output,
// and exit codes (0/1/2/130) are exercised: log follow across an attempt change, duplicate pages, the
// reconnect cursor, 401/403/404/409 codes, watch's fixed target, and Ctrl+C never cancelling.
// Ctrl+C on the real binary needs POSIX signals; on Windows (where a parent can only hard-kill a child)
// the same handler is driven in-process instead. No API, DB, or network needed.
//   node scripts/verify-pipeline-cli.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890'
const AT = '2026-10-16T14:41:00.000Z'

// --- mock api: each test installs `route(req) -> [status, body] | 'drop'` ---
const reqs = []
let route = () => [404, { error: 'not_found', code: 'not_found', message: 'not found' }]
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization }
    reqs.push(r)
    const answer = route(r)
    if (answer === 'drop') { req.socket.destroy(); return }
    const [code, body] = answer
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const HOME = mkdtempSync(join(tmpdir(), 'qwirq-wp8-'))
const ENV = { QWIRQ_API_URL: BASE, QWIRQ_TOKEN: 'mock', QWIRQ_HOME: HOME, QWIRQ_POLL_MS: '20', QWIRQ_RECONNECT_MS: '5000' }

let failures = 0
const out = (s) => process.stdout.write(s + '\n')
const check = (label, cond, detail = '') => { out(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!cond) failures++ }
const envelope = (status, code, message) => [status, { error: code, code, message, requestId: 'req-1' }]
const ndjson = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l))

function run(args, { onStdout, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/qwirq.mjs', ...args], { env: { ...process.env, ...ENV, ...env } })
    let so = '', se = ''
    child.stdout.on('data', (d) => { so += d; onStdout?.(so, child) })
    child.stderr.on('data', (d) => (se += d))
    child.on('close', (code, signal) => resolve({ code, signal, stdout: so.trim(), stderr: se.trim() }))
  })
}
const since = (n) => reqs.slice(n)

// --- fixtures ---
const job = (qid, name, state, attempt, extra = {}) => ({
  qid: String(qid), repositoryQID: '42', commitSha: SHA_A, name, required: true, state, attempt, maxAttempts: 3,
  spec: { adapter: 'command', image: 'node@sha256:' + 'a'.repeat(64), steps: [{ name: 'test', run: ['node', 'test.mjs'], network: 'none' }], outputs: [], limits: { seconds: 1800, memoryMb: 2048, cpus: 2, pids: 512 } },
  labels: ['linux', 'docker'], needs: [], queuedReason: null, cancelRequested: false, workerQID: null,
  queuedAt: AT, startedAt: attempt ? AT : null, finishedAt: null, exitCode: null, failureReason: null, ...extra,
})
const push = (qid, sha, jobQIDs, extra = {}) => ({
  qid: String(qid), repositoryQID: '42', submissionID: '00000000-0000-5000-8000-00000000000' + qid, ref: 'refs/heads/main',
  oldSha: '0'.repeat(40), newSha: sha, pusherUserQID: '7', manifestSha256: 'f'.repeat(64), admission: 'accepted',
  rejectionCode: null, receivedAt: AT, jobQIDs: jobQIDs.map(String), ...extra,
})
const attemptRow = (n, state) => ({ jobQID: '31', attempt: n, workerQID: '5', state, steps: [{ index: 0, name: 'test', state: state === 'running' ? 'running' : 'succeeded' }], logLines: 2, logBytes: 20, logTruncated: false, startedAt: AT, finishedAt: null, exitCode: null, failureReason: null })
const detail = (j, attempts, permissions = { retry: false, cancel: true }) => ({ job: j, attempts, artifacts: [], permissions })
const line = (seq, text, step = 'test', stream = 'out') => ({ seq, at: AT, step, stream, text })
const logPage = (attempt, lines, { hasMore = false, terminal = false, truncated = false, nextAfter } = {}) =>
  [200, { attempt, lines, nextAfter: nextAfter ?? (lines.length ? lines[lines.length - 1].seq : 0), hasMore, terminal, truncated }]

// ============ jobs <repo> ============
{
  const list = {
    pushes: [push(10, SHA_B, [], { admission: 'rejected', rejectionCode: 'queue_full' }), push(9, SHA_A, [31, 32])],
    jobs: [job(32, 'lint', 'queued', 0, { queuedReason: { code: 'no_matching_worker', labels: ['linux', 'docker'], since: AT } }), job(31, 'test', 'running', 1)],
    nextCursor: '31', updatedAt: AT,
  }
  route = (r) => (r.path === '/api/v1/pipeline/jobs' ? [200, list] : envelope(404, 'not_found', 'nope'))
  let n = reqs.length
  let r = await run(['jobs', 'sample'])
  check('jobs <repo> GETs /api/v1/pipeline/jobs?repo=<slug> with the bearer token', since(n)[0]?.query.repo === 'sample' && since(n)[0]?.auth === 'Bearer mock', JSON.stringify(since(n)[0]))
  check('jobs <repo> groups by commit (sha7 + branch)', /a1b2c3d {2}main/.test(r.stdout) && /b2c3d4e {2}main/.test(r.stdout), r.stdout)
  check('jobs <repo> shows a rejected push in words', /push 10 · not admitted: too many outstanding jobs \(queue full\)/.test(r.stdout))
  check('jobs <repo> shows the queued reason in words', /lint\s+queued \(no online worker with labels linux, docker\)/.test(r.stdout))
  check('jobs <repo> shows running · attempt', /31\s+test\s+running · attempt 1/.test(r.stdout))
  check('jobs <repo> offers the next page', /More: qwirq jobs sample --cursor 31/.test(r.stdout))
  check('jobs <repo> exits 0', r.code === 0, `exit=${r.code}`)

  n = reqs.length
  await run(['jobs', 'sample', '--sha', SHA_A, '--state', 'failed', '--cursor', '31'])
  const q = since(n)[0]?.query ?? {}
  check('jobs <repo> passes --sha/--state/--cursor as query', q.sha === SHA_A && q.state === 'failed' && q.cursor === '31' && q.repo === 'sample', JSON.stringify(q))

  r = await run(['jobs', 'sample', '--json'])
  check('jobs <repo> --json prints the response as JSON', JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify(list))
}

// ============ jobs show ============
{
  const d = detail(job(31, 'test', 'running', 1), [attemptRow(1, 'running')])
  route = (r) => (r.path === '/api/v1/pipeline/jobs/31' ? [200, d] : envelope(404, 'not_found', 'job not found'))
  let r = await run(['jobs', 'show', '31'])
  check('jobs show: header in words', /^Job 31 · test · running · attempt 1 of 3/.test(r.stdout), r.stdout.split('\n')[0])
  check('jobs show: steps + attempts', /Steps \(attempt 1\):/.test(r.stdout) && /attempt 1 · running/.test(r.stdout))
  check('jobs show: offers only permitted actions', /cancel: qwirq jobs cancel 31 --attempt 1/.test(r.stdout) && !/retry:/.test(r.stdout))
  check('jobs show: offers the live log', /log: qwirq jobs logs 31 --attempt 1 --follow/.test(r.stdout))
  r = await run(['jobs', 'show', '31', '--json'])
  check('jobs show --json is the response', JSON.parse(r.stdout).job.qid === '31' && r.code === 0)

  r = await run(['jobs', 'show', '99'])
  check('404 → exit 2 + [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr) && /job not found/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  route = () => envelope(401, 'unauthorized', 'missing token')
  r = await run(['jobs', 'show', '31'])
  check('401 → exit 2 + login hint + [unauthorized]', r.code === 2 && /qwirq login/.test(r.stderr) && /\[unauthorized\]/.test(r.stderr), r.stderr)
}

// ============ jobs logs (no follow): pages until hasMore=false ============
{
  route = (r) => {
    if (r.path !== '/api/v1/pipeline/jobs/31/log') return envelope(404, 'not_found', 'nope')
    if (r.query.after === '0') return logPage(1, [line(1, 'one'), line(2, 'two')], { hasMore: true })
    return logPage(1, [line(3, 'three', 'test', 'err')], { terminal: true })
  }
  const n = reqs.length
  const r = await run(['jobs', 'logs', '31', '--attempt', '1'])
  const qs = since(n).map((x) => x.query)
  check('logs: every request names attempt; cursor advances 0 → 2', qs.length === 2 && qs.every((q) => q.attempt === '1') && qs[0].after === '0' && qs[1].after === '2', JSON.stringify(qs))
  check('logs: prints all three lines in order', /one[\s\S]*two[\s\S]*three/.test(r.stdout) && r.stdout.split('\n').length === 3, r.stdout)
  check('logs: stderr lines marked', /test !  three/.test(r.stdout))
  check('logs (no follow) exits 0', r.code === 0)
}

// ============ jobs logs --follow --json: dup page, reconnect cursor, attempt change ============
{
  let a1 = 0, a2 = 0, details = 0
  route = (r) => {
    if (r.path === '/api/v1/pipeline/jobs/31') {
      details++
      return [200, details === 1
        ? detail(job(31, 'test', 'running', 2), [attemptRow(1, 'lease_lost'), attemptRow(2, 'running')])
        : detail(job(31, 'test', 'succeeded', 2), [attemptRow(1, 'lease_lost'), attemptRow(2, 'succeeded')])]
    }
    if (r.path !== '/api/v1/pipeline/jobs/31/log') return envelope(404, 'not_found', 'nope')
    if (r.query.attempt === '1') {
      a1++
      if (a1 === 1) return logPage(1, [line(1, 'a1-1'), line(2, 'a1-2')])
      if (a1 === 2) return logPage(1, [line(1, 'a1-1'), line(2, 'a1-2'), line(3, 'a1-3')]) // overlapping page
      if (a1 === 3) return 'drop'                                                            // connection lost
      if (a1 === 4) return envelope(503, 'server_error', 'upstream restarting')
      return logPage(1, [line(4, 'a1-4')], { terminal: true })
    }
    a2++
    if (a2 === 1) return logPage(2, [line(1, 'a2-1')])
    return logPage(2, [line(2, 'a2-2')], { terminal: true })
  }
  const n = reqs.length
  const r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow', '--json'])
  const ev = ndjson(r.stdout)
  const lines = ev.filter((e) => e.type === 'line')
  const a1seqs = lines.filter((e) => e.attempt === 1).map((e) => e.seq)
  const a2seqs = lines.filter((e) => e.attempt === 2).map((e) => e.seq)
  check('follow: duplicate/overlapping page lines dropped (attempt 1 seq 1..4 once each)', JSON.stringify(a1seqs) === '[1,2,3,4]', JSON.stringify(a1seqs))
  check('follow: NDJSON line carries jobQID/attempt/seq', lines.every((e) => e.jobQID === '31' && Number.isInteger(e.attempt) && Number.isInteger(e.seq) && e.text))
  const logReqs = since(n).filter((x) => x.path.endsWith('/log'))
  const a1after = logReqs.filter((x) => x.query.attempt === '1').map((x) => x.query.after)
  check('follow: reconnect resumes after the last line printed (after=3 on every retry)', JSON.stringify(a1after) === '["0","2","3","3","3"]', JSON.stringify(a1after))
  check('follow: stderr says reconnecting, then reconnected', /reconnecting/.test(r.stderr) && /Reconnected\./.test(r.stderr), r.stderr)
  const sw = ev.find((e) => e.type === 'attempt')
  check('follow: attempt change emitted (1 lease_lost → 2)', sw && sw.previousAttempt === 1 && sw.attempt === 2 && sw.previousState === 'lease_lost', JSON.stringify(sw))
  const a2after = logReqs.filter((x) => x.query.attempt === '2').map((x) => x.query.after)
  check('follow: new attempt read from after=0 (old lines never reused)', JSON.stringify(a2after) === '["0","1"]' && JSON.stringify(a2seqs) === '[1,2]', JSON.stringify({ a2after, a2seqs }))
  check('follow: ends with {type:end,state:succeeded} and exit 0', ev[ev.length - 1]?.type === 'end' && ev[ev.length - 1].state === 'succeeded' && r.code === 0, `exit=${r.code}`)
}

// ============ follow ending failed → exit 1 ============
{
  route = (r) => {
    if (r.path === '/api/v1/pipeline/jobs/31') return [200, detail(job(31, 'test', 'failed', 1), [attemptRow(1, 'failed')])]
    return logPage(1, [line(1, 'boom', 'test', 'err')], { terminal: true })
  }
  const r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'])
  check('follow on a failed job exits 1 and says so', r.code === 1 && /Job 31 failed \(attempt 1\)/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
}

// ============ follow an attempt that doesn't exist yet (job still queued; API 404s until claim) ============
function queuedThenRoute({ endWithout = false } = {}) {
  let details = 0, claimed = false, logReads = 0
  const queued = job(31, 'test', 'queued', 0, { queuedReason: { code: 'no_matching_worker', labels: ['linux'], since: AT } })
  return (r) => {
    if (r.path === '/api/v1/pipeline/jobs/31') {
      details++
      if (endWithout) return [200, detail(details < 3 ? queued : { ...queued, state: 'cancelled', queuedReason: null }, [])]
      if (details >= 3) claimed = true
      if (!claimed) return [200, detail(queued, [])]
      return [200, logReads >= 1 ? detail(job(31, 'test', 'succeeded', 1), [attemptRow(1, 'succeeded')]) : detail(job(31, 'test', 'running', 1), [attemptRow(1, 'running')])]
    }
    if (r.path === '/api/v1/pipeline/jobs/31/log') {
      if (!claimed) return envelope(404, 'not_found', 'attempt not found')
      logReads++
      return logPage(1, [line(1, 'started')], { terminal: true })
    }
    return envelope(404, 'not_found', 'nope')
  }
}
{
  route = queuedThenRoute()
  let r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow', '--json'])
  let ev = ndjson(r.stdout)
  const waits = ev.filter((e) => e.type === 'waiting')
  check('follow before claim: one `waiting` event (attempt, state, reason), then the log', waits.length === 1 && waits[0].attempt === 1 && waits[0].state === 'queued' && waits[0].queuedReason?.code === 'no_matching_worker' && ev.indexOf(waits[0]) < ev.findIndex((e) => e.type === 'line'), r.stdout)
  check('follow before claim: lines of attempt 1 once claimed, end succeeded, exit 0', JSON.stringify(ev.filter((e) => e.type === 'line').map((e) => [e.attempt, e.seq])) === '[[1,1]]' && ev[ev.length - 1].type === 'end' && ev[ev.length - 1].state === 'succeeded' && r.code === 0, `exit=${r.code} ${r.stderr}`)

  route = queuedThenRoute()
  r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'])
  check('follow before claim (human): "Waiting for the job to start…" printed once, exit 0', (r.stderr.match(/Waiting for the job to start…/g) || []).length === 1 && /no online worker with labels linux/.test(r.stderr) && /started/.test(r.stdout) && r.code === 0, `exit=${r.code} ${r.stderr}`)

  route = queuedThenRoute({ endWithout: true })
  r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'])
  check('job ends before the attempt exists → exit 1 with a clear line', r.code === 1 && /Job 31 cancelled before attempt 1 started; there is no log to follow\./.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  route = queuedThenRoute({ endWithout: true })
  r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow', '--json'])
  ev = ndjson(r.stdout)
  check('… --json: end event {state:cancelled, attemptStarted:false}, exit 1', r.code === 1 && ev[ev.length - 1].type === 'end' && ev[ev.length - 1].state === 'cancelled' && ev[ev.length - 1].attemptStarted === false, r.stdout)

  route = queuedThenRoute()
  r = await run(['jobs', 'logs', '31', '--attempt', '1'])
  check('without --follow a not-yet-existing attempt is still exit 2 [not_found]', r.code === 2 && /\[not_found\]/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  route = () => envelope(404, 'not_found', 'job not found')
  r = await run(['jobs', 'logs', '77', '--attempt', '1', '--follow'])
  check('follow on a job that does not exist → exit 2 [not_found] (no waiting)', r.code === 2 && /job not found/.test(r.stderr) && !/Waiting/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  route = (r) => (r.path.endsWith('/log') ? envelope(404, 'not_found', 'attempt not found') : [200, detail(job(31, 'test', 'running', 2), [])])
  r = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'])
  check('job past the attempt but its log 404s → exit 2 after one recheck (no endless wait)', r.code === 2 && /attempt not found/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
}

// ============ retry / cancel: body, 409, 403, usage ============
{
  route = (r) => {
    if (r.path === '/api/v1/pipeline/jobs/31/retry') {
      return r.body?.expectedAttempt === 1
        ? [202, { jobQID: '31', state: 'queued', previousAttempt: 1, nextAttempt: 2 }]
        : envelope(409, 'invalid_state', `job is at attempt 1, not ${r.body?.expectedAttempt}`)
    }
    if (r.path === '/api/v1/pipeline/jobs/31/cancel') return envelope(403, 'forbidden', 'not authorized to cancel jobs in this repository')
    return envelope(404, 'not_found', 'nope')
  }
  let n = reqs.length
  let r = await run(['jobs', 'retry', '31', '--attempt', '1'])
  const p = since(n)[0]
  check('retry POSTs {expectedAttempt} to /retry', p?.method === 'POST' && p.path === '/api/v1/pipeline/jobs/31/retry' && JSON.stringify(p.body) === '{"expectedAttempt":1}', JSON.stringify(p))
  check('retry prints the queued attempt, exit 0', /attempt 2 is queued \(attempt 1 is kept\)/.test(r.stdout) && r.code === 0, r.stdout)

  r = await run(['jobs', 'retry', '31', '--attempt', '3'])
  check('409 invalid_state → exit 2 + [invalid_state] + server message', r.code === 2 && /\[invalid_state\]/.test(r.stderr) && /not 3/.test(r.stderr), `exit=${r.code} ${r.stderr}`)

  r = await run(['jobs', 'cancel', '31', '--attempt', '1'])
  check('403 forbidden → exit 2 + permission words + [forbidden]', r.code === 2 && /permission/.test(r.stderr) && /\[forbidden\]/.test(r.stderr), `exit=${r.code} ${r.stderr}`)
  r = await run(['jobs', 'cancel', '31', '--attempt', '1', '--json'])
  let e = {}
  try { e = JSON.parse(r.stderr) } catch { /* checked below */ }
  check('--json errors are a JSON envelope on stderr (code/status)', e.code === 'forbidden' && e.status === 403 && r.code === 2, r.stderr)

  n = reqs.length
  r = await run(['jobs', 'retry', '31'])
  check('retry without --attempt: exit 2, nothing sent', r.code === 2 && since(n).length === 0 && /--attempt <n> is required/.test(r.stderr), r.stderr)
  r = await run(['jobs', 'logs', '31', '--attempt', '0'])
  check('logs --attempt 0: exit 2 (attempts start at 1)', r.code === 2 && since(n).length === 0)
  r = await run(['jobs', 'show', 'abc'])
  check('jobs show <non-number>: exit 2', r.code === 2)
}

// ============ cancel ok (queued → immediate; running → requested) ============
{
  route = (r) => [200, r.body.expectedAttempt === 0 ? { jobQID: '32', state: 'cancelled', cancelRequested: false } : { jobQID: '31', state: 'running', cancelRequested: true }]
  let r = await run(['jobs', 'cancel', '32', '--attempt', '0'])
  check('cancel a never-claimed job with --attempt 0', r.code === 0 && /Cancelled job 32/.test(r.stdout), r.stdout + r.stderr)
  r = await run(['jobs', 'cancel', '31', '--attempt', '1'])
  check('cancel a running job says the worker stops it', r.code === 0 && /next heartbeat/.test(r.stdout), r.stdout)
}

// ============ watch: fixed target despite a later push ============
function watchRoute({ final = 'succeeded', finalTest = 'succeeded', lintRequired = true, blip = false, forever = false } = {}) {
  let unfiltered = 0, polls = 0
  return (r) => {
    if (r.path !== '/api/v1/pipeline/jobs') return envelope(404, 'not_found', 'nope')
    if (!r.query.sha) {
      unfiltered++
      // the first call is the snapshot; any later unfiltered call would see push 11 (another commit)
      return [200, unfiltered === 1
        ? { pushes: [push(9, SHA_A, [31, 32])], jobs: [job(31, 'test', 'queued', 0), job(32, 'lint', 'queued', 0)], nextCursor: null, updatedAt: AT }
        : { pushes: [push(11, SHA_B, [40]), push(9, SHA_A, [31, 32])], jobs: [{ ...job(40, 'test', 'queued', 0), commitSha: SHA_B }], nextCursor: null, updatedAt: AT }]
    }
    if (r.query.sha !== SHA_A) return [200, { pushes: [], jobs: [], nextCursor: null, updatedAt: AT }]
    polls++
    if (blip && polls === 2) return envelope(502, 'server_error', 'bad gateway')
    const s = forever ? ['running', 'queued'] : polls === 1 ? ['running', 'queued'] : polls <= 3 ? [finalTest, 'running'] : [finalTest, final]
    const att = (st) => (st === 'queued' || st === 'skipped' ? 0 : 1)
    return [200, { pushes: [push(9, SHA_A, [31, 32])], jobs: [job(31, 'test', s[0], att(s[0])), job(32, 'lint', s[1], att(s[1]), { required: lintRequired })], nextCursor: null, updatedAt: AT }]
  }
}
{
  route = watchRoute()
  let n = reqs.length
  let r = await run(['watch', 'sample'])
  const later = since(n).slice(1)
  check('watch: snapshot first, then every poll pinned to the snapshotted commit', later.length >= 2 && later.every((x) => x.query.sha === SHA_A), JSON.stringify(later.map((x) => x.query)))
  check('watch: names its target', /Watching push 9 · a1b2c3d on main · 2 jobs/.test(r.stdout), r.stdout.split('\n')[0])
  check('watch: the later push (b2c3d4e) never replaces the target', !r.stdout.includes('b2c3d4e') && !r.stdout.includes('push 11'))
  check('watch: reports transitions in words', /test\s+running · attempt 1/.test(r.stdout) && /lint\s+succeeded · attempt 1/.test(r.stdout), r.stdout)
  check('watch: all succeeded → exit 0', r.code === 0 && /All 2 required jobs on a1b2c3d succeeded/.test(r.stdout), `exit=${r.code}`)

  route = watchRoute()
  r = await run(['watch', 'sample', '--json'])
  const ev = ndjson(r.stdout)
  check('watch --json: NDJSON target → job events → end', ev[0].type === 'target' && ev[0].pushQID === '9' && ev[0].commitSha === SHA_A && ev.some((e) => e.type === 'job' && e.jobQID === '31' && e.attempt === 1) && ev[ev.length - 1].type === 'end' && ev[ev.length - 1].outcome === 'succeeded', r.stdout)
  check('watch --json: each state change emitted once', ev.filter((e) => e.type === 'job' && e.jobQID === '31' && e.state === 'succeeded').length === 1)

  route = watchRoute({ final: 'failed' })
  r = await run(['watch', 'sample'])
  check('watch: a failed job → exit 1 + where to look', r.code === 1 && /1 of 2 required jobs on a1b2c3d did not succeed: lint failed/.test(r.stdout) && /log: qwirq jobs logs 32 --attempt 1/.test(r.stdout), `exit=${r.code} ${r.stdout}`)
  route = watchRoute({ final: 'timed_out' })
  r = await run(['watch', 'sample', '--json'])
  check('watch: timed out → exit 1, outcome failed', r.code === 1 && ndjson(r.stdout).pop().outcome === 'failed')

  // exit status follows REQUIRED jobs only (Foreman ruling)
  route = watchRoute({ final: 'failed', lintRequired: false })
  r = await run(['watch', 'sample'])
  check('watch: optional job fails, required pass → exit 0, optional failure reported', r.code === 0 && /All 1 required job on a1b2c3d succeeded/.test(r.stdout) && /Optional check lint failed \(does not fail the watch\)/.test(r.stdout), `exit=${r.code} ${r.stdout}`)
  route = watchRoute({ final: 'failed', lintRequired: false })
  r = await run(['watch', 'sample', '--json'])
  const optEnd = ndjson(r.stdout).pop()
  check('watch --json: optional failure → outcome succeeded, job carries required:false', r.code === 0 && optEnd.outcome === 'succeeded' && optEnd.jobs.some((j) => j.name === 'lint' && j.required === false && j.state === 'failed'), JSON.stringify(optEnd))
  route = watchRoute({ final: 'skipped' })
  r = await run(['watch', 'sample'])
  check('watch: required job skipped (dependency failed) → exit 1', r.code === 1 && /did not succeed: lint skipped/.test(r.stdout), `exit=${r.code} ${r.stdout}`)
  route = watchRoute({ final: 'skipped', lintRequired: false })
  r = await run(['watch', 'sample'])
  check('watch: optional job skipped → exit 0', r.code === 0, `exit=${r.code} ${r.stdout}`)

  route = watchRoute({ blip: true })
  r = await run(['watch', 'sample'])
  check('watch survives a 502 mid-watch (reconnects, exit 0)', r.code === 0 && /reconnecting/.test(r.stderr) && /Reconnected\./.test(r.stderr), `exit=${r.code} ${r.stderr}`)

  route = watchRoute()
  n = reqs.length
  r = await run(['watch', 'sample', '--sha', SHA_A])
  check('watch --sha pins the given commit from the first request', since(n).every((x) => x.query.sha === SHA_A) && r.code === 0)
  r = await run(['watch', 'sample', '--sha', SHA_B])
  check('watch --sha with no push → exit 2 [not_found]', r.code === 2 && /no push of b2c3d4e/.test(r.stderr) && /\[not_found\]/.test(r.stderr), r.stderr)

  route = () => [200, { pushes: [push(12, SHA_B, [], { admission: 'rejected', rejectionCode: 'queue_full' })], jobs: [], nextCursor: null, updatedAt: AT }]
  r = await run(['watch', 'sample'])
  check('watch: latest push not admitted → exit 1, says why', r.code === 1 && /not admitted: too many outstanding jobs \(queue full\)/.test(r.stdout), r.stdout)
  route = () => envelope(403, 'forbidden', 'no access')
  r = await run(['watch', 'sample'])
  check('watch: 403 → exit 2 (no retry loop)', r.code === 2 && /\[forbidden\]/.test(r.stderr))
}

// ============ Ctrl+C: stops watching/following, exit 130, never cancels ============
{
  const cancels = () => reqs.filter((x) => x.method === 'POST').length
  if (process.platform !== 'win32') {
    route = watchRoute({ forever: true })
    const before = cancels()
    let sent = false
    const r = await run(['watch', 'sample'], { onStdout: (so, child) => { if (!sent && /lint/.test(so)) { sent = true; setTimeout(() => child.kill('SIGINT'), 100) } } })
    check('real binary: SIGINT stops watch with exit 130', r.code === 130 && /Stopped watching\. Jobs keep running\./.test(r.stderr), `exit=${r.code} signal=${r.signal} ${r.stderr}`)
    check('real binary: SIGINT sent no cancel/retry', cancels() === before)
    route = (r) => (r.path.endsWith('/log') ? logPage(1, [line(1, 'tick')]) : [200, detail(job(31, 'test', 'running', 1), [attemptRow(1, 'running')])])
    sent = false
    const r2 = await run(['jobs', 'logs', '31', '--attempt', '1', '--follow'], { onStdout: (so, child) => { if (!sent) { sent = true; setTimeout(() => child.kill('SIGINT'), 100) } } })
    check('real binary: SIGINT stops log follow with exit 130', r2.code === 130 && /Stopped following/.test(r2.stderr), `exit=${r2.code} ${r2.stderr}`)
    check('real binary: still no cancel after follow SIGINT', cancels() === before)
  } else {
    out('note  win32: a parent cannot deliver SIGINT to a child (Node hard-kills); driving the same handler in-process')
  }
  // in-process (every platform): the verb's own SIGINT handler, via process.emit
  Object.assign(process.env, ENV)
  const { watchVerb } = await import('../src/verbs/watch.mjs')
  const { jobsVerb } = await import('../src/verbs/jobs.mjs')
  const cap = () => { const o = { so: '', se: '' }; o.io = { out: (s = '') => (o.so += s + '\n'), err: (s = '') => (o.se += s + '\n') }; return o }
  const fire = (cond) => new Promise((resolve) => { const t = setInterval(() => { if (cond()) { clearInterval(t); process.emit('SIGINT'); resolve() } }, 10) })

  route = watchRoute({ forever: true })
  let before = cancels()
  let c = cap()
  let pollsAt = reqs.length
  let [code] = await Promise.all([watchVerb(['sample'], {}, c.io), fire(() => reqs.length - pollsAt >= 4)])
  check('in-process: SIGINT → watch returns 130, says jobs keep running', code === 130 && /Stopped watching\. Jobs keep running\./.test(c.se), `code=${code} ${c.se}`)
  check('in-process: SIGINT sent no cancel', cancels() === before)
  check('in-process: handler released after watch', process.listenerCount('SIGINT') === 0)

  route = (r) => (r.path.endsWith('/log') ? logPage(1, [line(1, 'tick')]) : [200, detail(job(31, 'test', 'running', 1), [attemptRow(1, 'running')])])
  c = cap()
  pollsAt = reqs.length
  ;[code] = await Promise.all([jobsVerb(['logs', '31'], { attempt: '1', follow: true }, c.io), fire(() => reqs.length - pollsAt >= 3)])
  check('in-process: SIGINT → log follow returns 130, no cancel', code === 130 && /Stopped following/.test(c.se) && cancels() === before, `code=${code}`)
}

// ============ project status / repo status ============
{
  const status = {
    repository: { qid: '42', slug: 'sample', name: 'Sample' },
    latestPush: { qid: '9', commitSha: SHA_A, ref: 'refs/heads/main', admission: 'accepted', rejectionCode: null, receivedAt: AT, pusherUserQID: '7' },
    checks: [{ jobQID: '31', name: 'test', required: true, state: 'running', attempt: 2 }, { jobQID: '32', name: 'lint', required: true, state: 'succeeded', attempt: 1 }],
    counts: { queued: 0, running: 1, failed: 0 }, attention: { code: 'running', jobQID: '31' }, updatedAt: AT,
  }
  route = (r) => (/^\/api\/v1\/(projects|repositories)\/sample\/status$/.test(r.path) ? [200, status] : envelope(404, 'not_found', 'repository not found'))
  let n = reqs.length
  let r = await run(['project', 'status', 'sample'])
  check('project status GETs /api/v1/projects/<slug>/status', since(n)[0]?.path === '/api/v1/projects/sample/status')
  check('project status: Now line names the job and the next command', /Now: test is running \(job 31\)\. Follow: qwirq jobs logs 31 --attempt 2 --follow/.test(r.stdout), r.stdout)
  check('project status: latest push + checks + counts', /Latest push: 9 · a1b2c3d on main · admitted/.test(r.stdout) && /lint\s+succeeded/.test(r.stdout) && /1 running · 0 queued · 0 failed/.test(r.stdout))
  check('project status: no release/channel words (M0 has none)', !/release|channel|install/i.test(r.stdout))
  n = reqs.length
  r = await run(['repo', 'status', 'sample', '--json'])
  check('repo status --json GETs /api/v1/repositories/<slug>/status, prints it', since(n)[0]?.path === '/api/v1/repositories/sample/status' && JSON.parse(r.stdout).attention.code === 'running' && r.code === 0)
  r = await run(['repo', 'status', 'nope'])
  check('repo status 404 → exit 2', r.code === 2 && /\[not_found\]/.test(r.stderr))
  r = await run(['project', 'status'])
  check('project status without a slug → exit 2 usage', r.code === 2 && /usage: qwirq project status/.test(r.stderr))
  route = () => [200, { ...status, latestPush: { ...status.latestPush, admission: 'rejected', rejectionCode: 'queue_full' }, attention: { code: 'queue_full', pushQID: '9' } }]
  r = await run(['repo', 'status', 'sample'])
  check('status: rejected push explained in words', /Now: Push 9 was not admitted: too many outstanding jobs \(queue full\)/.test(r.stdout), r.stdout)
}

// ============ transport error ============
{
  const r = await run(['jobs', 'sample'], { env: { QWIRQ_API_URL: 'http://127.0.0.1:9' } })
  check('unreachable API → exit 2 + [unreachable]', r.code === 2 && /\[unreachable\]/.test(r.stderr), r.stderr)
}

// ============ qwirq validate plans pipelines (vendored @qwirq/manifest 0.4.0) ============
{
  const dir = mkdtempSync(join(tmpdir(), 'qwirq-wp8-yaml-'))
  const img = 'node:20-bookworm-slim@sha256:' + 'a'.repeat(64)
  const yaml = (checks) => `id: sample\nname: Sample\npipeline:\n  checks:\n${checks}`
  const chk = (name, needs) => `    - name: ${name}\n      adapter: command\n      image: ${img}\n${needs ? `      needs: [${needs}]\n` : ''}      steps:\n        - name: s\n          run: [node, t.mjs]\n`
  writeFileSync(join(dir, 'ok.yaml'), yaml(chk('test')))
  writeFileSync(join(dir, 'cycle.yaml'), yaml(chk('a', 'b') + chk('b', 'a')))
  writeFileSync(join(dir, 'net.yaml'), yaml(chk('test').replace('run: [node, t.mjs]', 'run: [node, t.mjs]\n          network: host')))
  let r = await run(['validate', '--file', join(dir, 'ok.yaml')])
  check('validate: pipeline-only manifest is valid (no provides needed)', r.code === 0 && /valid \(pipeline: 1 check\)/.test(r.stdout), r.stdout + r.stderr)
  r = await run(['validate', '--file', join(dir, 'cycle.yaml')])
  check('validate: dependency cycle caught [dependency_cycle]', r.code === 1 && /\[dependency_cycle\]/.test(r.stderr), r.stderr)
  r = await run(['validate', '--file', join(dir, 'net.yaml')])
  check('validate: network egress rejected (M0 = none only)', r.code === 1 && /network/.test(r.stderr), r.stderr)
}

server.close()
out('')
out(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
