# @qwirq/cli

`qwirq` — work with QWIRQ **Knowledge (Texere)** and **Secrets** from the terminal. A zero-dependency
Node CLI (Node 18+) over [`@qwirq/api`](../api). Auth is the device flow: `qwirq login` opens a
browser, you approve, and a personal access token is stored in `~/.qwirq/config.json` (0600).

## Install (dev)

```
cd apps/cli
npm link            # puts `qwirq` on PATH
# or run directly:
node bin/qwirq.mjs <command>
```

## Use

```
qwirq login                       # device flow -> browser -> token
qwirq whoami

qwirq weave ls
qwirq weave new "Runbooks"
qwirq tree <weaveQID>

qwirq article new --weave <id> --title "Deploy" --file deploy.md
qwirq article get <qid>           # prints markdown
qwirq article edit <qid>          # opens $EDITOR, saves on close
qwirq article rm <qid>

qwirq secret ls
qwirq secret set DB_URL           # hidden prompt (or: echo -n val | qwirq secret set DB_URL --stdin)
qwirq secret reveal DB_URL        # audited server-side
qwirq secret rm DB_URL
```

## Pipeline jobs (M0)

```
qwirq jobs <repo> [--sha <sha>] [--state <state>] [--json]   jobs (checks), grouped by commit
qwirq jobs show <qid> [--json]                  steps, attempts, artifacts, what you can do
qwirq jobs logs <qid> --attempt <n> [--follow] [--json]
qwirq jobs retry <qid> --attempt <n>            queue attempt n+1 (n = the attempt you saw)
qwirq jobs cancel <qid> --attempt <n>           cancel a queued (n may be 0) or running job
qwirq watch <repo> [--sha <sha>] [--json]       watch one push's jobs to the end
qwirq project status <repo> [--json]            what the latest push did (also: qwirq repo status)
```

- `watch` fixes its target (push, commit, job numbers) at start; a later push never replaces it.
  Ctrl+C stops watching; it never cancels a job.
- `logs --follow` reads by (attempt, `after` cursor), polling every 500 ms. Overlapping pages are
  dropped by sequence, a dropped connection resumes after the last printed line, and when the job
  moves to a new attempt (lease lost, retry) it says so and follows that attempt from line 1.
- `--json`: reads print the API response; `logs` and `watch` print NDJSON events
  (`line` {jobQID, attempt, seq, at, step, stream, text}, `attempt`, `truncated`, `target`, `job`, `end`).
  Errors go to stderr as `{code, status, message}`.
- Exit codes: 0 success; 1 a followed job, or a required watched job, failed, was cancelled, timed
  out, or (watch) was skipped because a dependency failed, or the push was not admitted (optional
  failures are reported, exit 0); 2 usage, auth, permission, not-found, conflict, or connection error (stderr
  carries the stable `[code]`); 130 stopped with Ctrl+C.

`qwirq validate` also plans a `pipeline:` the way the engine will (duplicate names, unknown or
cyclic `needs`, paths escaping the workspace). Verify offline: `npm run verify:pipeline-cli`.

## Config

`~/.qwirq/config.json`: `{ apiBase, authBase, token, company }`. Overrides via env: `QWIRQ_API_URL`,
`QWIRQ_AUTH_URL`, `QWIRQ_TOKEN`, `QWIRQ_HOME` (config dir). Defaults point at local dev
(`http://localhost:5000` / `:4000`).

The stored token is a personal access token: long-lived, scoped to one (user, company), and
revocable server-side. `qwirq logout` forgets it locally.
