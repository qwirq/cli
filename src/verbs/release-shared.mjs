// Shared plumbing for the M2 build/release/channel verbs (M12-SPEC §7, UX §7.7): flag validation, channel
// resolution by name, release-specific error words, the signed-URL guard, and the durable-request wait.
// Exit codes are pipeline-shared's EXIT, unchanged: 0 ok; 1 the publication/recovery you waited on did not
// publish; 2 usage/auth/permission/not-found/conflict/transport; 130 Ctrl+C (stops watching, never publication).
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { apiFetch } from '../api.mjs'
import { readStdin } from '../util.mjs'
import { EXIT, POLL_MS, UsageError, Interrupted, interruptible, sleep, pollGet, reportError, flagStr, qs, sha7, clock, stdio } from './pipeline-shared.mjs'

export const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/
export const newRequestID = () => randomUUID()
export const enc = encodeURIComponent

/** A positional QID (build, release, request, recovery): decimal digits. */
export function qidArg(v, what, usage) {
  if (!v || !/^\d+$/.test(v)) throw new UsageError(`expected a ${what} number. usage: ${usage}`)
  return v
}

/** A channel name, validated client-side so a typo never reaches the server. */
export function channelArg(v, flag, usage) {
  if (typeof v !== 'string' || !v) throw new UsageError(`${flag} <channel> is required. usage: ${usage}`)
  if (!CHANNEL_RE.test(v)) throw new UsageError(`"${v}" is not a channel name (lowercase letter, then up to 31 of a-z 0-9 -). usage: ${usage}`)
  return v
}

/** `--expected-revision <n>`: required non-negative integer (the channel revision your preview showed). */
export function revisionFlag(flags, usage, { required = true } = {}) {
  const raw = flags['expected-revision']
  if (raw === undefined || raw === true) {
    if (required) throw new UsageError(`--expected-revision <n> is required (the revision \`qwirq release preview\` / \`qwirq channel list\` showed). usage: ${usage}`)
    return undefined
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--expected-revision must be an integer >= 0, got "${raw}". usage: ${usage}`)
  return n
}

/** `--expected-current <qid|none>`: the release the channel serves now; `none` → null (nothing published yet). */
export function currentFlag(flags, usage, { required = true } = {}) {
  const raw = flags['expected-current']
  if (raw === undefined || raw === true) {
    if (required) throw new UsageError(`--expected-current <releaseQID|none> is required (the current release your preview showed). usage: ${usage}`)
    return undefined
  }
  if (raw === 'none') return null
  if (!/^\d+$/.test(String(raw))) throw new UsageError(`--expected-current must be a release number or "none", got "${raw}". usage: ${usage}`)
  return String(raw)
}

/** Release notes from `--notes-file <path>` or `--stdin` (markdown); '' when neither is given. */
export async function notesFrom(flags, usage) {
  const file = flags['notes-file']
  if (file !== undefined && flags.stdin) throw new UsageError(`use --notes-file or --stdin, not both. usage: ${usage}`)
  if (file !== undefined) {
    if (!flagStr(file)) throw new UsageError(`--notes-file needs a path. usage: ${usage}`)
    try { return readFileSync(file, 'utf8') } catch (e) { throw new UsageError(`can't read notes file ${file} (${e.code || e.message})`) }
  }
  if (flags.stdin) return readStdin()
  return ''
}

// --- channels ---

export const channelsPath = (repo) => `/api/v1/projects/${enc(repo)}/channels${qs({ platform: 'android' })}`

/** `{channels, links}` of a repository. */
export const listChannels = (repo) => apiFetch('GET', channelsPath(repo))

/** Resolve `<repo> + <channel name>` → `{channel, links, all}`; not_found (exit 2) when the name is unknown. */
export async function resolveChannel(repo, name) {
  const r = await listChannels(repo)
  const channel = (r.channels ?? []).find((c) => c.name === name)
  if (!channel) {
    const names = (r.channels ?? []).map((c) => c.name)
    throw Object.assign(new Error(`no channel "${name}" in ${repo}${names.length ? ` (channels: ${names.join(', ')})` : ' (it has no channels yet)'}`), { code: 'not_found' })
  }
  return { channel, links: r.links?.[channel.qid] ?? null, all: r }
}

