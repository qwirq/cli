// `qwirq login`: the OAuth 2.0 Device Authorization Grant from the client side. Ask auth for a
// code, send the user to the browser to approve, poll until the PAT comes back, store it.
// `qwirq login --token <PAT>`: non-interactive path for agents/CI — writes the PAT directly into
// the (QWIRQ_HOME-scoped) credential store without a browser or network round-trip.
import { loadConfig, saveConfig, writeToken } from './config.mjs'
import { out, err, openBrowser } from './util.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function login({ noBrowser = false } = {}) {
  const { authBase } = loadConfig()

  const codeUrl = `${authBase}/api/device/code`
  let startRes
  try {
    startRes = await fetch(codeUrl, { method: 'POST' })
  } catch (e) {
    // Network-level failure: name the URL + the endpoint config so login never dies on a bare
    // "fetch failed" (#98 — the failure mode that bricked a client after `qwirq logout`).
    throw new Error(`could not reach auth at ${codeUrl} (${e?.cause?.code || e?.code || e?.message || 'fetch failed'}). Check your connection, or the authBase endpoint (QWIRQ_AUTH_URL / ~/.qwirq/config.json).`)
  }
  if (!startRes.ok) throw new Error(`could not reach auth at ${codeUrl} (${startRes.status})`)
  const d = await startRes.json()

  out('')
  out('  To connect this device, open:')
  out(`    ${d.verification_uri_complete}`)
  out('')
  out(`  and confirm the code:  ${d.user_code}`)
  out('')

  if (!noBrowser && !process.env.QWIRQ_NO_BROWSER) {
    if (openBrowser(d.verification_uri_complete)) out('  (opened your browser…)')
  }
  out('  Waiting for approval…')

  const interval = (d.interval || 2) * 1000
  const deadline = Date.now() + (d.expires_in || 600) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    let r
    try {
      r = await fetch(`${authBase}/api/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: d.device_code }),
      })
    } catch { continue } // transient network blip mid-poll: keep waiting, don't crash the login
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.access_token) {
      const backend = writeToken(j.access_token)
      saveConfig({ company: j.company })
      out('')
      out(`  Signed in to ${j.company?.name ?? 'your company'}${j.company?.role ? ` (${j.company.role})` : ''}.`)
      if (backend) out(`  Token stored in the ${backend}.`)
      else err('  Note: no OS keychain available — token saved to ~/.qwirq/config.json (0600).')
      return
    }
    if (j.error && j.error !== 'authorization_pending') {
      throw new Error(j.error === 'expired_token' ? 'the code expired, please run login again' : j.error)
    }
  }
  throw new Error('timed out waiting for approval')
}

// Non-interactive PAT write: store `pat` in the (QWIRQ_HOME-scoped) credential store. Used by
// `qwirq login --token <PAT>` so agents and CI runners can authenticate without a device flow.
// QWIRQ_HOME isolates this store from the default ~/.qwirq, so an agent and the owner can
// coexist on the same machine with zero token collision.
export async function loginWithToken(pat) {
  if (!pat || !pat.trim()) throw new Error('--token: PAT value is empty')
  const backend = writeToken(pat.trim())
  if (backend) out(`  Token stored in the ${backend}.`)
  else err('  Note: no OS keychain available — token saved to config file (0600).')
  out('  Run `qwirq whoami` to confirm the active identity.')
}
