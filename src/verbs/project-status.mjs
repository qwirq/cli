// `qwirq project status <repo>` / `qwirq repo status <repo>` — what the latest push did (M0-SPEC §5).
// Pipeline facts only: no release, channel, or install data exists in M0, so none is shown. `project`
// reads /projects/[slug]/status, `repo` reads /repositories/[slug]/status (compatibility-equivalent).
import { apiFetch } from '../api.mjs'
import { EXIT, UsageError, reportError, sha7, branch, stateWord, rejectionWords, when, pad, stdio } from './pipeline-shared.mjs'

function nowLine(s, byQid) {
  const a = s.attention
  const name = (q) => byQid.get(String(q))?.name ?? `job ${q}`
  const att = (q) => byQid.get(String(q))?.attempt ?? 1
  if (!a) return s.latestPush ? 'No checks on the latest commit.' : 'No pushes yet.'
  if (a.code === 'queue_full') return `Push ${a.pushQID} was not admitted: ${rejectionWords('queue_full')}. Nothing ran.`
  if (a.code === 'failed') return `${name(a.jobQID)} did not succeed (job ${a.jobQID}). Log: qwirq jobs logs ${a.jobQID} --attempt ${att(a.jobQID)}`
  if (a.code === 'running') return `${name(a.jobQID)} is running (job ${a.jobQID}). Follow: qwirq jobs logs ${a.jobQID} --attempt ${att(a.jobQID)} --follow`
  if (a.code === 'queued') return `${name(a.jobQID)} is queued (job ${a.jobQID}). Why: qwirq jobs show ${a.jobQID}`
  if (a.code === 'passing') return 'All checks passing.'
  return a.code
}

export async function statusVerb(family, positional, flags, io = stdio) {
  const json = !!flags.json
  const noun = family === 'projects' ? 'project' : 'repo'
  try {
    const slug = positional[0]
    if (!slug) throw new UsageError(`usage: qwirq ${noun} status <repo> [--json]`)
    const s = await apiFetch('GET', `/api/v1/${family}/${encodeURIComponent(slug)}/status`)
    if (json) { io.out(JSON.stringify(s)); return EXIT.ok }

    const checks = s.checks ?? []
    const byQid = new Map(checks.map((c) => [String(c.jobQID), c]))
    io.out(`${s.repository?.name ?? slug} (${s.repository?.slug ?? slug})`)
    io.out(`Now: ${nowLine(s, byQid)}`)
    const p = s.latestPush
    if (p) {
      io.out(`Latest push: ${p.qid} · ${sha7(p.commitSha)} on ${branch(p.ref)} · ${p.admission === 'rejected' ? `not admitted: ${rejectionWords(p.rejectionCode)}` : 'admitted'} · ${when(p.receivedAt)}`)
    }
    if (checks.length) {
      io.out('Checks on the latest admitted commit:')
      const w = Math.max(...checks.map((c) => c.name.length))
      for (const c of checks) io.out(`  ${pad(c.name, w)}  ${pad(stateWord(c.state), 10)}  attempt ${c.attempt}  job ${c.jobQID}${c.required ? '' : '  (optional)'}`)
      const n = s.counts ?? {}
      io.out(`${n.running ?? 0} running · ${n.queued ?? 0} queued · ${n.failed ?? 0} failed`)
    }
    io.out(`Updated ${when(s.updatedAt)}`)
    return EXIT.ok
  } catch (e) {
    return reportError(e, { json, io })
  }
}