// --- signed URLs never leave the CLI (M12 §7): any string carrying a `g=` grant is withheld ---

const SIGNED = /^https?:\/\/\S*[?&]g=/i
export function scrubSigned(v) {
  if (typeof v === 'string') return SIGNED.test(v) ? null : v
  if (Array.isArray(v)) return v.map(scrubSigned)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubSigned(x)]))
  return v
}
export const printJSON = (io, o) => io.out(JSON.stringify(scrubSigned(o)))

// --- words ---

/** A version-ish value in words: "1.2.0 (code 222)", a build, or "nothing". */
export function verWords(x) {
  if (x === null || x === undefined) return 'nothing'
  if (typeof x !== 'object') return String(x)
  const parts = []
  if (x.versionName) parts.push(x.versionName)
  if (x.versionCode !== undefined && x.versionCode !== null) parts.push(`(code ${x.versionCode})`)
  if (x.buildQID) parts.push(`build ${x.buildQID}`)
  if (x.releaseQID) parts.push(`release ${x.releaseQID}`)
  if (x.sha256 && !parts.length) parts.push(`sha256 ${String(x.sha256).slice(0, 12)}`)
  return parts.join(' ') || JSON.stringify(x)
}

/** One preview effect in plain words (UX §2: what will happen, never a bare code). */
export function effectWords(e) {
  switch (e?.type) {
    case 'native': return e.changed ? `Native app: ${verWords(e.from)} → ${verWords(e.to)} (phones install an update)` : `Native app: unchanged (${verWords(e.to ?? e.from)})`
    case 'content': return `Content${e.runtime ? ` for runtime ${e.runtime}` : ''}: ${verWords(e.from)} → ${verWords(e.to)}`
    case 'production_audience': return 'Production: everyone with access to this channel gets it.'
    case 'auto_publish_pauses': return 'Auto-publish on this channel pauses, so the next push does not replace this release.'
    case 'forward_rollback': return `Forward roll-back: rebuilds commit ${sha7(e.rebuildsCommit)} with a higher version code${e.currentKeepsServing ? '; the current release keeps serving until the rebuild is published' : ''}.`
    default: return e?.type ?? String(e)
  }
}

export const blockerWords = (b) => `${b.reason || b.code}${b.slot ? ` (${b.slot})` : ''}${b.buildQID ? ` · build ${b.buildQID}` : ''} [${b.code}]`

export function printBlockers(io, blockers, heading = 'Blockers:') {
  if (!blockers?.length) return
  io.out(heading)
  for (const b of blockers) io.out(`  - ${blockerWords(b)}`)
}

/** The channel's state on one line: current release, auto-publish, revision. */
export function channelLine(c) {
  const rel = c.currentRelease
  const native = rel?.entries?.find((x) => x.role === 'native') ?? rel?.entries?.[0]
  const current = rel
    ? `release ${rel.qid}${native ? ` · ${verWords({ versionName: native.versionName, versionCode: native.versionCode })} · build ${native.buildQID}` : ''}`
    : (c.currentReleaseQID ? `release ${c.currentReleaseQID}` : 'nothing published yet')
  const ap = c.autoPublish ?? {}
  const auto = ap.state === 'paused' ? `auto-publish paused${ap.pausedByUserQID ? ` by user ${ap.pausedByUserQID}` : ''}` : `auto-publish ${ap.state ?? 'off'}${ap.state === 'on' && ap.ref ? ` (${ap.ref})` : ''}`
  return `${c.name}${c.production ? ' (production)' : ''} · ${current} · ${auto} · revision ${c.revision}`
}

// --- errors ---

/**
 * Release-aware error report. stale_channel and publication_forbidden get plain words (and are never
 * retried); 409 blockers are listed. Everything else is pipeline-shared's reportError. Exit 2.
 */
