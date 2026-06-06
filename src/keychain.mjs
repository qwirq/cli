// OS-native at-rest storage for the CLI auth token, with zero npm deps (shells out, like
// openBrowser/copyToClipboard). Each platform uses its own user-scoped secret store:
//   Windows -> DPAPI (CurrentUser), an encrypted blob in ~/.qwirq/token.dpapi
//   macOS   -> the login Keychain via `security`
//   Linux   -> libsecret via `secret-tool`
// Every function is best-effort: a missing backend makes store() return false / read() return
// null, so config.mjs can fall back to the (0600) config file rather than break.
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'

const SERVICE = 'qwirq-cli'
const ACCOUNT = 'token'

function run(cmd, args, { input, env } = {}) {
  return execFileSync(cmd, args, {
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    encoding: 'utf8',
  })
}
const chomp = (s) => (s == null ? null : s.replace(/\r?\n$/, '') || null)

// ---- Windows: DPAPI (CurrentUser). Secret is passed via env (never argv), so it can't show in ps.
function winDir() { return process.env.QWIRQ_HOME || join(homedir(), '.qwirq') }
function winFile() { return join(winDir(), 'token.dpapi') }
const win = {
  name: 'Windows DPAPI',
  store(token) {
    const blob = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $env:QW_TOK -AsPlainText -Force)'],
      { env: { QW_TOK: token } }).trim()
    if (!blob) throw new Error('empty DPAPI blob')
    mkdirSync(winDir(), { recursive: true, mode: 0o700 })
    writeFileSync(winFile(), blob, { mode: 0o600 })
  },
  read() {
    if (!existsSync(winFile())) return null
    const blob = readFileSync(winFile(), 'utf8').trim()
    if (!blob) return null
    return chomp(run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$s = ConvertTo-SecureString -String $env:QW_BLOB; ' +
      '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
      { env: { QW_BLOB: blob } }))
  },
  clear() { if (existsSync(winFile())) rmSync(winFile()) },
}

// ---- macOS: login Keychain. (`-w token` is briefly visible in ps on add; the win is at-rest.)
const mac = {
  name: 'macOS Keychain',
  store(token) { run('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w', token]) },
  read() { return chomp(run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'])) },
  clear() { run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]) },
}

// ---- Linux: libsecret. `secret-tool store` reads the secret from stdin (no argv exposure).
const lin = {
  name: 'libsecret',
  store(token) { run('secret-tool', ['store', '--label=qwirq CLI token', 'service', SERVICE, 'account', ACCOUNT], { input: token }) },
  read() { return chomp(run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT])) },
  clear() { run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]) },
}

function backend() {
  if (process.platform === 'win32') return win
  if (process.platform === 'darwin') return mac
  return lin
}

// Returns the backend's display name on success, or null if no backend could store it.
export function keychainStore(token) {
  try { backend().store(token); return backend().name } catch { return null }
}
export function keychainRead() {
  try { return backend().read() } catch { return null }
}
export function keychainClear() {
  try { backend().clear() } catch { /* nothing stored / no backend */ }
}
export function keychainName() { return backend().name }
