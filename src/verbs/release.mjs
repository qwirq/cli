// `qwirq release …` — channel publication over the human /api/v1 release routes (M12-SPEC §7, UX §7.7).
//   release list <repo> [--channel <name>] [--json]          published history, current marked
//   release show <releaseQID> [--json]                       every entry's origin: build, commit, version, sha256, cert
//   release preview <repo> --channel <c> --build <b>         effects in words + blockers + the snapshot to publish against
//   release publish <repo> --channel <c> --build <b> --expected-current <qid|none> --expected-revision <n>
//                   [--notes-file <path> | --stdin] [--no-wait] [--json]
//   release promote <repo> --from <c> --to <c> [--source <releaseQID> --expected-current … --expected-revision …]   (without them: preview, refuse)
//   release again <releaseQID> --expected-current <qid> --expected-revision <n> [--notes-file] [--no-wait]
//   release wait <requestQID> | --recovery <recoveryQID>     follow a request already made
// The expected snapshot is the human's decision: the CLI never refreshes it, never retries a stale_channel.
// Publish waits follow the durable request; Ctrl+C stops watching (exit 130) and never cancels publication.
import { apiFetch } from '../api.mjs'
import { EXIT, UsageError, flagStr, qs, sha7, when, bytes, pad, stdio } from './pipeline-shared.mjs'
import {
  qidArg, channelArg, revisionFlag, currentFlag, notesFrom, newRequestID, enc, resolveChannel, listChannels,
  printJSON, effectWords, printBlockers, verWords, reportReleaseError, waitRequest, waitRecovery, pauseNotice,
} from './release-shared.mjs'

const USAGE = {
  list: 'qwirq release list <repo> [--channel <name>] [--json]',
  show: 'qwirq release show <releaseQID> [--json]',
  preview: 'qwirq release preview <repo> --channel <name> --build <buildQID> [--json]',
  publish: 'qwirq release publish <repo> --channel <name> --build <buildQID> --expected-current <qid|none> --expected-revision <n> [--notes-file <path> | --stdin] [--no-wait] [--json]',
  promote: 'qwirq release promote <repo> --from <channel> --to <channel> [--source <releaseQID> --expected-current <qid|none> --expected-revision <n>] [--notes-file <path> | --stdin] [--no-wait] [--json]',
  again: 'qwirq release again <releaseQID> --expected-current <qid> --expected-revision <n> [--notes-file <path> | --stdin] [--no-wait] [--json]',
  wait: 'qwirq release wait <requestQID> | --recovery <recoveryQID> [--json]',
}
const ALL = Object.values(USAGE).join('\n       ')

export async function releaseVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  const sub = positional[0]
  const ctx = { hint: undefined }
  try {
    if (sub === 'list' || sub === 'ls') return await list(positional[1], flags, json, io)
    if (sub === 'show') return await show(qidArg(positional[1], 'release', USAGE.show), json, io)
    if (sub === 'preview') return await preview(positional[1], flags, json, io)
    if (sub === 'publish') return await publish(positional[1], flags, json, io, ctx)
    if (sub === 'promote') return await promote(positional[1], flags, json, io, ctx)
    if (sub === 'again') return await again(qidArg(positional[1], 'release', USAGE.again), flags, json, io, ctx)
    if (sub === 'wait') return await wait(positional[1], flags, json, io)
    throw new UsageError(`usage: ${ALL}`)
  } catch (e) {
    return reportReleaseError(e, { json, io, hint: ctx.hint })
  }
}

const opWords = (op) => String(op ?? 'publish').replace(/_/g, ' ')
const nativeOf = (rel) => rel?.entries?.find((x) => x.role === 'native') ?? rel?.entries?.[0]
const repoArg = (repo, usage) => { if (!repo) throw new UsageError(`usage: ${usage}`); return repo }
const buildFlag = (flags, usage) => {
  const b = flags.build
  if (b === undefined || b === true) throw new UsageError(`--build <buildQID> is required. usage: ${usage}`)
  if (!/^\d+$/.test(String(b))) throw new UsageError(`--build must be a build number, got "${b}". usage: ${usage}`)
  return String(b)
}
const snapshotFlags = (cur, rev) => `--expected-current ${cur ?? 'none'} --expected-revision ${rev}`

// --- list / show ---

