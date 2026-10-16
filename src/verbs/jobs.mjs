// `qwirq jobs …` — pipeline jobs (checks) over the human /api/v1/pipeline routes (M0-SPEC §5, §6 WP8).
//   jobs <repo> [--sha] [--state] [--cursor] [--json]   list, grouped by commit
//   jobs show <qid> [--json]                            detail: steps, attempts, artifacts, what you can do
//   jobs logs <qid> --attempt <n> [--follow] [--json]   log lines; follow polls with the `after` cursor
//   jobs retry|cancel <qid> --attempt <n> [--json]      guarded by expectedAttempt
// Returns an exit code (EXIT). Never sends a lease token; never defaults the log attempt server-side.
import { apiFetch } from '../api.mjs'
import {
  EXIT, TERMINAL, NOT_SUCCESS, POLL_MS, UsageError, Interrupted, interruptible, sleep, pollGet, reportError,
  flagStr, attemptFlag, qs, sha7, branch, stateWord, queuedWords, jobPhrase, rejectionWords, clock, when, bytes, pad,
  stdio,
} from './pipeline-shared.mjs'

const USAGE = {
  list: 'qwirq jobs <repo> [--sha <sha>] [--state <state>] [--json]',
  show: 'qwirq jobs show <qid> [--json]',
  logs: 'qwirq jobs logs <qid> --attempt <n> [--follow] [--json]',
  retry: 'qwirq jobs retry <qid> --attempt <n>',
  cancel: 'qwirq jobs cancel <qid> --attempt <n>',
}
const LOG_PAGE = 500
const JOB = (qid) => `/api/v1/pipeline/jobs/${encodeURIComponent(qid)}`

const qidArg = (v, usage) => {
  if (!v || !/^\d+$/.test(v)) throw new UsageError(`expected a job number. usage: ${usage}`)
  return v
}

export async function jobsVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  try {
    const sub = positional[0]
    if (sub === 'show') return await show(qidArg(positional[1], USAGE.show), json, io)
    if (sub === 'logs') return await logs(qidArg(positional[1], USAGE.logs), attemptFlag(flags, USAGE.logs, 1), !!flags.follow, json, io)
    if (sub === 'retry') return await retry(qidArg(positional[1], USAGE.retry), attemptFlag(flags, USAGE.retry), json, io)
    if (sub === 'cancel') return await cancel(qidArg(positional[1], USAGE.cancel), attemptFlag(flags, USAGE.cancel), json, io)
    if (!sub) throw new UsageError(`usage: ${USAGE.list}\n       ${USAGE.show}\n       ${USAGE.logs}\n       ${USAGE.retry}\n       ${USAGE.cancel}`)
    return await list(sub, flags, json, io)
  } catch (e) {
    if (e instanceof Interrupted) return EXIT.interrupted
    return reportError(e, { json, io })
  }
}

// --- list ---

