# __NAME__ — a QWIRQ app

Scaffolded by `qwirq init`. A QWIRQ Project: a `qwirq.yaml` manifest + a React UI (`provides.app`) that
deploys into your QWIRQ instance via `git push`, plus server-side logic on the published platform
primitives (`@qwirq/tasks`, `@qwirq/cmdb`) over `@qwirq/bridge` + `@qwirq/schema`. Autocomplete is just
TypeScript over those typed packages.

## The local loop

```sh
npm install          # pulls @qwirq/* from GitHub Packages (.npmrc + a read:packages token)
qwirq dev            # binds your dev app DB (QWIRQ_DB_URL) and runs `npm run dev`
```

`qwirq dev` resolves a dev app-DB connection from the vault secret `__NAME___dev_db_url` (override with
`qwirq dev --db <secret>` or by setting `QWIRQ_DB_URL` yourself), then runs your `dev` script with it
bound. `scripts/dev.ts` ensures the primitive tables (`migrateTasks`/`migrateCmdb`, idempotent) and
exercises the libs; `src/server/store.ts` is the seam (`appDb()` → a bridge; `ensureSchema()` → the
tables).

## TypeScript: the typed bridge

The `@qwirq/tasks` and `@qwirq/cmdb` APIs are already fully typed. For raw bridge access to YOUR tables,
run `qwirq types` (or `npm run types`): it introspects the app DB and writes `.qwirq/schema.d.ts`. Then:

```ts
import { createBridge } from '@qwirq/bridge'
import type { QwirqDB } from '../.qwirq/schema'
const b = createBridge<QwirqDB>(process.env.QWIRQ_DB_URL!)
await b('your_table').where({ some_column: 'x' }).all()   // columns autocomplete; typos are compile errors
```

Regenerate after any schema change. `.qwirq/` is gitignored (it is generated).

## The manifest (`qwirq.yaml`)

`qwirq.yaml` declares how your project presents and runs: `id`/`name`/`icon`/`nav`, an optional PDP
`requires` gate, and `provides` (a UI `app`, backend `functions`, scheduled `jobs`) plus `data.migrations`,
`runtime`, and the `platform` pin. The build pipeline parses it into your instance's app registry entry +
runner entries. Full field reference: the JSON schema at `https://qwirq.com/schemas/qwirq.schema.json`.

**Validation + autocomplete** are wired out of the box: `qwirq init` writes `.qwirq/qwirq.schema.json` and
adds a `# yaml-language-server: $schema=…` line to `qwirq.yaml`, so with the standard **YAML** extension
(`redhat.vscode-yaml`) the manifest validates + autocompletes inline. Check it from the terminal anytime:

```sh
qwirq validate          # validates ./qwirq.yaml against the schema
qwirq schema            # (existing projects) add the schema + $schema line if you don't have them
```

## VS Code

Install the **QWIRQ** extension (`apps/vscode`, `qwirq-vscode-*.vsix`) for the CLI in the Command Palette
("QWIRQ:"), `Generate Schema Types`, and snippets. Set `qwirq.cliCommand` if `qwirq` is not on your PATH.
(Manifest validation works with just the YAML extension above — the QWIRQ extension is not required for it.)

## Shipping

`qwirq.yaml` + `src/app` build into a Module-Federation remote and deploy into your instance on `git
push`. The React UI reaches app data through the in-instance backend seam (`provides.functions`, DX-4)
when you grow past CLI-first.
