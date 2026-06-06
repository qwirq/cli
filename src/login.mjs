// `qwirq login`: the OAuth 2.0 Device Authorization Grant from the client side. Ask auth for a
// code, send the user to the browser to approve, poll until the PAT comes back, store it.
import { loadConfig, saveConfig, writeToken } from './config.mjs'
import { out, err, openBrowser } from './util.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function login({ noBrowser = false } = {}) {
  const { authBase } = loadConfig()

  const startRes = await fetch(`${authBase}/api/device/code`, { method: 'POST' })
  if (!startRes.ok) throw new Error(`could not reach auth at ${authBase} (${startRes.status})`)
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
    const r = await fetch(`${authBase}/api/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: d.device_code }),
    })
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