async function list(repo, flags, json, io) {
  const path = `/api/v1/pipeline/jobs${qs({ repo, sha: flagStr(flags.sha), state: flagStr(flags.state), cursor: flagStr(flags.cursor), limit: flagStr(flags.limit) })}`
  const r = await apiFetch('GET', path)
  if (json) { io.out(JSON.stringify(r)); return EXIT.ok }

  const pushes = r.pushes ?? []
  const jobs = r.jobs ?? []
  if (!pushes.length && !jobs.length) { io.out(`No jobs in ${repo}${flags.sha ? ` for ${sha7(flags.sha)}` : ''} yet.`); return EXIT.ok }

  // group by commit, newest first (by the highest push/job number touching it)
  const commits = new Map()
  const group = (sha) => { if (!commits.has(sha)) commits.set(sha, { sha, pushes: [], jobs: [], top: 0n }); return commits.get(sha) }
  for (const p of pushes) { const g = group(p.newSha); g.pushes.push(p); if (BigInt(p.qid) > g.top) g.top = BigInt(p.qid) }
  for (const j of jobs) { const g = group(j.commitSha); g.jobs.push(j); if (BigInt(j.qid) > g.top) g.top = BigInt(j.qid) }
  const ordered = [...commits.values()].sort((a, b) => (b.top > a.top ? 1 : b.top < a.top ? -1 : 0))
  const nameW = Math.max(4, ...jobs.map((j) => j.name.length))
  const qidW = Math.max(2, ...jobs.map((j) => String(j.qid).length))

  for (const g of ordered) {
    const ref = g.pushes[0]?.ref
    io.out(`${sha7(g.sha)}${ref ? `  ${branch(ref)}` : ''}`)
    for (const p of g.pushes) {
      io.out(p.admission === 'rejected'
        ? `  push ${p.qid} · not admitted: ${rejectionWords(p.rejectionCode)} · ${when(p.receivedAt)}`
        : `  push ${p.qid} · ${p.jobQIDs?.length ?? 0} job${p.jobQIDs?.length === 1 ? '' : 's'} · ${when(p.receivedAt)}`)
    }
    for (const j of g.jobs.sort((a, b) => a.name.localeCompare(b.name))) {
      io.out(`  ${pad(j.qid, qidW)}  ${pad(j.name, nameW)}  ${jobPhrase(j)}${j.required ? '' : '  (optional)'}`)
    }
  }
  if (r.nextCursor) io.out(`\nMore: qwirq jobs ${repo} --cursor ${r.nextCursor}${flags.sha ? ` --sha ${flags.sha}` : ''}${flags.state ? ` --state ${flags.state}` : ''}`)
  return EXIT.ok
}

// --- show ---

async function show(qid, json, io) {
  const r = await apiFetch('GET', JOB(qid))
  if (json) { io.out(JSON.stringify(r)); return EXIT.ok }
  const j = r.job
  io.out(`Job ${j.qid} · ${j.name} · ${stateWord(j.state)}${j.attempt ? ` · attempt ${j.attempt} of ${j.maxAttempts}` : ''}${j.cancelRequested && !TERMINAL.has(j.state) ? ' · cancel requested' : ''}`)
  io.out(`Commit ${j.commitSha} · repository ${j.repositoryQID}`)
  io.out(`Required: ${j.required ? 'yes' : 'no'}${j.labels?.length ? ` · labels: ${j.labels.join(', ')}` : ''}${j.needs?.length ? ` · needs: ${j.needs.join(', ')}` : ''}`)
  if (j.state === 'queued' && j.queuedReason) io.out(`Queued: ${queuedWords(j.queuedReason)} (since ${when(j.queuedReason.since)})`)
  io.out(`Queued ${when(j.queuedAt)} · started ${when(j.startedAt)} · finished ${when(j.finishedAt)}${j.exitCode !== null && j.exitCode !== undefined ? ` · exit ${j.exitCode}` : ''}`)
  if (j.failureReason) io.out(`Reason: ${j.failureReason}`)

  const attempts = r.attempts ?? []
  const current = attempts.find((a) => a.attempt === j.attempt) ?? attempts[attempts.length - 1]
  if (current?.steps?.length) {
    io.out(`\nSteps (attempt ${current.attempt}):`)
    const w = Math.max(...current.steps.map((s) => s.name.length))
    for (const s of current.steps) io.out(`  ${s.index + 1}. ${pad(s.name, w)}  ${stateWord(s.state)}${s.exitCode !== undefined && s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}`)
  } else {
    io.out(`\nSteps: ${(j.spec?.steps ?? []).map((s) => s.name).join(', ') || '—'}`)
  }
  if (attempts.length) {
    io.out('\nAttempts:')
    for (const a of attempts) {
      io.out(`  attempt ${a.attempt} · ${stateWord(a.state)} · started ${when(a.startedAt)}${a.finishedAt ? ` · finished ${when(a.finishedAt)}` : ''} · ${a.logLines} log line${a.logLines === 1 ? '' : 's'}${a.logTruncated ? ' (truncated)' : ''}`)
    }
  }
  const artifacts = r.artifacts ?? []
  if (artifacts.length) {
    io.out('\nArtifacts:')
    for (const a of artifacts) io.out(`  ${a.name} · ${a.kind} · ${bytes(a.sizeBytes)} · sha256 ${a.sha256} · attempt ${a.attempt}`)
  }
  const can = []
  if (r.permissions?.cancel) can.push(`cancel: qwirq jobs cancel ${j.qid} --attempt ${j.attempt}`)
  if (r.permissions?.retry) can.push(`retry: qwirq jobs retry ${j.qid} --attempt ${j.attempt}`)
  if (current) can.push(`log: qwirq jobs logs ${j.qid} --attempt ${current.attempt}${TERMINAL.has(j.state) ? '' : ' --follow'}`)
  if (can.length) { io.out('\nYou can:'); for (const c of can) io.out(`  ${c}`) }
  return EXIT.ok
}

