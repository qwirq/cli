# vendored: @qwirq/manifest@0.6.0

This is a **vendored copy** of `@qwirq/manifest@0.6.0` (`dist/` runtime + `schemas/`), inlined so the
public `qwirq/cli` installs from a clean machine with **no `@qwirq:registry` override and no registry
token**. `@qwirq/manifest` is gated (private registry: 0.4.0 lives on registry.qwirq.com, older versions on
GitHub Packages); a published `dependencies` entry on
it 404s for any client running `npm i -g github:qwirq/cli` (#166).

Runtime footprint is gated-dep-free: the `dist/*.js` import only `yaml` (public) + node builtins
(`node:crypto` for the 0.6.0 input digests). The
`@qwirq/core` reference in the upstream package is **type-only** (`import type` in `registry.d.ts`), erased
at runtime, so it is not vendored.

Layout mirrors the upstream package so `validate.js`'s `path.join(here, '..', 'schemas',
'qwirq.schema.json')` resolves (the #241 dist/schemas-sibling landmine): keep `dist/` and `schemas/`
siblings.

Copy EVERY `dist/*.js` (10 files in 0.6.0: builds, grammar, index, inputs, pipeline, plan, profiles,
registry, types, validate). `index.js` imports its siblings, so one missing module breaks every import of the
runtime.

To refresh: rebuild `lib/manifest` (`npm run build`) and re-copy `dist/*.js` + `schemas/*.json` here.
Source of truth stays `lib/manifest`; this is a packaging mirror for the public install path only.
0.6.0 copied from the pack of `lib/manifest` @ 1a745c8 (`m1/manifest-06-inputs`, not yet published):
`git -c core.autocrlf=false archive 1a745c8 | npm pack` (prepack builds dist) -> qwirq-manifest-0.6.0.tgz
sha256 54c6c6fc803f8a881796799cedcbf02b1eb79cf6a34f98b5728f68486fd8493f; `package/dist/*.js` +
`package/schemas/*.json` copied byte-for-byte (CR-free).

