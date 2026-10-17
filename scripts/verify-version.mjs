// `qwirq --version` / `-v`: drives the REAL binary; prints package.json's version alone, exit 0.
//   node scripts/verify-version.mjs [--bin <path to bin/qwirq.mjs>]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const binAt = process.argv.indexOf('--bin')
const BIN = binAt > 0 ? resolve(process.argv[binAt + 1]) : resolve(here, '..', 'bin', 'qwirq.mjs')
const want = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version

let failures = 0
const check = (label, cond, detail = '') => { process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}\n`); if (!cond) failures++ }

for (const flag of ['--version', '-v']) {
  const r = spawnSync(process.execPath, [BIN, flag], { encoding: 'utf8' })
  check(`${flag}: exit 0`, r.status === 0, `status ${r.status}`)
  check(`${flag}: stdout is exactly the version (${want})`, r.stdout === want + '\n', JSON.stringify(r.stdout.slice(0, 60)))
  check(`${flag}: nothing on stderr`, r.stderr === '', JSON.stringify(r.stderr.slice(0, 60)))
}
const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
check('--help lists --version', h.status === 0 && h.stdout.includes('qwirq --version | -v'))

process.stdout.write(failures ? `\n${failures} FAILED\n` : '\nall passed\n')
process.exitCode = failures ? 1 : 0
