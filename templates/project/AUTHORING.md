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

## Shipping

`qwirq.yaml` + `src/app` build into a Module-Federation remote and deploy into your instance on `git
push`. The React UI reaches app data through the in-instance backend seam (`provides.functions`, DX-4)
when you grow past CLI-first.
