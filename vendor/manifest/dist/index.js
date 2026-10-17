/**
 * @qwirq/manifest — the qwirq.yaml manifest, consolidated (#93): one schema, one set of types, one
 * parser/validator, one registry mapping, one pipeline normalizer (planPipeline -> JobPlan[]) and its
 * engine-side twin (normalizeJobPlans), one build/channel normalizer (planBuilds), and the shared
 * grammar (image refs, branch refs, paths, globs), network profiles, and the declared-input primitive
 * (one Input union for checks and builds; the qwirq.input-tree.v1 digest).
 * Consumers: apps/runner (build/release, pipeline worker, executor), apps/cli (`qwirq validate` /
 * `qwirq schema`), apps/vscode (bundled schema), lib/pipeline (JobPlan contract + grammar). The JSON
 * Schema is the canonical copy at schemas/qwirq.schema.json (also exported as the package subpath
 * `@qwirq/manifest/schema`); the public URL is its $id, https://qwirq.com/schemas/qwirq.schema.json.
 */
export * from './types.js';
export { SCHEMA_URL, loadSchema, parseManifestText, validateManifest, warnManifest, readManifest, isPipelineOnly, checkManifest, checkSchemaNode } from './validate.js';
export { containerName, manifestToInstanceApp } from './registry.js';
export { IMAGE_PATTERN_SOURCE, IMAGE_MAX_LENGTH, isPinnedImage, containedPath, DEFAULT_TARGET_REF, validBranchRef, normalizeGlob, matchPathGlob, classifySchemaIssue, CHANNEL_NAME_PATTERN_SOURCE, isChannelName, } from './grammar.js';
export { MAX_JOBS, matrixJobName, evaluateTrigger, normalizeJobPlans } from './pipeline.js';
export { planPipeline, planBuilds } from './plan.js';
export { DEFAULT_ARCHITECTURES } from './builds.js';
export { INPUT_KINDS, CHECK_INPUT_KINDS, MAX_INPUTS, MAX_FILE_INPUTS, MAX_DOWNLOAD_INPUTS, INPUT_MOUNT_ROOT, INPUT_TREE_DIGEST, NPM_SEED_FORMAT, NPM_LOCKFILE_VERSIONS, INPUT_PATH_PATTERN_SOURCE, INPUT_PATH_MAX_LENGTH, inputMountPath, npmCachePath, isInputPath, utf8Compare, inputSelects, fileSha256, inputTreeSha256, verifyNpmLockfile, upgradeBuildInputs, } from './inputs.js';
export { NETWORK_PROFILES, DEPENDENCY_EGRESS_POLICY, egressPolicySha256, isAllowedEgressHost } from './profiles.js';
