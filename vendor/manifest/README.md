# vendored: @qwirq/manifest@0.4.0

This is a **vendored copy** of `@qwirq/manifest@0.4.0` (`dist/` runtime + `schemas/`), inlined so the
public `qwirq/cli` installs from a clean machine with **no `@qwirq:registry` override and no GitHub
Packages token**. `@qwirq/manifest` is gated (GitHub Packages only); a published `dependencies` entry on
it 404s for any client running `npm i -g github:qwirq/cli` (#166).

Runtime footprint is gated-dep-free: the `dist/*.js` import only `yaml` (public) + node builtins. The
`@qwirq/core` reference in the upstream package is **type-only** (`import type` in `registry.d.ts`), erased
at runtime, so it is not vendored.

Layout mirrors the upstream package so `validate.js`'s `path.join(here, '..', 'schemas',
'qwirq.schema.json')` resolves (the #241 dist/schemas-sibling landmine): keep `dist/` and `schemas/`
siblings.

Copy EVERY `dist/*.js` — `index.js` imports `./pipeline.js` (0.4.0, M0 pipeline normalizer), so a
missing module breaks every import of the runtime.

To refresh: rebuild `lib/manifest` (`npm run build`) and re-copy `dist/*.js` + `schemas/*.json` here.
Source of truth stays `lib/manifest`; this is a packaging mirror for the public install path only.
0.4.0 copied from `lib/manifest` @ 205bd77 (`m0/pipeline-manifest`).