async function list(repo, flags, json, io) {
  repoArg(repo, USAGE.list)
  const channel = flags.channel === undefined ? undefined : channelArg(flags.channel, '--channel', USAGE.list)
  const r = await apiFetch('GET', `/api/v1/projects/${enc(repo)}/releases${qs({ channel, cursor: flagStr(flags.cursor), limit: flagStr(flags.limit) })}`)
  if (json) { printJSON(io, r); return EXIT.ok }
  const releases = r.releases ?? []
  if (!releases.length) { io.out(`No releases in ${repo}${channel ? ` on ${channel}` : ''} yet.`); return EXIT.ok }
  const qidW = Math.max(2, ...releases.map((x) => String(x.qid).length))
  for (const rel of releases) {
    const n = nativeOf(rel)
    io.out(`${pad(rel.qid, qidW)}  ${channel ?? `channel ${rel.channelQID}`} #${rel.publicationSeq} · ${opWords(rel.operation)}${n ? ` · ${verWords({ versionName: n.versionName, versionCode: n.versionCode })} · build ${n.buildQID}` : ''} · ${when(rel.publishedAt)}${rel.current ? '  (current)' : ''}`)
  }
  if (r.nextCursor) io.out(`\nMore: qwirq release list ${repo}${channel ? ` --channel ${channel}` : ''} --cursor ${r.nextCursor}`)
  return EXIT.ok
}

async function show(qid, json, io) {
  const r = await apiFetch('GET', `/api/v1/releases/${enc(qid)}`)
  if (json) { printJSON(io, r); return EXIT.ok }
  const rel = r.release
  const ch = r.channel ?? {}
  io.out(`Release ${rel.qid} · ${ch.name ?? `channel ${rel.channelQID}`} #${rel.publicationSeq}${ch.production ? ' (production)' : ''} · ${opWords(rel.operation)}${rel.current ? ' · current' : ''}`)
  io.out(`Published ${when(rel.publishedAt)} by ${rel.actor?.kind ?? 'user'} ${rel.actor?.qid ?? '?'}${rel.previousReleaseQID ? ` · replaced release ${rel.previousReleaseQID}` : ''}${rel.sourceReleaseQID ? ` · from release ${rel.sourceReleaseQID}` : ''}${rel.recoveryQID ? ` · recovery ${rel.recoveryQID}` : ''}`)
  if (rel.setSha256) io.out(`Set sha256 ${rel.setSha256}`)
  const notes = String(rel.notesMd ?? '').trim()
  if (notes) { io.out('Notes:'); for (const l of notes.split(/\r?\n/)) io.out(`  ${l}`) }
  io.out('Entries:')
  for (const e of rel.entries ?? []) {
    io.out(`  ${e.role}${e.slot ? ` ${e.slot}` : ''} · build ${e.buildQID} · commit ${e.commitSha}${e.carriedFromReleaseQID ? ` · carried from release ${e.carriedFromReleaseQID}` : ''}`)
    io.out(`    ${e.applicationId ? `${e.applicationId} ` : ''}${verWords({ versionName: e.versionName, versionCode: e.versionCode })}${e.runtimeVersion ? ` · runtime ${e.runtimeVersion}${e.runtimeSource ? ` (${e.runtimeSource})` : ''}` : ''}${e.imageName ? ` · image ${e.imageName}` : ''}`)
    io.out(`    sha256 ${e.sha256} · ${bytes(e.sizeBytes)}${e.signingCertSha256 ? ` · cert sha256 ${e.signingCertSha256}` : ''}`)
  }
  return EXIT.ok
}

// --- preview ---

function printPreview(io, p, { what, next }) {
  io.out(`Preview: ${what}`)
  if (p.stale) io.out('  The channel moved since the snapshot you passed; what follows is the current state.')
  if (p.effects?.length) { io.out('Effects:'); for (const e of p.effects) io.out(`  - ${effectWords(e)}`) }
  if (p.blockers?.length) printBlockers(io, p.blockers, 'Not releasable:')
  else io.out(p.releasable === false ? 'Not releasable.' : 'Releasable: yes.')
  const cur = p.channel?.currentReleaseQID ?? null
  io.out(`Channel now: ${cur ? `release ${cur}` : 'nothing published'} · revision ${p.channel?.revision}`)
  if (next && p.releasable !== false && !p.blockers?.length) io.out(`Publish exactly this with:\n  ${next(snapshotFlags(cur, p.channel?.revision))}`)
}

async function preview(repo, flags, json, io) {
  repoArg(repo, USAGE.preview)
  const name = channelArg(flags.channel, '--channel', USAGE.preview)
  const buildQID = buildFlag(flags, USAGE.preview)
  const expectedCurrentReleaseQID = currentFlag(flags, USAGE.preview, { required: false })
  const expectedChannelRevision = revisionFlag(flags, USAGE.preview, { required: false })
  const { channel } = await resolveChannel(repo, name)
  const p = await apiFetch('POST', `/api/v1/channels/${enc(channel.qid)}/preview`, { body: { buildQID, expectedCurrentReleaseQID, expectedChannelRevision } })
  if (json) { printJSON(io, p); return EXIT.ok }
  printPreview(io, p, { what: `build ${buildQID} → ${name}`, next: (snap) => `qwirq release publish ${repo} --channel ${name} --build ${buildQID} ${snap} [--notes-file <path>]` })
  return EXIT.ok
}

