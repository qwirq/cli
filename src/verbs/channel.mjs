// `qwirq channel …` — release channels of a repository (M12-SPEC §7, UX §7.7).
//   channel list <repo> [--json]                                   one state line per channel
//   channel pause|resume <repo> <channel> --expected-revision <n>  auto-publish off / back on (owner, human)
//   channel link <repo> <channel> [--json]                         the permanent app page URL (never a signed download URL)
// Channels are named; the CLI resolves <repo> + <name> → channel QID via GET /projects/<repo>/channels.
import { apiFetch } from '../api.mjs'
import { EXIT, UsageError, stdio } from './pipeline-shared.mjs'
import { channelArg, revisionFlag, enc, listChannels, resolveChannel, channelLine, printJSON, scrubSigned, reportReleaseError } from './release-shared.mjs'

const USAGE = {
  list: 'qwirq channel list <repo> [--json]',
  pause: 'qwirq channel pause <repo> <channel> --expected-revision <n> [--json]',
  resume: 'qwirq channel resume <repo> <channel> --expected-revision <n> [--json]',
  link: 'qwirq channel link <repo> <channel> [--json]',
}

export async function channelVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  const [sub, repo, name] = positional
  try {
    if (sub === 'list' || sub === 'ls') return await list(need(repo, USAGE.list), json, io)
    if (sub === 'pause' || sub === 'resume') return await toggle(sub, need(repo, USAGE[sub]), channelArg(name, '<channel>', USAGE[sub]), flags, json, io)
    if (sub === 'link') return await link(need(repo, USAGE.link), channelArg(name, '<channel>', USAGE.link), json, io)
    throw new UsageError(`usage: ${Object.values(USAGE).join('\n       ')}`)
  } catch (e) {
    const hint = repo ? `Read the current revision with: qwirq channel list ${repo}` : undefined
    return reportReleaseError(e, { json, io, hint })
  }
}

const need = (v, usage) => { if (!v) throw new UsageError(`usage: ${usage}`); return v }

async function list(repo, json, io) {
  const r = await listChannels(repo)
  if (json) { printJSON(io, r); return EXIT.ok }
  const channels = r.channels ?? []
  if (!channels.length) { io.out(`No channels in ${repo} yet.`); return EXIT.ok }
  for (const c of channels) io.out(channelLine(c))
  return EXIT.ok
}

async function toggle(sub, repo, name, flags, json, io) {
  const expectedRevision = revisionFlag(flags, USAGE[sub])
  const { channel } = await resolveChannel(repo, name)
  const r = await apiFetch('POST', `/api/v1/channels/${enc(channel.qid)}/${sub}`, { body: { expectedRevision } })
  if (json) { printJSON(io, r); return EXIT.ok }
  const c = r.channel
  io.out(sub === 'pause'
    ? `Auto-publish on ${name} is paused (revision ${c.revision}). Resume: qwirq channel resume ${repo} ${name} --expected-revision ${c.revision}`
    : `Auto-publish on ${name} is ${c.autoPublish?.state ?? 'on'} again (revision ${c.revision}).`)
  return EXIT.ok
}

async function link(repo, name, json, io) {
  const { channel, links } = await resolveChannel(repo, name)
  const appPage = scrubSigned(links?.appPage ?? null)
  if (!appPage) {
    throw Object.assign(new Error(`${name} has no app page yet (the company has no verified host)`), { code: 'link_unavailable' })
  }
  if (json) { printJSON(io, { channelQID: channel.qid, channel: name, appPage }); return EXIT.ok }
  io.out(appPage)
  return EXIT.ok
}
