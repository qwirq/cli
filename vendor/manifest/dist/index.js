/**
 * @qwirq/manifest — the qwirq.yaml manifest, consolidated (#93): one schema, one set of types, one
 * parser/validator, one registry mapping. Consumers: apps/runner (build/release), apps/cli
 * (`qwirq validate` / `qwirq schema`), apps/vscode (bundled schema). The JSON Schema is the canonical
 * copy at schemas/qwirq.schema.json (also exported as the package subpath `@qwirq/manifest/schema`);
 * the public URL is its $id, https://qwirq.com/schemas/qwirq.schema.json.
 */
export * from './types.js';
export { SCHEMA_URL, loadSchema, parseManifestText, validateManifest, readManifest } from './validate.js';
export { containerName, manifestToInstanceApp } from './registry.js';
