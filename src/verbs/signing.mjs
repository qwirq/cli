// `qwirq signing …` — a repository's Android signing identities (NATHAN-GATES gap C-1; API secrets 0010).
//   signing status <repo> [--json]                                     identities, certificate approval, pinned channels
//   signing identity create <repo> --name <n> --app <applicationId> --cert <sha256> --secret-prefix <p> [--json]
//                                                                      register material imported OFFLINE (import-eas-keystore.mjs --prefix <p>)
//   signing approve <repo> <identity> --cert <sha256> [--json]         approve by restating the digest the import printed
//   signing pin <repo> <identity> <channel> [--json]                    pin the channel to the approved certificate
//   signing unpin <repo> <identity> <channel> [--json]                  unpin: the channel's signing refuses until pinned again
//   signing grant|revoke <repo> <identity> --machine <MCH-n> [--json]  allow / withdraw the box signer machine
//   signing disable|enable <repo> <identity> [--json]                  stop / resume all signing with the identity
// <identity> is an identity name or number; the CLI resolves it via GET /projects/<repo>/signing-identities.
// No key material ever passes through the CLI: only vault entry names (by prefix) and public certificate digests.
// Exit codes are pipeline-shared's EXIT: 0 ok; 2 usage/auth/permission/not-found/conflict/transport.
import { apiFetch } from '../api.mjs'
import { EXIT, UsageError, stdio, flagStr, reportError } from './pipeline-shared.mjs'
import { channelArg, enc, printJSON } from './release-shared.mjs'

const USAGE = {
  status: 'qwirq signing status <repo> [--json]',
  create: 'qwirq signing identity create <repo> --name <name> --app <applicationId> --cert <sha256> --secret-prefix <prefix> [--json]',
  approve: 'qwirq signing approve <repo> <identity> --cert <sha256> [--json]',
  pin: 'qwirq signing pin <repo> <identity> <channel> [--json]',
  unpin: 'qwirq signing unpin <repo> <identity> <channel> [--json]',
  grant: 'qwirq signing grant <repo> <identity> --machine <MCH-n> [--json]',
  revoke: 'qwirq signing revoke <repo> <identity> --machine <MCH-n> [--json]',
  disable: 'qwirq signing disable <repo> <identity> [--json]',
  enable: 'qwirq signing enable <repo> <identity> [--json]',
}

export async function signingVerb(positional, flags, io = stdio) {
  const json = !!flags.json
  const [sub, ...rest] = positional
  try {
    if (sub === 'status' || sub === 'ls' || sub === 'list') return await status(need(rest[0], USAGE.status), json, io)
    if (sub === 'identity' && rest[0] === 'create') return await create(need(rest[1], USAGE.create), flags, json, io)
    if (sub === 'approve') return await approve(need(rest[0], USAGE.approve), need(rest[1], USAGE.approve), flags, json, io)
    if (sub === 'pin' || sub === 'unpin') {
      return await pin(sub, need(rest[0], USAGE[sub]), need(rest[1], USAGE[sub]), channelArg(rest[2], '<channel>', USAGE[sub]), json, io)
    }
    if (sub === 'grant' || sub === 'revoke') return await grant(sub, need(rest[0], USAGE[sub]), need(rest[1], USAGE[sub]), flags, json, io)
    if (sub === 'disable' || sub === 'enable') return await toggle(sub, need(rest[0], USAGE[sub]), need(rest[1], USAGE[sub]), json, io)
    throw new UsageError(`usage: ${Object.values(USAGE).join('\n       ')}`)
  } catch (e) {
    return reportSigningError(e, { json, io, repo: rest[0] && sub !== 'identity' ? rest[0] : rest[1] })
  }
}

const need = (v, usage) => { if (!v) throw new UsageError(`usage: ${usage}`); return v }

