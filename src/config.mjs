// CLI config: the API/auth endpoints + company live in ~/.qwirq/config.json (0700 dir, 0600 file).
// The auth TOKEN is kept out of that file and stored in the OS keychain (see keychain.mjs); the file
// only records a `tokenStore: 'keychain'` marker. Older installs that wrote the token inline are
// still read, and migrated into the keychain on first use. Env overrides (dev / CI / isolation):
// QWIRQ_HOME (config dir), QWIRQ_API_URL, QWIRQ_AUTH_URL, QWIRQ_GIT_URL, QWIRQ_TOKEN.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { keychainStore, keychainRead, keychainClear, keychainName } from './keychain.mjs'

// Compiled-in defaults are the PRODUCTION endpoints, so a fresh or wiped config works out of the
// box (#98). Platform devs point at localhost with the env overrides (QWIRQ_AUTH_URL / QWIRQ_API_URL
// / QWIRQ_GIT_URL) or by writing authBase/apiBase/gitBase into ~/.qwirq/config.json.
const DEFAULTS = { authBase: 'https://auth.qwirq.com', apiBase: 'https://api.qwirq.com', gitBase: 'https://git.qwirq.com' }

function dir() {
  return process.env.QWIRQ_HOME || join(homedir(), '.qwirq')
}
function file() {
  return join(dir(), 'config.json')
}

function readFile() {
  try { return JSON.parse(readFileSync(file(), 'utf8')) } catch { return {} }
}
function writeFile(obj) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  writeFileSync(file(), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
}

// Non-secret config (endpoints + company). The token is resolved separately via readToken().
export function loadConfig() {
  const f = readFile()
  return {
    authBase: process.env.QWIRQ_AUTH_URL || f.authBase || DEFAULTS.authBase,
    apiBase: process.env.QWIRQ_API_URL || f.apiBase || DEFAULTS.apiBase,
    gitBase: process.env.QWIRQ_GIT_URL || f.gitBase || DEFAULTS.gitBase,
    company: f.company || null,
  }
}

export function saveConfig(patch) {
  writeFile({ ...readFile(), ...patch })
}

// Resolve the auth token: explicit env override > OS keychain > legacy plaintext in config.json.
// If a legacy plaintext token is found and a keychain is available, migrate it transparently and
// strip the plaintext copy, so the upgrade hardens existing installs on their next command.
export function readToken() {
  if (process.env.QWIRQ_TOKEN) return process.env.QWIRQ_TOKEN
  const f = readFile()
  if (f.tokenStore === 'keychain') {
    const v = keychainRead()
    if (v) return v
  }
  if (f.token) {
    try { if (keychainStore(f.token)) { const m = { ...f }; delete m.token; m.tokenStore = 'keychain'; writeFile(m) } } catch { /* keep plaintext */ }
    return f.token
  }
  return null
}

// Store the token as safely as the platform allows: OS keychain first, else the 0600 config file.
// Returns the backend name (e.g. "Windows DPAPI") on keychain success, or null on file fallback.
export function writeToken(token) {
  const backend = keychainStore(token)
  const f = readFile()
  if (backend) {
    delete f.token            // never leave a plaintext copy behind
    f.tokenStore = 'keychain'
    writeFile(f)
    return backend
  }
  delete f.tokenStore
  f.token = token             // fallback: 0600 file (e.g. headless Linux with no libsecret)
  writeFile(f)
  return null
}

// Log out: drop ONLY the auth identity (token + active company), never the endpoints (#98).
// Wiping the whole file used to strip authBase/apiBase/gitBase too, so after a logout every command
// (including `login`) fell back to defaults — which is now harmless since the defaults are prod, but
// an explicit endpoint override (a platform dev pointed at localhost, a self-hoster) must survive a
// logout. Keep any endpoint keys that were set; remove the file entirely if nothing else remains.
export function clearConfig() {
  const f = readFile()
  if (f.tokenStore === 'keychain') keychainClear()
  const keep = {}
  for (const k of ['authBase', 'apiBase', 'gitBase']) if (f[k] !== undefined) keep[k] = f[k]
  if (Object.keys(keep).length) writeFile(keep)
  else if (existsSync(file())) rmSync(file())
}

export { keychainName }
