// Thin client for @qwirq/api. Adds the bearer token and turns the JSON error envelope into
// readable CLI errors.
import { loadConfig, readToken } from './config.mjs'

// Turn a non-2xx response into a readable, consistently-shaped Error (#147 / FRICTION-15). The key
// case: a 5xx is a SERVER-side internal fault, never the user's input; surface it as a clearly NAMED
// error ("…internal error… this is a platform-side bug, not your input") with a stable `code`, instead
// of a bare token like "server_error" that reads like benign output and tells the user nothing. The
// throw always propagates to the top-level handler, which sets a non-zero exit, so `set -e` scripts
// stop. `host` distinguishes the api vs the auth surface in the message.
export function httpError(status, data, { host = 'the QWIRQ server' } = {}) {
  if (status === 401) return Object.assign(new Error('Not signed in or token expired. Run: qwirq login'), { status })
  if (status === 403) return Object.assign(new Error("You don't have permission for that in this company."), { status })
  if (status === 404) return Object.assign(new Error(`Not found${data?.resource ? `: ${data.resource}` : ''}.`), { status })
  if (status >= 500) {
    const detail = data?.message || data?.error || `HTTP ${status}`
    return Object.assign(
      new Error(`${host} hit an internal error handling this request (${detail}). This is a platform-side bug, not your input; please report it.`),
      { code: data?.code || (typeof data?.error === 'string' ? data.error : 'server_error'), status },
    )
  }
  // 4xx domain error: prefer the human `message` (api) or the verbatim `error` text (auth). Carry a
  // stable `code` so verbs can branch on it — the explicit `code` (TasksError/CmdbError) wins, else the
  // envelope's `error` family (bad_request, not_found, …).
  const code = data?.code || (typeof data?.error === 'string' ? data.error : undefined)
  return Object.assign(new Error(data?.message || data?.error || `request failed (${status})`), code ? { code, status } : { status })
}

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
  if (!res.ok) throw httpError(res.status, data)
  return data
}

// App-plane op call: POST one of the /api/v1/data/{tasks,cmdb} dispatch routes. The server resolves the
// tenant's app-DB bridge and runs the @qwirq/tasks|@qwirq/cmdb function; we never hold a DB connection.
export function appCall(lib, body) {
  return apiFetch('POST', `/api/v1/data/${lib}`, { body })
}

// Like apiFetch, but against the AUTH host (authBase) — for surfaces auth owns (token/agent management,
// #115). Surfaces the server's own error message verbatim (auth replies `{ error }`), since these
// endpoints return specific, actionable messages (e.g. "only an owner can mint a token for an agent").
export async function authFetch(method, path, { body, auth = true } = {}) {
  const cfg = loadConfig()
  const token = auth ? readToken() : null
  if (auth && !token) throw new Error('Not signed in. Run: qwirq login')
  const headers = {}
  if (auth) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const url = cfg.authBase + path
  let res
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch (e) {
    throw new Error(`could not reach QWIRQ auth at ${url} (${e?.cause?.code || e?.code || e?.message || 'fetch failed'}). Check your connection, or the authBase endpoint (QWIRQ_AUTH_URL / ~/.qwirq/config.json).`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw httpError(res.status, data, { host: 'QWIRQ auth' })
  return data
}