const CERT_RE = /^[0-9a-f]{64}$/
/** `--cert`: SHA-256 as apksigner/keytool print it (colons, any case) or plain hex → 64 lowercase hex. */
function certFlag(flags, usage) {
  const raw = flagStr(flags.cert)
  if (!raw) throw new UsageError(`--cert <sha256> is required (the certificate SHA-256 the import printed). usage: ${usage}`)
  const h = raw.replace(/:/g, '').trim().toLowerCase()
  if (!CERT_RE.test(h)) throw new UsageError(`--cert must be a SHA-256 (64 hex characters, colons allowed), got "${raw}". usage: ${usage}`)
  return h
}
function strFlag(flags, name, usage, what) {
  const v = flagStr(flags[name])
  if (!v) throw new UsageError(`--${name} <${what}> is required. usage: ${usage}`)
  return v
}

const listPath = (repo) => `/api/v1/projects/${enc(repo)}/signing-identities`
const STATE_WORDS = {
  approved: 'certificate approved',
  pending_approval: 'certificate NOT approved yet (signing refuses)',
  unrecorded: 'no imported certificate on record',
}

/** One identity in words: header line + one line per channel. */
function identityLines(i) {
  const c = i.certificate ?? {}
  const lines = [`${i.name} (identity ${i.qid}) · app ${i.applicationId} · ${i.status} · ${STATE_WORDS[c.state] ?? c.state} · revision ${i.revision}`]
  if (c.importedSha256) lines.push(`  certificate ${c.importedSha256}${c.approvedAt ? ` (approved ${c.approvedAt}${c.approvedByUserQID ? ` by user ${c.approvedByUserQID}` : ''})` : ''}`)
  if (!i.channels?.length) lines.push('  no channels pinned')
  for (const ch of i.channels ?? []) lines.push(`  ${ch.channel}: ${ch.pinned ? 'pinned' : 'unpinned (signing for it refuses)'}`)
  if (i.machineQIDs?.length) lines.push(`  signing machines: ${i.machineQIDs.join(', ')}`)
  return lines
}

/** Resolve `<identity>` (name or number) within the repository. */
async function resolveIdentity(repo, ref) {
  const r = await apiFetch('GET', listPath(repo))
  const all = r.identities ?? []
  const hit = all.find((i) => i.qid === ref) ?? all.find((i) => i.name === ref)
  if (!hit) {
    const names = all.map((i) => i.name)
    throw Object.assign(new Error(`no signing identity "${ref}" in ${repo}${names.length ? ` (identities: ${names.join(', ')})` : ' (it has none yet)'}`), { code: 'not_found' })
  }
  return hit
}

async function status(repo, json, io) {
  const r = await apiFetch('GET', listPath(repo))
  if (json) { printJSON(io, r); return EXIT.ok }
  const ids = r.identities ?? []
  if (!ids.length) {
    io.out(`No signing identity in ${repo} yet. Native releases are refused until the owner registers one:`)
    io.out(`  ${USAGE.create}`)
    return EXIT.ok
  }
  for (const i of ids) for (const l of identityLines(i)) io.out(l)
  return EXIT.ok
}

async function create(repo, flags, json, io) {
  const body = {
    name: strFlag(flags, 'name', USAGE.create, 'name'),
    applicationId: strFlag(flags, 'app', USAGE.create, 'applicationId'),
    certSha256: certFlag(flags, USAGE.create),
    secretPrefix: strFlag(flags, 'secret-prefix', USAGE.create, 'prefix'),
  }
  const r = await apiFetch('POST', listPath(repo), { body })
  if (json) { printJSON(io, r); return EXIT.ok }
  const i = r.identity
  io.out(r.created ? `Registered signing identity ${i.name} (identity ${i.qid}) for ${i.applicationId}.` : `Signing identity ${i.name} (identity ${i.qid}) is already registered with exactly these settings; nothing changed.`)
  for (const l of identityLines(i)) io.out(l)
  if (i.certificate?.state !== 'approved') io.out(`Next, after comparing the digest with the installed app: qwirq signing approve ${repo} ${i.name} --cert <sha256>`)
  return EXIT.ok
}

