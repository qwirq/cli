/**
 * @qwirq/manifest — the qwirq.yaml manifest, consolidated (#93): one schema, one set of types, one
 * parser/validator, one registry mapping, one pipeline normalizer (planPipeline -> JobPlan[], M0).
 * Consumers: apps/runner (build/release, pipeline worker), apps/cli (`qwirq validate` / `qwirq schema`),
 * apps/vscode (bundled schema), lib/pipeline (JobPlan contract). The JSON Schema is the canonical
 * copy at schemas/qwirq.schema.json (also exported as the package subpath `@qwirq/manifest/schema`);
 * the public URL is its $id, https://qwirq.com/schemas/qwirq.schema.json.
 */
export * from './types.js';
export { SCHEMA_URL, loadSchema, parseManifestText, validateManifest, warnManifest, readManifest, isPipelineOnly } from './validate.js';
export { containerName, manifestToInstanceApp } from './registry.js';
export { planPipeline, containedPath } from './pipeline.js';
