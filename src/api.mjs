// Thin client for @qwirq/api. Adds the bearer token and turns the JSON error envelope into
// readable CLI errors.
import { loadConfig, readToken } from './config.mjs'

export async function apiFetch(method, path, { body, auth = true } = {}) {
  const cfg = loadConfig()
  const token = auth ? readToken() : null
  if (auth && !token) {
    throw new Error('Not signed in. Run: qwirq login')
  }
  const headers = {}
  if (auth) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const url = cfg.apiBase + path
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    // Network-level failure (DNS, refused, offline). Name the URL we tried + the endpoint config,
    // so a bare "fetch failed" never leaves the user guessing which host or override is wrong (#98).
    throw new Error(`could not reach the QWIRQ API at ${url} (${e?.cause?.code || e?.code || e?.message || 'fetch failed'}). Check your connection, or the apiBase endpoint (QWIRQ_API_URL / ~/.qwirq/config.json).`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in or token expired. Run: qwirq login')
    if (res.status === 403) throw new Error("You don't have permission for that in this company.")
    if (res.status === 404) throw new Error(`Not found${data?.resource ? `: ${data.resource}` : ''}.`)
    const e = new Error(data?.message || data?.error || `request failed (${res.status})`)
    // Domain errors from the app-plane libs (TasksError/CmdbError) carry a stable `code` the verbs
    // can branch on (e.g. bad_transition, not_found, type_exists); pass it through on the thrown error.
    if (data?.code) e.code = data.code
    throw e
  }
  return data
}

// App-plane op call: POST one of the /api/v1/data/{tasks,cmdb} dispatch routes. The server resolves the
// tenant's app-DB bridge and runs the @qwirq/tasks|@qwirq/cmdb function; we never hold a DB connection.
export function appCall(lib, body) {
  return apiFetch('POST', `/api/v1/data/${lib}`, { body })
}
