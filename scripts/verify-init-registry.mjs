// `qwirq init` writes the instance's npm registry into the project's .npmrc (Codex N2 template
// decision). Drives the REAL binary in an isolated QWIRQ_HOME and cwd:
//   unresolved (no config, no env) -> exit 1 with instructions, nothing created
//   invalid (config set rejects; a bad env value or hand-edited config.json fails init) -> nothing created
//   resolved (config set, or env override) -> .npmrc is exactly `@qwirq:registry=<url>`, no placeholder
//     or credential anywhere in the project, next steps name the registry; logout keeps the setting
//   node scripts/verify-init-registry.mjs [--bin <path to bin/qwirq.mjs>]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const binAt = process.argv.indexOf('--bin')
const BIN = binAt > 0 ? resolve(process.argv[binAt + 1]) : resolve(here, '..', 'bin', 'qwirq.mjs')
const TEMPLATE = resolve(here, '..', 'templates', 'project', '_npmrc')
const FALLBACKS = /npm\.pkg\.github\.com|registry\.qwirq\.com|registry\.npmjs\.org/

let failures = 0
const check = (label, cond, detail = '') => { process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}\n`); if (!cond) failures++ }

const root = mkdtempSync(join(tmpdir(), 'qwirq-init-reg-'))
let n = 0
// A fresh config dir + working dir per case; inherited QWIRQ_* never leak in.
function sandbox() {
  const home = join(root, `home${++n}`), cwd = join(root, `cwd${n}`)
  mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true })
  return { home, cwd }
}
function run(sb, args, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QWIRQ_')))
  return spawnSync(process.execPath, [BIN, ...args], { cwd: sb.cwd, encoding: 'utf8', env: { ...env, QWIRQ_HOME: sb.home, ...extraEnv } })
}
const files = (d) => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? files(p) : [p] })
const firstLine = (s) => s.trim().split('\n')[0]

check('template _npmrc is exactly the placeholder line', readFileSync(TEMPLATE, 'utf8') === '@qwirq:registry=__QWIRQ_NPM_REGISTRY_URL__\n')

// --- unresolved ---
{
  const sb = sandbox()
  const r = run(sb, ['init', 'demo-app'])
  check('unresolved: exit 1', r.status === 1, `status ${r.status}`)
  check('unresolved: says how to configure', r.stderr.includes('qwirq config set npm-registry') && r.stderr.includes('QWIRQ_NPM_REGISTRY_URL'), firstLine(r.stderr))
  check('unresolved: says nothing was created', r.stderr.includes('Nothing was created'))
  check('unresolved: no project directory', !existsSync(join(sb.cwd, 'demo-app')))
  check('unresolved: no fallback registry named', !FALLBACKS.test(r.stdout + r.stderr))
}

// --- invalid ---
{
  const sb = sandbox()
  for (const bad of ['http://npm.example.test/', 'https://user:pass@npm.example.test/', 'https://npm.example.test/?token=abc', 'https://npm.example.test/#x', 'npm.example.test', 'https://npm.example.test/a b']) {
    const r = run(sb, ['config', 'set', 'npm-registry', bad])
    check(`invalid: config set rejects ${JSON.stringify(bad)}`, r.status === 1 && r.stderr.startsWith('error: npm registry'), firstLine(r.stderr))
  }
  check('invalid: rejected values are never saved', !existsSync(join(sb.home, 'config.json')))
  const r = run(sb, ['init', 'demo-app'], { QWIRQ_NPM_REGISTRY_URL: 'http://npm.example.test/' })
  check('invalid env: init exit 1 naming the source', r.status === 1 && r.stderr.includes('QWIRQ_NPM_REGISTRY_URL') && r.stderr.includes('must use https://'), firstLine(r.stderr))
  check('invalid env: no project directory', !existsSync(join(sb.cwd, 'demo-app')))
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ npmRegistryUrl: 'https://u:p@npm.example.test/' }))
  const r2 = run(sb, ['init', 'demo-app'])
  check('invalid config.json: init exit 1', r2.status === 1 && r2.stderr.includes('must not contain credentials'), firstLine(r2.stderr))
  check('invalid config.json: no project directory', !existsSync(join(sb.cwd, 'demo-app')))
  check('invalid: credentials and query values are never echoed', !(r2.stdout + r2.stderr).includes('u:p@') && !run(sb, ['config', 'set', 'npm-registry', 'https://a:secret1@x.test/?token=secret2']).stderr.match(/secret[12]/))
}

// --- resolved via config set ---
{
  const sb = sandbox()
  const s = run(sb, ['config', 'set', 'npm-registry', 'https://npm.example.test/tenant'])
  check('resolved: config set exit 0, normalized with a trailing slash', s.status === 0 && s.stdout.trim() === 'npm registry: https://npm.example.test/tenant/', s.stdout.trim() + s.stderr.trim())
  const g = run(sb, ['config', 'get', 'npm-registry'])
  check('resolved: config get prints it', g.status === 0 && g.stdout.startsWith('https://npm.example.test/tenant/'), g.stdout.trim())
  const r = run(sb, ['init', 'demo-app'])
  check('resolved: init exit 0', r.status === 0, `status ${r.status} ${r.stderr.trim()}`)
  const rcPath = join(sb.cwd, 'demo-app', '.npmrc')
  const npmrc = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : ''
  check('resolved: .npmrc is exactly the registry line', npmrc === '@qwirq:registry=https://npm.example.test/tenant/\n', JSON.stringify(npmrc))
  const all = (existsSync(join(sb.cwd, 'demo-app')) ? files(join(sb.cwd, 'demo-app')) : []).map((f) => readFileSync(f, 'utf8')).join('\n')
  check('resolved: no placeholder left anywhere', !all.includes('__QWIRQ_NPM_REGISTRY_URL__') && !all.includes('__NAME__'))
  // A literal token/password/userinfo anywhere fails; AUTHORING.md's documented `${NPM_TOKEN}` placeholder is not one.
  check('resolved: no credentials in generated files', !/_authToken\s*=\s*[^$\s]|_auth\s*=|_password\s*=|https?:\/\/[^/\s@]+:[^/\s@]+@/.test(all))
  check('resolved: no fallback registry in generated files', !FALLBACKS.test(all))
  check('resolved: next steps name the registry + user-level login', r.stdout.includes('npm login --scope=@qwirq --registry=https://npm.example.test/tenant/') && r.stdout.includes('pulls @qwirq/* from https://npm.example.test/tenant/'))
  const lo = run(sb, ['logout'])
  const g2 = run(sb, ['config', 'get', 'npm-registry'])
  check('resolved: logout keeps the registry', lo.status === 0 && g2.status === 0 && g2.stdout.startsWith('https://npm.example.test/tenant/'))
  const u = run(sb, ['config', 'unset', 'npm-registry'])
  const r2 = run(sb, ['init', 'demo-two'])
  check('unset: init is unresolved again, nothing created', u.status === 0 && r2.status === 1 && !existsSync(join(sb.cwd, 'demo-two')))
}

// --- resolved via env override (wins over config.json) ---
{
  const sb = sandbox()
  run(sb, ['config', 'set', 'npm-registry', 'https://config.example.test/'])
  const r = run(sb, ['init', 'env-app'], { QWIRQ_NPM_REGISTRY_URL: 'https://env.example.test/npm/' })
  const p = join(sb.cwd, 'env-app', '.npmrc')
  const npmrc = existsSync(p) ? readFileSync(p, 'utf8') : ''
  check('env: QWIRQ_NPM_REGISTRY_URL wins over config.json', r.status === 0 && npmrc === '@qwirq:registry=https://env.example.test/npm/\n', JSON.stringify(npmrc))
}

process.stdout.write(failures ? `\n${failures} FAILED\n` : '\nall passed\n')
process.exitCode = failures ? 1 : 0
