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

## Config

`~/.qwirq/config.json`: `{ apiBase, authBase, token, company }`. Overrides via env: `QWIRQ_API_URL`,
`QWIRQ_AUTH_URL`, `QWIRQ_GIT_URL`, `QWIRQ_TOKEN`, `QWIRQ_HOME` (config dir + credential store).
Defaults point at production (`https://auth.qwirq.com`, `https://api.qwirq.com`,
`https://git.qwirq.com`).

The stored token is a personal access token: long-lived, scoped to one (user, company), and
revocable server-side. `qwirq logout` forgets it locally.

## Agent / non-interactive auth

Agents and CI runners have two supported auth surfaces.

Use `QWIRQ_TOKEN` when the process already holds a PAT and should not persist it:

```
QWIRQ_TOKEN=<PAT> qwirq whoami
```

`QWIRQ_TOKEN` takes precedence over the keychain for every command. Nothing is written to disk.

Use `QWIRQ_HOME` for durable profile isolation on a shared machine:

```
QWIRQ_HOME=~/.qwirq-agent qwirq whoami
QWIRQ_HOME=~/.qwirq-agent qwirq git setup
```

`QWIRQ_HOME` redirects both the config directory and the OS credential store. Use one directory per
identity, such as `~/.qwirq-keystone` for a builder agent and the default `~/.qwirq` for the owner.
The git credential-helper calls the same token resolver as every other command, so git pushes follow
the selected `QWIRQ_HOME` profile too.
