// Shared plumbing for the M0 pipeline verbs (jobs, watch, project/repo status): exit codes, error
// reporting, Ctrl+C handling, the reconnecting poll fetch, and the plain-words formatting the UX plan
// fixes (§2 state vocabulary, §7.7 CLI parity). The verbs return an exit code; bin sets it.
import { apiFetch } from '../api.mjs'

// Stable exit codes (M0-SPEC §6 WP8). 1 means "the watched execution did not succeed" and nothing else.
export const EXIT = { ok: 0, failed: 1, error: 2, interrupted: 130 }

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'])
export const NOT_SUCCESS = new Set(['failed', 'cancelled', 'timed_out'])

// Live cadence: logs poll every 500 ms (M0-SPEC §1); watch every second. Env overrides exist for the
// offline verification harness, not for users.
export const POLL_MS = Number(process.env.QWIRQ_POLL_MS) || 0
export const RECONNECT_MS = Number(process.env.QWIRQ_RECONNECT_MS) || 120_000

export const stdio = {
  out: (s = '') => process.stdout.write(s + '\n'),
  err: (s = '') => process.stderr.write(s + '\n'),
}

/** A usage error: exit 2, message names the right invocation. */
export class UsageError extends Error {}

/** A poll loop interrupted by Ctrl+C. Never cancels anything server-side. */
export class Interrupted extends Error {}

/**
 * Ctrl+C stops watching; it never cancels jobs. `signal` aborts the in-flight request and any sleep.
 * Call `release()` when the verb ends so the handler doesn't outlive it.
 */
export function interruptible() {
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  return { signal: ac.signal, release: () => process.off('SIGINT', onSigint) }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Interrupted())
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new Interrupted()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const retryable = (e) => e?.transport === true || (typeof e?.status === 'number' && (e.status >= 500 || e.status === 429))

/**
 * GET with reconnect for long-running verbs. Transport failures and 5xx retry with backoff for up to
 * RECONNECT_MS of continuous failure; 4xx answers (401/403/404/...) fail at once. `onLost`/`onBack`
 * let the caller say what it is resuming from.
 */
export async function pollGet(path, { signal, onLost, onBack } = {}) {
  let lostAt = 0
  let delay = 250
  for (;;) {
    if (signal?.aborted) throw new Interrupted()
    try {
      const data = await apiFetch('GET', path, { signal })
      if (lostAt) onBack?.()
      return data
    } catch (e) {
      if (signal?.aborted) throw new Interrupted()
      if (!retryable(e)) throw e
      if (!lostAt) { lostAt = Date.now(); onLost?.(e) }
      if (Date.now() - lostAt >= RECONNECT_MS) throw e
      await sleep(delay, signal)
      delay = Math.min(delay * 2, 5000)
    }
  }
}

/** Print an error (human line, or the JSON envelope under --json) and return exit 2. */
export function reportError(e, { json = false, io = stdio } = {}) {
  if (e instanceof UsageError) {
    io.err(json ? JSON.stringify({ code: 'usage', message: e.message }) : `error: ${e.message}`)
    return EXIT.error
  }
  const code = e?.code || (e?.transport ? 'unreachable' : e?.status ? `http_${e.status}` : 'error')
  const server = e?.body?.message
  let msg = e?.message ?? String(e)
  if (e?.status === 403) msg = `you don't have permission for that${server ? ` (${server})` : ''}. Ask a repository owner for manage access.`
  else if (e?.status === 404) msg = `${server || 'not found'} (or you can't see it).`
  else if (code === 'invalid_state') msg = `${msg}. Check the job's current attempt with: qwirq jobs show <qid>`
  else if (code === 'queue_full') msg = `${msg} Try again when some jobs finish.`
  if (json) io.err(JSON.stringify({ code, status: e?.status ?? null, message: msg }))
  else io.err(`error: ${msg} [${code}]`)
  return EXIT.error
}

export const flagStr = (v) => (typeof v === 'string' ? v : undefined)

/** `--attempt <n>`: required non-negative integer (retry/cancel accept 0 for a never-claimed job). */
export function attemptFlag(flags, usage, min = 0) {
  const raw = flags.attempt
  if (raw === undefined || raw === true) throw new UsageError(`--attempt <n> is required. usage: ${usage}`)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--attempt must be an integer >= ${min}, got "${raw}". usage: ${usage}`)
  return n
}

export const qs = (params) => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

// --- words (UX §2: states in words, never colour alone) ---

export const sha7 = (sha) => String(sha ?? '').slice(0, 7)
export const branch = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '')

const STATE_WORDS = { queued: 'queued', leased: 'starting', running: 'running', succeeded: 'succeeded',
  failed: 'failed', cancelled: 'cancelled', timed_out: 'timed out', skipped: 'skipped', lease_lost: 'lost its worker' }
export const stateWord = (s) => STATE_WORDS[s] ?? String(s)

export function queuedWords(reason) {
  if (!reason) return ''
  if (reason.code === 'dependencies') return 'waiting for the checks it needs'
  if (reason.code === 'no_matching_worker') {
    return reason.labels?.length ? `no online worker with labels ${reason.labels.join(', ')}` : 'no online worker for this repository'
  }
  if (reason.code === 'worker_busy') return 'waiting for a free worker'
  return reason.code
}

/** One job's state as a short phrase: "running · attempt 2", "queued (no online worker …)". */
export function jobPhrase(job) {
  let s = stateWord(job.state)
  if (job.state === 'queued' && job.queuedReason) s += ` (${queuedWords(job.queuedReason)})`
  if (job.cancelRequested && !TERMINAL.has(job.state)) s += ' (cancel requested)'
  if (job.attempt > 0) s += ` · attempt ${job.attempt}`
  return s
}

export const rejectionWords = (code) => (code === 'queue_full' ? 'too many outstanding jobs (queue full)' : code || 'rejected')

export function clock(iso) {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function when(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function bytes(n) {
  if (typeof n !== 'number') return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const pad = (s, w) => String(s).padEnd(w)

// --- commit subjects (D4): one line, terminal-safe, ellipsized to the terminal width ---

const WIDE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment)

/** Terminal columns a string occupies (emoji / East Asian wide = 2; a grapheme never splits). */
export const displayWidth = (s) => graphemes(String(s)).reduce((w, g) => w + (WIDE.test(g) ? 2 : 1), 0)

/** Columns to fit a line into: the TTY width, else $COLUMNS, else 72. */
export const termWidth = () => process.stdout.columns || Number(process.env.COLUMNS) || 72

/** A subject as one printable line: control characters (incl. escape sequences' ESC) dropped, whitespace folded. */
export const cleanSubject = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim() : '')

/** Cut `s` to at most `max` columns, ending in "…" when cut; whole graphemes only. */
export function ellipsize(s, max) {
  if (displayWidth(s) <= max) return s
  let out = ''
  let w = 0
  for (const g of graphemes(s)) {
    const gw = WIDE.test(g) ? 2 : 1
    if (w + gw > max - 1) break
    out += g
    w += gw
  }
  return out.trimEnd() + '…'
}

/** `before` + " subject" + `after`, the subject ellipsized so the line fits the terminal (never < 10 cols). */
export function withSubject(before, subject, after = '') {
  const s = cleanSubject(subject)
  if (!s) return before + after
  const budget = Math.max(10, termWidth() - displayWidth(before) - displayWidth(after) - 1)
  return `${before} ${ellipsize(s, budget)}${after}`
}
