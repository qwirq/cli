// qwirq.yaml manifest — the CLI's thin adapter over @qwirq/manifest (#93). The parse/validate logic and
// the JSON Schema now live ONCE in the shared package (deps-free JS build, 0.3.0); the CLI re-exports the
// parse/validate surface and keeps only the editor-integration helpers (write the schema into a project +
// the yaml-language-server modeline) that are CLI-specific. No second copy of the validator or the schema.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Single source of truth: the shared parser/validator + the canonical schema URL ($id).
export { parseManifestText, validateManifest, loadSchema, SCHEMA_URL } from '@qwirq/manifest'

// The bundled JSON Schema ships with @qwirq/manifest (its `./schema` subpath) — resolve its on-disk path
// so `qwirq schema` can copy it into a project. require.resolve honors the package `exports` map.
const require = createRequire(import.meta.url)
const SCHEMA_PATH = require.resolve('@qwirq/manifest/schema')

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
