// CLI config: the API/auth endpoints and the stored token, in ~/.qwirq/config.json (0600).
// Env overrides (for dev / CI / isolation): QWIRQ_HOME (config dir), QWIRQ_API_URL,
// QWIRQ_AUTH_URL, QWIRQ_TOKEN.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const DEFAULTS = { authBase: 'http://localhost:4000', apiBase: 'http://localhost:5000', gitBase: 'https://git.qwirq.com' }

function dir() {
  return process.env.QWIRQ_HOME || join(homedir(), '.qwirq')
}
function file() {
  return join(dir(), 'config.json')
}

function readFile() {
  try { return JSON.parse(readFileSync(file(), 'utf8')) } catch { return {} }
}

export function loadConfig() {
  const f = readFile()
  return {
    authBase: process.env.QWIRQ_AUTH_URL || f.authBase || DEFAULTS.authBase,
    apiBase: process.env.QWIRQ_API_URL || f.apiBase || DEFAULTS.apiBase,
    gitBase: process.env.QWIRQ_GIT_URL || f.gitBase || DEFAULTS.gitBase,
    token: process.env.QWIRQ_TOKEN || f.token || null,
    company: f.company || null,
  }
}

export function saveConfig(patch) {
  const merged = { ...readFile(), ...patch }
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  writeFileSync(file(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
}

export function clearConfig() {
  if (existsSync(file())) rmSync(file())
}