export function reportReleaseError(e, { json = false, io = stdio, hint } = {}) {
  const code = e?.code
  const body = e?.body ?? {}
  let msg = null
  if (code === 'stale_channel') {
    const d = body.detail
    msg = `the channel moved since your preview${d ? ` (it now serves ${d.currentReleaseQID ? `release ${d.currentReleaseQID}` : 'nothing'} at revision ${d.revision})` : ''}; re-run preview and decide again. Nothing was published.${hint ? ` ${hint}` : ''}`
  } else if (code === 'publication_forbidden') {
    msg = `agent tokens can't publish, recover, or change channel settings; a person has to run this (a repository owner, or manage access for a non-production channel). Nothing was changed.`
  } else if (code === 'recovery_stale') {
    msg = `${e.message}. The channel moved; re-run \`qwirq release again\` with the current snapshot.`
  } else if (code === 'lower_version_code' && body.detail?.use === 'recover') {
    msg = `${e.message}. Phones refuse a lower version code; \`qwirq release again\` rebuilds it forward instead.`
  }
  if (msg === null && !body.blockers?.length && !body.detail) return reportError(e, { json, io })
  if (msg === null) msg = e.message // a 409/400 carrying blockers or detail: server words + the extras below
  if (json) {
    io.err(JSON.stringify(scrubSigned({ code, status: e?.status ?? null, message: msg, ...(body.detail ? { detail: body.detail } : {}), ...(body.blockers ? { blockers: body.blockers } : {}) })))
  } else {
    io.err(`error: ${msg} [${code}]`)
    for (const b of body.blockers ?? []) io.err(`  - ${blockerWords(b)}`)
  }
  return EXIT.error
}

// --- the durable wait (publish / again / recover): follows the server's request, never cancels it ---

const REQ_DONE = new Set(['published', 'rejected'])
const REC_DONE = new Set(['published', 'stale', 'failed'])
const REQ_WORDS = { pending_verification: 'pending verification (checking every artifact)', published: 'published', rejected: 'rejected' }
const REC_WORDS = { building: 'rebuilding', awaiting_compatibility: 'checking compatibility with the installed app', publishing: 'publishing', published: 'published', stale: 'stale (the channel moved)', failed: 'failed' }

function rejectedWords(io, request) {
  const r = request.rejection ?? {}
  io.out(`Not published: ${r.code === 'stale_channel' ? 'the channel moved before verification finished; re-run preview and decide again' : r.message || r.code || 'rejected'}${r.code ? ` [${r.code}]` : ''}.`)
  printBlockers(io, r.blockers)
}

/**
 * Poll a release request until published (exit 0) or rejected (exit 1). `first` is the POST/GET response
 * already in hand; a terminal one (replayed) returns without polling. Ctrl+C → exit 130, request untouched.
 */
export async function waitRequest(first, { json, io, label = '' }) {
  const { signal, release } = interruptible()
  const poll = POLL_MS || 1000
  let request = first.request
  const opts = { signal, onLost: (e) => io.err(`Connection lost (${e.transport ? 'unreachable' : e.code || e.status}); reconnecting…`), onBack: () => io.err('Reconnected.') }
  try {
    let last = request.state
    if (!json && !REQ_DONE.has(request.state)) {
      io.out(`  ${clock()}  ${REQ_WORDS[request.state] ?? request.state}`)
      io.out('  Ctrl+C stops watching; publication continues.')
    }
    while (!REQ_DONE.has(request.state)) {
      await sleep(poll, signal)
      const r = await pollGet(`/api/v1/release-requests/${enc(request.qid)}`, opts)
      request = r.request
      if (request.state === last) continue
      last = request.state
      if (json) printJSON(io, r)
      else if (!REQ_DONE.has(request.state)) io.out(`  ${clock()}  ${REQ_WORDS[request.state] ?? request.state}`)
    }
    if (request.state === 'published') {
      if (!json) io.out(`Published: release ${request.resultReleaseQID} is now current${label ? ` on ${label}` : ''}.`)
      return EXIT.ok
    }
    if (!json) rejectedWords(io, request)
    return EXIT.failed
  } catch (e) {
    if (e instanceof Interrupted) return interrupted(io, json, { requestQID: request.qid }, `qwirq release wait ${request.qid}`)
    throw e
  } finally {
    release()
  }
}