// --- logs ---

/**
 * Read (and with --follow, keep reading) one job's log. The cursor is (attempt, after): duplicate or
 * overlapping pages are dropped by sequence, a reconnect resumes after the last line printed, and when
 * the followed attempt ends while the job moves on (lease lost, retry), follow switches to the new
 * attempt from sequence 1 — lines of different attempts never mix (each carries its attempt).
 * Following an attempt that does not exist yet (the job is still queued; the API 404s until a claim)
 * waits for the claim; a job that ends before reaching that attempt exits 1. Without --follow a 404
 * stays an error.
 */
async function logs(qid, firstAttempt, follow, json, io) {
  const { signal, release } = interruptible()
  const poll = POLL_MS || 500
  let attempt = firstAttempt
  let lastSeq = 0
  let truncatedSaid = false
  const onLost = (e) => io.err(`Connection lost (${e.transport ? 'unreachable' : e.code || e.status}); reconnecting… resuming attempt ${attempt} after line ${lastSeq}.`)
  const onBack = () => io.err('Reconnected.')
  const emitLine = (l) => {
    if (json) io.out(JSON.stringify({ type: 'line', jobQID: qid, attempt, seq: l.seq, at: l.at, step: l.step, stream: l.stream, text: l.text }))
    else io.out(l.stream === 'system' ? `${clock(l.at)}  -- ${l.text}` : `${clock(l.at)}  ${l.step}${l.stream === 'err' ? ' !' : ''}  ${l.text}`)
  }
  // follow only: the requested attempt 404'd. Poll the job until it reaches that attempt (-> null,
  // read the log) or ends without it (-> exit 1). A missing JOB still 404s out of pollGet (exit 2).
  let waitingSaid = false
  let rechecked = false
  const waitForAttempt = async (notFound) => {
    for (;;) {
      const { job } = await pollGet(JOB(qid), { signal, onLost, onBack })
      if (job.attempt >= attempt) {
        if (rechecked) throw notFound // the job has the attempt yet its log still 404s: a real not-found
        rechecked = true
        return null
      }
      if (TERMINAL.has(job.state)) {
        if (json) io.out(JSON.stringify({ type: 'end', jobQID: qid, attempt, state: job.state, attemptStarted: false }))
        else io.err(`Job ${qid} ${stateWord(job.state)} before attempt ${attempt} started; there is no log to follow.`)
        return EXIT.failed
      }
      if (!waitingSaid) {
        waitingSaid = true
        if (json) io.out(JSON.stringify({ type: 'waiting', jobQID: qid, attempt, state: job.state, currentAttempt: job.attempt, queuedReason: job.queuedReason ?? null }))
        else io.err(`Waiting for the job to start… (attempt ${attempt}; job is ${stateWord(job.state)}${job.state === 'queued' && job.queuedReason ? `: ${queuedWords(job.queuedReason)}` : ''})`)
      }
      await sleep(poll, signal)
    }
  }
  try {
    for (;;) {
      let page
      try {
        page = await pollGet(`${JOB(qid)}/log${qs({ attempt, after: lastSeq, limit: LOG_PAGE })}`, { signal, onLost, onBack })
      } catch (e) {
        if (!follow || e?.status !== 404) throw e
        const done = await waitForAttempt(e)
        if (done !== null) return done
        continue
      }
      rechecked = false
      if (page.attempt !== undefined && page.attempt !== attempt) throw new Error(`server answered attempt ${page.attempt} for a request about attempt ${attempt}`)
      for (const l of page.lines ?? []) {
        if (l.seq <= lastSeq) continue // duplicate / overlapping page
        emitLine(l)
        lastSeq = l.seq
      }
      if (typeof page.nextAfter === 'number' && page.nextAfter > lastSeq) lastSeq = page.nextAfter
      if (page.truncated && !truncatedSaid && !page.hasMore) {
        truncatedSaid = true
        if (json) io.out(JSON.stringify({ type: 'truncated', jobQID: qid, attempt }))
        else io.err(`(attempt ${attempt}'s log hit the 16 MiB limit; later output was not kept)`)
      }
      if (page.hasMore) continue
      if (!follow) {
        if (!page.terminal) io.err(`Attempt ${attempt} is still running. Keep reading with: qwirq jobs logs ${qid} --attempt ${attempt} --follow`)
        return EXIT.ok
      }
      if (!page.terminal) { await sleep(poll, signal); continue }

      // the followed attempt is over: has the job moved to a new attempt, or finished?
      const d = await pollGet(JOB(qid), { signal, onLost, onBack })
      const job = d.job
      if (job.attempt > attempt) {
        const prev = (d.attempts ?? []).find((a) => a.attempt === attempt)
        if (json) io.out(JSON.stringify({ type: 'attempt', jobQID: qid, attempt: job.attempt, previousAttempt: attempt, previousState: prev?.state ?? null }))
        else io.out(`--- attempt ${attempt} ${prev ? stateWord(prev.state) : 'ended'}; following attempt ${job.attempt} ---`)
        attempt = job.attempt
        lastSeq = 0
        truncatedSaid = false
        continue
      }
      if (TERMINAL.has(job.state)) {
        if (json) io.out(JSON.stringify({ type: 'end', jobQID: qid, attempt, state: job.state }))
        else io.err(`Job ${qid} ${stateWord(job.state)} (attempt ${attempt}).`)
        return NOT_SUCCESS.has(job.state) ? EXIT.failed : EXIT.ok
      }
      await sleep(poll, signal) // requeued, waiting for the next claim
    }
  } catch (e) {
    if (e instanceof Interrupted) { io.err('Stopped following. The job keeps running.'); return EXIT.interrupted }
    throw e
  } finally {
    release()
  }
}

// --- retry / cancel ---

async function retry(qid, expectedAttempt, json, io) {
  const r = await apiFetch('POST', `${JOB(qid)}/retry`, { body: { expectedAttempt } })
  if (json) { io.out(JSON.stringify(r)); return EXIT.ok }
  io.out(`Retrying job ${r.jobQID}: attempt ${r.nextAttempt} is queued (attempt ${r.previousAttempt} is kept).`)
  io.out(`Follow it with: qwirq jobs logs ${r.jobQID} --attempt ${r.nextAttempt} --follow`)
  return EXIT.ok
}

async function cancel(qid, expectedAttempt, json, io) {
  const r = await apiFetch('POST', `${JOB(qid)}/cancel`, { body: { expectedAttempt } })
  if (json) { io.out(JSON.stringify(r)); return EXIT.ok }
  if (r.cancelRequested) io.out(`Cancel requested for job ${r.jobQID} (attempt ${expectedAttempt}); its worker stops it on the next heartbeat.`)
  else io.out(`Cancelled job ${r.jobQID} (${stateWord(r.state)}).`)
  return EXIT.ok
}
