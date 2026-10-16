// `qwirq watch <repo> [--sha <sha>] [--json]` — watch one push's jobs to the end (M0-SPEC §6 WP8).
// The target (push + commit + its job numbers) is snapshotted at start; a later push never silently
// replaces it. The exit status is decided by REQUIRED jobs only (Foreman ruling): 1 when any required
// job ends failed, cancelled, timed out, or skipped (skipped = a dependency failed; same rule as the
// engine's repository status), or the push was not admitted; else 0 — an optional job's failure is
// reported but does not fail the watch. 2 on usage/auth/transport errors, 130 on Ctrl+C — which stops
// watching and never cancels a job.
import {
  EXIT, TERMINAL, NOT_SUCCESS, POLL_MS, UsageError, Interrupted, interruptible, sleep, pollGet, reportError,
  flagStr, qs, sha7, branch, jobPhrase, rejectionWords, stateWord, clock, stdio,
} from './pipeline-shared.mjs'

const USAGE = 'qwirq watch <repo> [--sha <sha>] [--json]'
// A required job in any of these fails the watch; `skipped` means a dependency failed.
const REQUIRED_FAIL = new Set([...NOT_SUCCESS, 'skipped'])
const PAGE = 200

/** Every job on one commit (all pages). */
async function jobsOn(repo, sha, opts) {
  const jobs = []
  let cursor
  let pushes = []
  for (;;) {
    const r = await pollGet(`/api/v1/pipeline/jobs${qs({ repo, sha, cursor, limit: PAGE })}`, opts)
    if (cursor === undefined) pushes = r.pushes ?? []
    jobs.push(...(r.jobs ?? []))
    if (!r.nextCursor) return { pushes, jobs, updatedAt: r.updatedAt }
    cursor = r.nextCursor
  }
}

export async function watchVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  const repo = positional[0]
  const { signal, release } = interruptible()
  const poll = POLL_MS || 1000
  const emit = (o) => io.out(JSON.stringify(o))
  const opts = {
    signal,
    onLost: (e) => io.err(`Connection lost (${e.transport ? 'unreachable' : e.code || e.status}); reconnecting…`),
    onBack: () => io.err('Reconnected.'),
  }
  try {
    if (!repo) throw new UsageError(`usage: ${USAGE}`)
    const wantSha = flagStr(flags.sha)
    if (flags.sha !== undefined && !wantSha) throw new UsageError(`--sha needs a commit. usage: ${USAGE}`)

    // --- snapshot the target ---
    const first = await pollGet(`/api/v1/pipeline/jobs${qs({ repo, sha: wantSha, limit: PAGE })}`, opts)
    const pushes = (first.pushes ?? []).filter((p) => !wantSha || p.newSha === wantSha)
    // with --sha, prefer the newest ADMITTED push of that commit; without, the newest push, period
    const push = wantSha ? (pushes.find((p) => p.admission === 'accepted') ?? pushes[0]) : pushes[0]
    if (!push && !(wantSha && first.jobs?.length)) {
      throw Object.assign(new Error(wantSha ? `no push of ${sha7(wantSha)} in ${repo}` : `no pushes in ${repo} yet`), { code: 'not_found' })
    }
    const sha = push?.newSha ?? wantSha
    if (push?.admission === 'rejected') {
      if (json) emit({ type: 'end', repo, pushQID: push.qid, commitSha: sha, outcome: 'rejected', rejectionCode: push.rejectionCode, jobs: [] })
      else io.out(`Push ${push.qid} (${sha7(sha)} on ${branch(push.ref)}) was not admitted: ${rejectionWords(push.rejectionCode)}. Nothing ran.`)
      return EXIT.failed
    }
    const watched = push?.jobQIDs?.length ? push.jobQIDs.map(String) : (first.jobs ?? []).filter((j) => j.commitSha === sha).map((j) => String(j.qid))
    if (json) emit({ type: 'target', repo, pushQID: push?.qid ?? null, commitSha: sha, ref: push?.ref ?? null, jobQIDs: watched })
    else io.out(`Watching ${push ? `push ${push.qid} · ` : ''}${sha7(sha)}${push ? ` on ${branch(push.ref)}` : ''} · ${watched.length} job${watched.length === 1 ? '' : 's'}. Ctrl+C stops watching; jobs keep running.`)

    // --- poll the commit, report changes of the watched jobs ---
    const seen = new Map() // qid -> "state|attempt|reason|cancel"
    let snapshot = first.nextCursor ? null : first
    for (;;) {
      const r = snapshot ?? await jobsOn(repo, sha, opts)
      snapshot = null
      const byQid = new Map((r.jobs ?? []).map((j) => [String(j.qid), j]))
      const current = watched.map((q) => byQid.get(q)).filter(Boolean)
      const nameW = Math.max(4, ...current.map((j) => j.name.length))
      for (const j of current) {
        const key = `${j.state}|${j.attempt}|${j.queuedReason?.code ?? ''}|${j.cancelRequested ? 1 : 0}`
        if (seen.get(String(j.qid)) === key) continue
        seen.set(String(j.qid), key)
        if (json) emit({ type: 'job', jobQID: String(j.qid), name: j.name, required: j.required, state: j.state, attempt: j.attempt, queuedReason: j.queuedReason ?? null, cancelRequested: !!j.cancelRequested, at: r.updatedAt ?? null })
        else io.out(`  ${clock(r.updatedAt)}  ${j.name.padEnd(nameW)}  ${jobPhrase(j)}`)
      }
      if (current.length === watched.length && current.every((j) => TERMINAL.has(j.state))) {
        const bad = current.filter((j) => j.required && REQUIRED_FAIL.has(j.state))
        const optionalBad = current.filter((j) => !j.required && NOT_SUCCESS.has(j.state))
        if (json) {
          emit({ type: 'end', repo, pushQID: push?.qid ?? null, commitSha: sha, outcome: bad.length ? 'failed' : 'succeeded',
            jobs: current.map((j) => ({ jobQID: String(j.qid), name: j.name, required: !!j.required, state: j.state, attempt: j.attempt })) })
        } else {
          const n = current.filter((j) => j.required).length
          if (!bad.length) io.out(`All ${n} required job${n === 1 ? '' : 's'} on ${sha7(sha)} succeeded.`)
          else io.out(`${bad.length} of ${n} required job${n === 1 ? '' : 's'} on ${sha7(sha)} did not succeed: ${bad.map((j) => `${j.name} ${stateWord(j.state)}`).join(', ')}.`)
          for (const j of optionalBad) io.out(`Optional check ${j.name} ${stateWord(j.state)} (does not fail the watch).`)
          for (const j of [...bad, ...optionalBad]) if (j.attempt > 0) io.out(`  log: qwirq jobs logs ${j.qid} --attempt ${j.attempt}`)
        }
        return bad.length ? EXIT.failed : EXIT.ok
      }
      await sleep(poll, signal)
    }
  } catch (e) {
    if (e instanceof Interrupted) { io.err('Stopped watching. Jobs keep running.'); return EXIT.interrupted }
    return reportError(e, { json, io })
  } finally {
    release()
  }
}