// --- publish / promote ---

function acceptedLine(io, r, what) {
  io.out(`Publication request ${r.request.qid} accepted${r.replayed ? ' (replayed: this request was already made; showing its outcome)' : ''} · ${what}`)
}

async function follow(r, { json, io, label, noWait }) {
  if (noWait) {
    if (!json) io.out(`  Not waiting. Watch it: qwirq release wait ${r.request.qid}`)
    return EXIT.ok
  }
  return waitRequest(r, { json, io, label })
}

async function publish(repo, flags, json, io, ctx) {
  repoArg(repo, USAGE.publish)
  const name = channelArg(flags.channel, '--channel', USAGE.publish)
  const buildQID = buildFlag(flags, USAGE.publish)
  const expectedCurrentReleaseQID = currentFlag(flags, USAGE.publish)
  const expectedChannelRevision = revisionFlag(flags, USAGE.publish)
  const notesMd = await notesFrom(flags, USAGE.publish)
  ctx.hint = `Re-run: qwirq release preview ${repo} --channel ${name} --build ${buildQID}`
  const { channel } = await resolveChannel(repo, name)
  const r = await apiFetch('POST', `/api/v1/channels/${enc(channel.qid)}/publish`, {
    body: { requestID: newRequestID(), buildQID, notesMd, expectedCurrentReleaseQID, expectedChannelRevision },
  })
  if (json) printJSON(io, r)
  else acceptedLine(io, r, `build ${buildQID} → ${name}`)
  return follow(r, { json, io, label: name, noWait: !!flags['no-wait'] })
}

async function promote(repo, flags, json, io, ctx) {
  repoArg(repo, USAGE.promote)
  const from = channelArg(flags.from, '--from', USAGE.promote)
  const to = channelArg(flags.to, '--to', USAGE.promote)
  if (from === to) throw new UsageError(`--from and --to name the same channel. usage: ${USAGE.promote}`)
  const expectedCurrentReleaseQID = currentFlag(flags, USAGE.promote, { required: false })
  const expectedChannelRevision = revisionFlag(flags, USAGE.promote, { required: false })
  // the reviewed source release is frozen in the confirmation: never "whatever --from serves now"
  const frozenSource = flags.source === undefined || flags.source === true ? undefined : String(flags.source)
  if (frozenSource !== undefined && !/^\d+$/.test(frozenSource)) throw new UsageError(`--source must be a release number, got "${frozenSource}". usage: ${USAGE.promote}`)
  const decided = expectedCurrentReleaseQID !== undefined && expectedChannelRevision !== undefined && frozenSource !== undefined
  const notesMd = decided ? await notesFrom(flags, USAGE.promote) : ''

  const all = await listChannels(repo)
  const find = (n) => (all.channels ?? []).find((c) => c.name === n)
  const src = find(from)
  const dst = find(to)
  for (const [n, c] of [[from, src], [to, dst]]) if (!c) throw Object.assign(new Error(`no channel "${n}" in ${repo}`), { code: 'not_found' })
  const servedNow = src.currentReleaseQID
  if (!decided && !servedNow) throw Object.assign(new Error(`nothing is published on ${from} yet; there is no release to promote`), { code: 'no_published_release' })
  const sourceReleaseQID = decided ? frozenSource : servedNow
  ctx.hint = `Re-run: qwirq release promote ${repo} --from ${from} --to ${to}`
  if (decided && servedNow !== frozenSource) {
    // the source channel moved since the preview: refuse rather than promote something nobody reviewed
    const message = `${from} now serves ${servedNow ? `release ${servedNow}` : 'nothing'}, not release ${frozenSource} you reviewed; nothing was published. Re-run the preview: qwirq release promote ${repo} --from ${from} --to ${to}`
    if (json) io.err(JSON.stringify({ code: 'source_changed', status: null, message, reviewed: frozenSource, current: servedNow ?? null }))
    else io.err(`error: ${message} [source_changed]`)
    return EXIT.failed
  }

  if (!decided) {
    // Show what promoting would do and the snapshot it would be decided against; never publish on a guess.
    const p = await apiFetch('POST', `/api/v1/channels/${enc(dst.qid)}/preview`, { body: { sourceReleaseQID } })
    if (json) printJSON(io, p)
    else printPreview(io, p, { what: `release ${sourceReleaseQID} (current on ${from}) → ${to}`, next: (snap) => `qwirq release promote ${repo} --from ${from} --to ${to} --source ${sourceReleaseQID} ${snap} [--notes-file <path>]` })
    const message = 'promote publishes only what you reviewed: re-run with --source, --expected-current and --expected-revision from the preview above'
    if (json) io.err(JSON.stringify({ code: 'expected_snapshot_required', status: null, message }))
    else io.err(`error: ${message} [expected_snapshot_required]`)
    return EXIT.error
  }

  const r = await apiFetch('POST', `/api/v1/channels/${enc(dst.qid)}/publish`, {
    body: { requestID: newRequestID(), sourceReleaseQID, notesMd, expectedCurrentReleaseQID, expectedChannelRevision },
  })
  if (json) printJSON(io, r)
  else acceptedLine(io, r, `release ${sourceReleaseQID} from ${from} → ${to}`)
  return follow(r, { json, io, label: to, noWait: !!flags['no-wait'] })
}