/**
 * Poll a recovery (forward roll-back) until it publishes or ends; once it has a publication request,
 * follow that request. published → 0; stale/failed/rejected → 1; Ctrl+C → 130, nothing cancelled.
 */
export async function waitRecovery(first, { json, io, label = '' }) {
  const { signal, release } = interruptible()
  const poll = POLL_MS || 1000
  let recovery = first.recovery
  const opts = { signal, onLost: (e) => io.err(`Connection lost (${e.transport ? 'unreachable' : e.code || e.status}); reconnecting…`), onBack: () => io.err('Reconnected.') }
  let handedOff = false
  try {
    let last = `${recovery.state}|${recovery.publicationRequestQID ?? ''}`
    if (!json && !REC_DONE.has(recovery.state)) {
      io.out(`  ${clock()}  ${REC_WORDS[recovery.state] ?? recovery.state}${recovery.buildQID ? ` (build ${recovery.buildQID})` : ''}`)
      io.out('  Ctrl+C stops watching; the recovery continues.')
    }
    while (!REC_DONE.has(recovery.state) && !recovery.publicationRequestQID) {
      await sleep(poll, signal)
      const r = await pollGet(`/api/v1/recoveries/${enc(recovery.qid)}`, opts)
      recovery = r.recovery
      const key = `${recovery.state}|${recovery.publicationRequestQID ?? ''}`
      if (key === last) continue
      last = key
      if (json) printJSON(io, r)
      else if (!REC_DONE.has(recovery.state)) io.out(`  ${clock()}  ${REC_WORDS[recovery.state] ?? recovery.state}${r.build ? ` (build ${r.build.qid}: ${r.build.state})` : ''}`)
    }
    if (recovery.state === 'published' && !recovery.publicationRequestQID) {
      if (!json) io.out(`Published: release ${recovery.resultReleaseQID} is now current${label ? ` on ${label}` : ''}.`)
      return EXIT.ok
    }
    if (recovery.state === 'stale' || recovery.state === 'failed') {
      if (!json) io.out(`Recovery ${recovery.qid} ${REC_WORDS[recovery.state]}${recovery.stateCode ? ` [${recovery.stateCode}]` : ''}. Nothing was published${recovery.state === 'stale' ? '; re-run `qwirq release again` with the current snapshot' : ''}.`)
      return EXIT.failed
    }
    // hand off to the publication request
    handedOff = true
    if (!json) io.out(`  ${clock()}  publication request ${recovery.publicationRequestQID}`)
    const r = await pollGet(`/api/v1/release-requests/${enc(recovery.publicationRequestQID)}`, opts)
    if (json) printJSON(io, r)
    return await waitRequest(r, { json, io, label }) // its own Ctrl+C handler answers from here on
  } catch (e) {
    if (e instanceof Interrupted) {
      return handedOff
        ? interrupted(io, json, { requestQID: recovery.publicationRequestQID }, `qwirq release wait ${recovery.publicationRequestQID}`)
        : interrupted(io, json, { recoveryQID: recovery.qid }, `qwirq release wait --recovery ${recovery.qid}`)
    }
    throw e
  } finally {
    release()
  }
}

function interrupted(io, json, ids, resume) {
  const what = ids.requestQID ? `request ${ids.requestQID}` : `recovery ${ids.recoveryQID}`
  if (json) io.err(JSON.stringify({ code: 'interrupted', status: null, message: `stopped watching ${what}; it continues on the server`, ...ids, resume }))
  else io.err(`Stopped watching. Publication continues on the server (${what}). Resume watching: ${resume}`)
  return EXIT.interrupted
}

/** The auto-publish pause notice after a release-again / recover. */
export function pauseNotice(io, channelName, repo) {
  io.out(`Auto-publish on ${channelName} is paused so the next push does not replace this roll-back.`)
  io.out(`  Resume it when ready: qwirq channel resume ${repo ?? '<repo>'} ${channelName} --expected-revision <n>  (n: qwirq channel list ${repo ?? '<repo>'})`)
}
