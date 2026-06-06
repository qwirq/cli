// Small terminal helpers: stdin, hidden prompt, $EDITOR, output. Zero dependencies.
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function out(s = '') { process.stdout.write(s + '\n') }
export function err(s = '') { process.stderr.write(s + '\n') }

export function fail(message) {
  err('error: ' + message)
  process.exit(1)
}

// Read all of piped stdin (for `--stdin` value input).
export async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

// Prompt without echoing (for secret values typed interactively).
export function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = () => {} // mute echo
    process.stdout.write(question)
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

// Yes/no confirmation for destructive actions. Prompt + answer go to stderr so stdout stays clean
// for pipes. Returns null when stdin is not a TTY, so callers can refuse rather than hang.
export function promptYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null)
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      rl.close()
      const t = answer.trim().toLowerCase()
      resolve(t === 'y' || t === 'yes')
    })
  })
}

// Copy text to the OS clipboard with no third-party deps (shells out like openBrowser).
// Tries platform-native tools in order; rejects if none are available.
const CLIPBOARD = {
  win32: [['clip', []]],
  darwin: [['pbcopy', []]],
  linux: [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]],
}
export function copyToClipboard(text) {
  const candidates = CLIPBOARD[process.platform] || CLIPBOARD.linux
  return new Promise((resolve, reject) => {
    let i = 0
    const tryNext = () => {
      if (i >= candidates.length) return reject(new Error('no clipboard tool found'))
      const [cmd, args] = candidates[i++]
      let child
      try { child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] }) } catch { return tryNext() }
      child.on('error', tryNext)
      child.on('exit', (code) => (code === 0 ? resolve() : tryNext()))
      child.stdin.on('error', () => {}) // ignore EPIPE when the tool is missing
      child.stdin.end(text)
    }
    tryNext()
  })
}

// Open text in $EDITOR (fallback: notepad on Windows, vi elsewhere); return the edited content.
export function editInEditor(initial, ext = '.md') {
  const tmp = join(tmpdir(), `qwirq-${process.pid}-${Date.now()}${ext}`)
  writeFileSync(tmp, initial ?? '')
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'vi')
  return new Promise((resolve, reject) => {
    const child = spawn(`${editor} "${tmp}"`, { stdio: 'inherit', shell: true })
    child.on('error', reject)
    child.on('exit', () => {
      try { const text = readFileSync(tmp, 'utf8'); unlinkSync(tmp); resolve(text) } catch (e) { reject(e) }
    })
  })
}

export function openBrowser(url) {
  try {
    const p = process.platform
    if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    else if (p === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch { return false }
}

// Minimal arg parser: positionals + `--flag value` / `--flag` (boolean).
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { flags[key] = true }
      else { flags[key] = next; i++ }
    } else positional.push(a)
  }
  return { positional, flags }
}