// --- release again (roll-back): republish / content roll-back, or a forward roll-back via /recover ---

const MODE_WORDS = { republish: 'republish the same artifacts as a new publication', content_rollback: 'content roll-back (a new publication of the earlier content)', forward_rollback: 'forward roll-back (rebuild the earlier commit with a higher version code)' }

async function again(targetReleaseQID, flags, json, io, ctx) {
  const expectedCurrentReleaseQID = currentFlag(flags, USAGE.again)
  const expectedChannelRevision = revisionFlag(flags, USAGE.again)
  const notesMd = await notesFrom(flags, USAGE.again)
  ctx.hint = `Check the channel (qwirq channel list <repo>) and re-run: qwirq release again ${targetReleaseQID} with the current snapshot.`
  const { channel } = await apiFetch('GET', `/api/v1/releases/${enc(targetReleaseQID)}`)
  const C = `/api/v1/channels/${enc(channel.qid)}`
  const snap = { expectedCurrentReleaseQID, expectedChannelRevision }
  const pv = await apiFetch('POST', `${C}/release-again/preview`, { body: { targetReleaseQID, ...snap } })
  const p = pv.preview
  if (json) printJSON(io, pv)
  else {
    io.out(`Release again: release ${targetReleaseQID} on ${channel.name} · ${MODE_WORDS[p.mode] ?? p.mode}`)
    for (const e of p.effects ?? []) io.out(`  - ${effectWords(e)}`)
    printBlockers(io, p.blockers, 'Blockers:')
  }
  if (p.stale) throw Object.assign(new Error('the channel moved'), { code: 'stale_channel', status: 409, body: {} })

  const noWait = !!flags['no-wait']
  if (p.mode === 'forward_rollback') {
    const r = await apiFetch('POST', `${C}/recover`, {
      body: { requestID: newRequestID(), targetReleaseQID, ...snap, notesMd, baselineSha256: pv.baseline?.baselineSha256 ?? null },
    })
    if (json) printJSON(io, r)
    else {
      io.out(`Recovery ${r.recovery.qid} accepted${r.replayed ? ' (replayed)' : ''}: rebuilding commit ${sha7(r.recovery.sourceSha)} forward${r.recovery.buildQID ? ` as build ${r.recovery.buildQID}` : ''}; the current release keeps serving until it publishes.`)
      if (r.autoPublishPaused) pauseNotice(io, channel.name)
    }
    if (noWait) { if (!json) io.out(`  Not waiting. Watch it: qwirq release wait --recovery ${r.recovery.qid}`); return EXIT.ok }
    return waitRecovery(r, { json, io, label: channel.name })
  }
  const r = await apiFetch('POST', `${C}/release-again`, { body: { requestID: newRequestID(), targetReleaseQID, ...snap, notesMd } })
  if (json) printJSON(io, r)
  else {
    acceptedLine(io, r, `release ${targetReleaseQID} again on ${channel.name}`)
    if (r.autoPublishPaused) pauseNotice(io, channel.name)
  }
  return follow(r, { json, io, label: channel.name, noWait })
}

// --- wait: resume following a request or recovery ---

async function wait(qid, flags, json, io) {
  if (flags.recovery !== undefined) {
    const rq = qidArg(flagStr(flags.recovery), 'recovery', USAGE.wait)
    const r = await apiFetch('GET', `/api/v1/recoveries/${enc(rq)}`)
    if (json) printJSON(io, r)
    else io.out(`Recovery ${rq}: ${r.recovery.state}${r.build ? ` · build ${r.build.qid} ${r.build.state}` : ''}`)
    return waitRecovery(r, { json, io })
  }
  const r = await apiFetch('GET', `/api/v1/release-requests/${enc(qidArg(qid, 'request', USAGE.wait))}`)
  if (json) printJSON(io, r)
  else io.out(`Publication request ${r.request.qid}: ${r.request.state.replace(/_/g, ' ')}`)
  return waitRequest(r, { json, io })
}
