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
`QWIRQ_AUTH_URL`, `QWIRQ_TOKEN`, `QWIRQ_HOME` (config dir). Defaults point at production
(`https://auth.qwirq.com` / `https://api.qwirq.com`).

The stored token is a personal access token: long-lived, scoped to one (user, company), and
revocable server-side. `qwirq logout` forgets it locally.

## Agent / non-interactive auth

Agents and CI runners have two supported auth paths:

**Option A: environment variable (stateless)**

```
QWIRQ_TOKEN=<PAT> qwirq whoami
```

`QWIRQ_TOKEN` takes precedence over the keychain for every command. Nothing is written to disk.
This is the fastest path for a script that already holds the PAT.

**Option B: isolated credential store (durable)**

```
# Provision once:
QWIRQ_HOME=~/.qwirq-agent qwirq login --token <PAT>   # writes PAT into ~/.qwirq-agent/

# Then run all commands under the same home:
QWIRQ_HOME=~/.qwirq-agent qwirq whoami
QWIRQ_HOME=~/.qwirq-agent qwirq git setup    # agent git pushes authenticate too
```

`QWIRQ_HOME` redirects the config directory AND the OS credential store. On Windows this means
a DPAPI-encrypted `token.dpapi` under the agent's home; on Linux/macOS the keychain entry is
namespaced. The agent's session and the owner's `~/.qwirq` are fully isolated — no collision.

`qwirq login --token -` reads the PAT from stdin (useful in provisioning scripts that pipe the value):

```
echo "$MY_PAT" | QWIRQ_HOME=~/.qwirq-agent qwirq login --token -
```

Mint agent PATs from an owner session:

```
qwirq agent new agent@example.com --role builder    # create the agent principal
qwirq agent token agent@example.com --name "agent-1" --no-expiry   # shown once
```
