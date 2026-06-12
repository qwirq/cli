// qwirq.yaml manifest — the CLI's thin adapter over @qwirq/manifest (#93). The parse/validate logic and
// the JSON Schema live ONCE in the shared package (deps-free JS build, 0.3.0). Because that package is
// gated (GitHub Packages only) and the public CLI must install from a clean machine (`npm i -g
// github:qwirq/cli`, #166), the runtime + schema are VENDORED into ./vendor/manifest (see its README).
// The CLI re-exports the parse/validate surface from the vendored copy and keeps only the CLI-specific
// editor-integration helpers (write the schema into a project + the yaml-language-server modeline).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Single source of truth: the shared parser/validator + the canonical schema URL ($id), vendored.
export { parseManifestText, validateManifest, loadSchema, SCHEMA_URL } from '../vendor/manifest/dist/index.js'

// The bundled JSON Schema ships alongside the vendored runtime (vendor/manifest/schemas) so `qwirq schema`
// can copy it into a project. Resolved relative to this file, not via require.resolve on a gated package.
const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(HERE, '..', 'vendor', 'manifest', 'schemas', 'qwirq.schema.json')

/** Where `qwirq schema` drops a local copy so validation needs no network/hosting. */
export const LOCAL_SCHEMA_REL = '.qwirq/qwirq.schema.json'

/** Write the schema into a project's .qwirq/ and return the relative path used for the modeline. */
export function writeLocalSchema(projectDir) {
  const dir = join(projectDir, '.qwirq')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'qwirq.schema.json'), readFileSync(SCHEMA_PATH, 'utf8'))
  return LOCAL_SCHEMA_REL
}

/** The yaml-language-server modeline that points an editor at a schema (URL or relative path). */
export const modeline = (ref) => `# yaml-language-server: $schema=${ref}`

/** Ensure `text` begins with a yaml-language-server modeline; returns the (possibly updated) text. */
export function ensureModeline(text, ref) {
  if (/^#\s*yaml-language-server:\s*\$schema=/m.test(text)) return text
  return `${modeline(ref)}\n${text}`
}
