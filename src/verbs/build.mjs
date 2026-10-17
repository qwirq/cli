// `qwirq build …` / `qwirq builds …` — Android builds over the human /api/v1/pipeline/builds routes (M12-SPEC §7).
//   build <repo> --target <name> --sha <sha> [--channel <name>] [--json]   request a build (fresh request UUID)
//   build show <buildQID> [--json]                                          inputs, checks, artifacts, releases
//   build retry <buildQID> [--json]                                         a new build + version code, same inputs
//   builds ls <repo> [--sha] [--target] [--cursor] [--json]                 recent builds, newest first
// Returns an exit code (EXIT). A replayed request (same UUID) answers the original build; the CLI never re-sends one.
import { apiFetch } from '../api.mjs'
import { EXIT, UsageError, flagStr, qs, sha7, stateWord, when, bytes, pad, stdio } from './pipeline-shared.mjs'
import { qidArg, channelArg, newRequestID, enc, printJSON, printBlockers, reportReleaseError } from './release-shared.mjs'

const USAGE = {
  request: 'qwirq build <repo> --target <name> --sha <sha> [--channel <name>] [--json]',
  show: 'qwirq build show <buildQID> [--json]',
  retry: 'qwirq build retry <buildQID> [--json]',
  list: 'qwirq builds ls <repo> [--sha <sha>] [--target <name>] [--cursor <qid>] [--json]',
}
const BUILD = (qid) => `/api/v1/pipeline/builds/${enc(qid)}`
const CHECK_WORDS = { passing: 'checks passing', pending: 'checks pending', failing: 'checks failing' }

export async function buildVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  try {
    const sub = positional[0]
    if (sub === 'show') return await show(qidArg(positional[1], 'build', USAGE.show), json, io)
    if (sub === 'retry') return await retry(qidArg(positional[1], 'build', USAGE.retry), json, io)
    if (!sub) throw new UsageError(`usage: ${USAGE.request}\n       ${USAGE.show}\n       ${USAGE.retry}\n       ${USAGE.list}`)
    return await request(sub, flags, json, io)
  } catch (e) {
    return reportReleaseError(e, { json, io })
  }
}

export async function buildsVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  try {
    const sub = positional[0]
    const repo = sub === 'ls' || sub === 'list' ? positional[1] : sub
    if (!repo) throw new UsageError(`usage: ${USAGE.list}`)
    return await list(repo, flags, json, io)
  } catch (e) {
    return reportReleaseError(e, { json, io })
  }
}

const versionWords = (b) => (b.versionCode !== null && b.versionCode !== undefined ? `version ${b.versionName ?? '?'} (code ${b.versionCode})` : 'version code pending')
const kindWords = (b) => (b.kind === 'forward-rollback' ? `forward roll-back of build ${b.rollbackOfBuildQID}` : b.retryOfBuildQID ? `retry of build ${b.retryOfBuildQID}` : 'normal')

function accepted(r, io) {
  const b = r.build
  io.out(`Build ${b.qid} ${stateWord(b.state)}${r.replayed ? ' (replayed: this request was already accepted)' : ''} · ${b.target} · ${sha7(b.commitSha)} · ${versionWords(b)}`)
  if (b.distributionBinding?.channelQID) io.out(`  bound to channel ${b.distributionBinding.channelQID}`)
  io.out(`  See it: qwirq build show ${b.qid}`)
  if (b.jobQID) io.out(`  Follow the build log: qwirq jobs logs ${b.jobQID} --attempt ${b.attempt || 1} --follow`)
  return EXIT.ok
}

// --- request ---

async function request(repo, flags, json, io) {
  const target = flagStr(flags.target)
  if (!target) throw new UsageError(`--target <name> is required. usage: ${USAGE.request}`)
  const sha = flagStr(flags.sha)
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new UsageError(`--sha needs the full 40-character commit (builds are pinned to an immutable commit). usage: ${USAGE.request}`)
  const channel = flags.channel === undefined ? null : channelArg(flags.channel, '--channel', USAGE.request)
  const body = { requestID: newRequestID(), repo, commitSha: sha.toLowerCase(), target, channel }
  const r = await apiFetch('POST', '/api/v1/pipeline/builds', { body })
  if (json) { printJSON(io, r); return EXIT.ok }
  return accepted(r, io)
}

