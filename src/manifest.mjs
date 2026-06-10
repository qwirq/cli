// qwirq.yaml manifest: parse + validate (DX-5, #44). The SAME JSON schema VS Code validates against
// (schemas/qwirq.schema.json, $id https://qwirq.com/schemas/qwirq.schema.json) drives a small
// schema-subset validator here, so the CLI and the editor enforce one set of rules with no second copy
// of the logic. We also write the schema into a project + add the `# yaml-language-server` modeline so
// the editor validates with just the standard YAML extension, no hosting required.
import { parse as parseYaml } from 'yaml'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(here, '..', 'schemas', 'qwirq.schema.json')

/** The canonical published schema URL (its $id). Served publicly so any editor can fetch it. */
export const SCHEMA_URL = 'https://qwirq.com/schemas/qwirq.schema.json'
/** Where `qwirq schema` drops a local copy so validation needs no network/hosting. */
export const LOCAL_SCHEMA_REL = '.qwirq/qwirq.schema.json'

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
}

/** Parse YAML text into a value; throws a readable error on a syntax error. */
export function parseManifestText(text) {
  try {
    return parseYaml(text)
  } catch (e) {
    throw new Error(`qwirq.yaml is not valid YAML: ${e.message}`)
  }
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v)
const jsonType = (v) => {
  const t = typeOf(v)
  if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return t
}

// A focused validator for the subset of JSON Schema our manifest schema uses (type, required,
// properties, additionalProperties:false, pattern, enum, minLength, minProperties, items). Returns a
// list of `path: message` strings; empty = valid.
function check(value, schema, path, errors) {
  if (schema.type) {
    const jt = jsonType(value)
    const want = schema.type
    const ok = want === 'integer' ? jt === 'integer' : want === 'number' ? jt === 'integer' || jt === 'number' : jt === want
    if (!ok) { errors.push(`${path || '(root)'}: expected ${want}, got ${jt}`); return }
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path || '(root)'}: missing required "${req}"`)
    }
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path || '(root)'}: needs at least ${schema.minProperties} of ${Object.keys(schema.properties ?? {}).join('/')}`)
    }
    const props = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${path ? path + '.' : ''}${k}: unknown field (check spelling)`)
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) check(value[k], sub, path ? `${path}.${k}` : k, errors)
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, errors))
  }
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: must not be empty`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`)
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: "${value}" is not one of ${schema.enum.join(', ')}`)
  }
}

/** Validate a parsed manifest value against the bundled schema. Returns string[] of errors ([] = ok). */
export function validateManifest(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return ['qwirq.yaml: the manifest must be a YAML object']
  }
  const errors = []
  check(value, loadSchema(), '', errors)
  return errors
}

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