async function approve(repo, ref, flags, json, io) {
  const certSha256 = certFlag(flags, USAGE.approve)
  const id = await resolveIdentity(repo, ref)
  const r = await apiFetch('POST', `/api/v1/signing-identities/${enc(id.qid)}/approve`, { body: { certSha256 } })
  if (json) { printJSON(io, r); return EXIT.ok }
  io.out(`Certificate approved for ${r.identity.name} (revision ${r.identity.revision}). Pin channels with: qwirq signing pin ${repo} ${r.identity.name} <channel>`)
  return EXIT.ok
}

async function pin(sub, repo, ref, channel, json, io) {
  const id = await resolveIdentity(repo, ref)
  const r = await apiFetch('POST', `/api/v1/signing-identities/${enc(id.qid)}/${sub}`, { body: { channel } })
  if (json) { printJSON(io, r); return EXIT.ok }
  io.out(sub === 'pin'
    ? `${channel} is pinned to ${r.identity.name}'s approved certificate (revision ${r.identity.revision}).`
    : `${channel} is unpinned from ${r.identity.name} (revision ${r.identity.revision}); signing and publication for it refuse until it is pinned again.`)
  return EXIT.ok
}

const MID_RE = /^MCH-\d{1,12}$/
/** `--machine <MCH-n>`: the machine id `qwirq machines` shows. */
function machineFlag(flags, usage) {
  const v = flagStr(flags.machine)
  if (!v) throw new UsageError(`--machine <MCH-n> is required (the signer machine's id). usage: ${usage}`)
  if (!MID_RE.test(v)) throw new UsageError(`--machine must be a machine id like MCH-3, got "${v}". usage: ${usage}`)
  return v
}

async function grant(sub, repo, ref, flags, json, io) {
  const machine = machineFlag(flags, USAGE[sub])
  const id = await resolveIdentity(repo, ref)
  const r = await apiFetch('POST', `/api/v1/signing-identities/${enc(id.qid)}/${sub}`, { body: { machine } })
  if (json) { printJSON(io, r); return EXIT.ok }
  if (sub === 'grant') io.out(`${machine} may sign with ${r.identity.name} (grant ${r.grantQID}, revision ${r.identity.revision}).`)
  else io.out(r.revoked
    ? `${machine} may no longer sign with ${r.identity.name} (revision ${r.identity.revision}); a signature in flight on it is refused at acceptance.`
    : `${machine} had no grant on ${r.identity.name}; nothing changed.`)
  return EXIT.ok
}

async function toggle(sub, repo, ref, json, io) {
  const id = await resolveIdentity(repo, ref)
  const r = await apiFetch('POST', `/api/v1/signing-identities/${enc(id.qid)}/${sub}`, { body: {} })
  if (json) { printJSON(io, r); return EXIT.ok }
  io.out(sub === 'disable'
    ? `${r.identity.name} is disabled (revision ${r.identity.revision}): signing with it refuses; pins and grants are kept. Re-enable: qwirq signing enable ${repo} ${r.identity.name}`
    : `${r.identity.name} is active again (revision ${r.identity.revision}).`)
  return EXIT.ok
}

/** Signing-aware error words; everything else is pipeline-shared's reportError. Exit 2. */
function reportSigningError(e, { json, io, repo }) {
  const code = e?.code
  const server = e?.body?.message
  const words = {
    publication_forbidden: "agent tokens can't change signing settings; a person who owns the company has to run this. Nothing was changed.",
    forbidden: `only a company owner changes signing settings${server ? ` (${server})` : ''}. Nothing was changed.`,
    signing_mismatch: `${server || 'the certificate does not match'} Compare with the import's "certificate-sha256 (vault round trip)" line. Nothing was changed.`,
    signing_not_configured: `${server || 'signing is not configured for that yet'}${repo ? ` See: qwirq signing status ${repo}` : ''}`,
    signing_conflict: `${server || 'the signing configuration conflicts'}${repo ? ` See: qwirq signing status ${repo}` : ''}`,
  }
  const msg = words[code]
  if (!msg) return reportError(e, { json, io })
  const reason = e?.body?.detail?.reason
  if (json) io.err(JSON.stringify({ code, status: e?.status ?? null, message: msg, ...(reason ? { reason } : {}) }))
  else io.err(`error: ${msg} [${code}]`)
  return EXIT.error
}