// --- retry ---

async function retry(qid, json, io) {
  const r = await apiFetch('POST', `${BUILD(qid)}/retry`, { body: { requestID: newRequestID() } })
  if (json) { printJSON(io, r); return EXIT.ok }
  return accepted(r, io)
}

// --- show ---

async function show(qid, json, io) {
  const r = await apiFetch('GET', BUILD(qid))
  if (json) { printJSON(io, r); return EXIT.ok }
  const b = r.build
  io.out(`Build ${b.qid} · ${b.name ?? b.target} · ${stateWord(b.state)}${b.attempt ? ` · attempt ${b.attempt}` : ''}`)
  io.out(`Commit ${b.commitSha} · ${kindWords(b)}`)
  io.out(`${versionWords(b)[0].toUpperCase()}${versionWords(b).slice(1)}${b.applicationId ? ` · ${b.applicationId}` : ''}${b.runtimeVersion ? ` · runtime ${b.runtimeVersion}${b.runtimeSource ? ` (${b.runtimeSource})` : ''}` : ''}`)
  if (b.signingCertSha256) io.out(`Signing cert sha256 ${b.signingCertSha256}`)
  if (b.distributionBinding?.channelQID) io.out(`Bound to channel ${b.distributionBinding.channelQID}`)
  io.out(`Requested ${when(b.createdAt)} · finished ${when(b.finishedAt)}`)
  if (b.failureReason) io.out(`Reason: ${b.failureReason}`)

  const checks = r.checks
  if (checks) {
    io.out(`\nChecks: ${CHECK_WORDS[checks.state] ?? checks.state ?? '—'}${checks.checkSetQID ? ` (check set ${checks.checkSetQID})` : ''}`)
    printBlockers(io, checks.blockers, 'Not releasable yet:')
  }
  if (r.job) io.out(`\nJob ${r.job.qid} · ${stateWord(r.job.state)}${r.job.attempt ? ` · log: qwirq jobs logs ${r.job.qid} --attempt ${r.job.attempt}` : ''}`)
  const artifacts = r.artifacts ?? []
  if (artifacts.length) {
    io.out('\nArtifacts:')
    for (const a of artifacts) io.out(`  ${a.name ?? a.qid} · ${a.kind ?? 'file'} · ${bytes(a.sizeBytes)} · sha256 ${a.sha256}`)
  }
  const releases = r.releases ?? []
  io.out(releases.length ? '\nReleased:' : '\nNot released to any channel yet.')
  for (const l of releases) io.out(`  ${l.channelName} #${l.publicationSeq} · release ${l.releaseQID}${l.current ? ' (current)' : ''}`)
  if (b.state === 'succeeded' && !releases.length) io.out(`  Preview a release: qwirq release preview <repo> --channel <name> --build ${b.qid}`)
  return EXIT.ok
}

// --- list ---

async function list(repo, flags, json, io) {
  const path = `/api/v1/pipeline/builds${qs({ repo, sha: flagStr(flags.sha), target: flagStr(flags.target), cursor: flagStr(flags.cursor), limit: flagStr(flags.limit) })}`
  const r = await apiFetch('GET', path)
  if (json) { printJSON(io, r); return EXIT.ok }
  const builds = r.builds ?? []
  if (!builds.length) { io.out(`No builds in ${repo} yet. Request one: ${USAGE.request.replace('<repo>', repo)}`); return EXIT.ok }
  const qidW = Math.max(2, ...builds.map((b) => String(b.qid).length))
  for (const b of builds) {
    const v = r.verification?.[b.qid]
    const rel = (r.releases?.[b.qid] ?? []).map((l) => `${l.channelName}${l.current ? '*' : ''}`)
    io.out(`${pad(b.qid, qidW)}  ${sha7(b.commitSha)}  ${pad(b.name ?? b.target, 12)}  ${pad(stateWord(b.state), 10)}  ${versionWords(b)}${v ? ` · ${CHECK_WORDS[v.state] ?? v.state}` : ''}${rel.length ? ` · released: ${rel.join(', ')}` : ''}`)
  }
  if (r.nextCursor) io.out(`\nMore: qwirq builds ls ${repo} --cursor ${r.nextCursor}`)
  return EXIT.ok
}
