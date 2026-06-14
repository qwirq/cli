#!/usr/bin/env node
// qwirq — the QWIRQ command line. Work with Knowledge (Texere) and Secrets from the terminal.
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiFetch, appCall, authFetch } from '../src/api.mjs'
import { login } from '../src/login.mjs'
import { loadConfig, clearConfig, readToken } from '../src/config.mjs'
import { parseArgs, asList, parseKeyVals, out, err, fail, readStdin, promptHidden, promptYesNo, copyToClipboard, editInEditor } from '../src/util.mjs'
import { parseManifestText, validateManifest, writeLocalSchema, ensureModeline, LOCAL_SCHEMA_REL, SCHEMA_URL } from '../src/manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// Resolve a dev app-DB connection for `qwirq dev` / `qwirq types` (#64). Order:
//   QWIRQ_DB_URL  >  --db <secret>  >  the platform dev-connection endpoint (lazily creates the
//   tenant's dev branch)  >  the legacy `<qwirq.yaml id>_dev_db_url` vault secret.
// Exits via fail() if nothing resolves.
async function resolveDevDbUrl(flags) {
  if (process.env.QWIRQ_DB_URL) return process.env.QWIRQ_DB_URL
  if (typeof flags.db === 'string') {
    try { return (await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(flags.db)}/reveal`)).value }
    catch { return fail(`no dev DB: secret "${flags.db}" not found`) }
  }
  // The platform path: the control plane returns (and first-time creates) YOUR tenant's dev
  // environment, a copy-on-write branch of prod. No hand-stashed secret needed.
  try {
    const r = await apiFetch('GET', '/api/v1/data/connection?env=dev')
    if (r && r.uri) {
      if (r.created) console.error('qwirq: created your dev database environment (a branch of prod)')
      return r.uri
    }
  } catch { /* fall through to the legacy stashed secret */ }
  let id
  try { id = (readFileSync('qwirq.yaml', 'utf8').match(/^id:\s*(\S+)/m) || [])[1] } catch { /* no manifest */ }
  if (id) {
    try { return (await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(id + '_dev_db_url')}/reveal`)).value }
    catch { /* nothing stashed either */ }
  }
  return fail('no dev DB: the platform could not issue a dev connection (signed in? has `qwirq data provision` run?). Set QWIRQ_DB_URL or pass --db <secret>.')
}

const HELP = `qwirq — Knowledge (Texere) + Secrets from the terminal

  qwirq login [--no-browser]        sign in (device flow)
  qwirq logout                      forget the stored token
  qwirq whoami                      show user + active company

  qwirq weave ls                    list weaves (🔒 = restricted)
  qwirq weave new <name>            create a weave
  qwirq weave rm <weaveQID> [--yes] delete a weave and everything in it (asks to confirm)
  qwirq weave access <weaveQID>     show a weave's audience (open, or who it's restricted to)
  qwirq weave restrict <weaveQID> <email|role|group> [--role|--group] [--manage] [--remove]
  qwirq tree <weaveQID>             show a weave's thread/article tree

  qwirq thread new --weave <id> --title <t>   create a thread (section) in a weave
  qwirq article get <qid>           print an article's markdown
  qwirq article edit <qid>          edit an article body in $EDITOR
  qwirq article new --weave <id> --title <t> [--thread <id>] [--file <f> | --stdin]
  qwirq article rm <qid>            delete an article (or thread) and its subtree
  qwirq node access <qid>           show a document/thread's audience (open, or who it's restricted to)
  qwirq node restrict <qid> <email|role|group> [--role|--group] [--manage] [--remove]

  qwirq secret ls [query] [--mine|--company] [--cat <c>]   list/search secrets, grouped by category
  qwirq secret show <name>          view a secret object (label, key, category, scope; value hidden)
  qwirq secret reveal <name>        print a secret value (audited)
  qwirq secret copy <name>          copy a secret value to the clipboard (audited; no terminal echo)
  qwirq secret set <name> [--stdin] [--label <t>] [--key <k>] [--desc <text>] [--cat <c>]   set value/metadata/category
  qwirq secret cat new <name> [--desc <t>]   create a category (organize; categories never grant access)
  qwirq secret cat ls               list categories (with how many secrets you can see in each)
  qwirq secret cat rename <old> <new>   rename a category
  qwirq secret cat rm <name>        delete a category (its secrets become Uncategorized; nothing is deleted)
  qwirq secret rm <name> [--yes]    delete a secret (asks to confirm)
  qwirq secret share <name> <email|role|group> [--role|--group] [--read|--manage|--own]
  qwirq secret unshare <name> <email|role|group> [--role|--group]
  qwirq secret grants <name>        show who a secret is shared with
  qwirq members                     list your company's members

  qwirq token mint [--name <l>] [--scope <s>] [--expires <days> | --no-expiry]   mint a personal access token (shown once)
  qwirq token ls                    list your access tokens (status, scope, dates; never the value)
  qwirq token revoke <qid> [--yes]  revoke one of your tokens (takes effect immediately)
  qwirq agent ls                    list agent principals (owner only)
  qwirq agent new <email> [--role builder|owner]   create an agent principal (no password; owner only)
  qwirq agent suspend <email> [--yes]   suspend an agent — revokes ALL its tokens + disables it (owner only)
  qwirq agent unsuspend <email>      unsuspend an agent principal (owner only)
  qwirq agent token <email> [--name <l>] [--scope <s>] [--expires <days> | --no-expiry]   mint a PAT for an agent (owner only)
  qwirq agent tokens <email>        list an agent's tokens (owner only)
  qwirq agent revoke <email> <qid> [--yes]   revoke an agent's token (owner only)

  qwirq group ls                    list groups
  qwirq group create <name>         create a group (admin)
  qwirq group members <name>        list a group's members
  qwirq group add <name> <email>    add a member to a group (admin)
  qwirq group rm <name> <email>     remove a member from a group (admin)

  qwirq init <name>                 scaffold a QWIRQ app (qwirq.yaml + React UI + @qwirq/tasks/cmdb)
  qwirq validate [--file <f>]       validate qwirq.yaml against the manifest schema (default: ./qwirq.yaml)
  qwirq schema [--url]              add editor validation: write .qwirq/qwirq.schema.json + a $schema line
                                    to qwirq.yaml (use --url to point at the public schema URL instead)
  qwirq dev [--db <secret>]         run the project locally with a dev app DB bound (QWIRQ_DB_URL)
  qwirq types [--db <secret>]       generate .qwirq/schema.d.ts (typed bridge against your real schema)

  qwirq repo ls                     list repositories you can access
  qwirq repo new <slug> [--name <t>]   create a repository (private git repo)
  qwirq repo rename <slug> [--slug <new>] [--name <t>]   rename a repository
  qwirq repo rm <slug> [--yes]      delete a repository (asks to confirm)
  qwirq repo share <slug> <email|role|group> [--role|--group] [--read|--manage|--own]
  qwirq repo unshare <slug> <email|role|group> [--role|--group]
  qwirq repo grants <slug>          show who a repository is shared with
  qwirq project <sub>               (deprecated alias for 'qwirq repo'; use 'qwirq repo' instead)
  qwirq git setup                   let git authenticate to git.qwirq.com with your qwirq login
  qwirq clone <repo>                clone a repository over HTTPS (uses your login, no keys)

  qwirq data status                 is there an app database for your company yet?
  qwirq data provision              create your company's isolated app database
  qwirq data tables [--env <e>]     list tables in your app database (default env: prod)
  qwirq data query "<sql>" [--env]  run SQL against your app database
  qwirq data migrate [--dir <d>] [--env]   apply *.sql migrations (default dir: migrations)
  qwirq data migrations [--env]     list applied migrations

  qwirq work init [--env]           create the work-item tables in your app database
  qwirq work-type define <name> --prefix <P> --states a,b,c [--initial a] [--transitions "a>b,b>c"]
                                    [--parents t1,t2 | --no-parent] [--require-parent] [--ext] [--required f1,f2]
                                    [--transition-rule "a>b:assignee,note,fields(x|y)"] [--field-type "k:enum(x|y)"]   define a work-item type
  qwirq work-type update <name> [--prefix P] [any define flag …]   evolve a type's policy (no occupied state may vanish)
  qwirq work-type ls                list work-item types
  qwirq work-type show <name>       show one type's policy (states, transitions, rules, field types)
  qwirq work-type rm <name>         remove a type
  qwirq link-type define <name> [--from-types a,b] [--to-types c,d] [--from-states s] [--max-from N] [--max-to N]
                                    register/constrain a typed link (unregistered link types stay opaque)
  qwirq link-type ls | show <name> | rm <name>   inspect / unregister link-type constraints
  qwirq work ls [--type t] [--state s] [--assignee a] [--parent <ref> | --roots]   list work items
  qwirq work show <ref>             show a work item (fields, links, CIs, recent events)
  qwirq work new --type t --title "..." [--parent <ref>] [--assignee a] [--priority n] [--due d] [--field k=v ...]
  qwirq work set <ref> [--title <t>] [--assignee a] [--priority n] [--due d] [--field k=v ...]
  qwirq work move <ref> <parentRef | --root>    re-parent a work item
  qwirq work transition <ref> <state> [--note "..."]   move it to a new state
  qwirq work tree <ref>             print the subtree under a work item
  qwirq work rm <ref> [--yes]       delete a work item (must have no children)
  qwirq work link <from> <to> --type <t> [--remove]    typed link between two work items
  qwirq work link-ci <ref> <ciRef> [--rel <r>] [--remove]   link a work item to a CMDB CI

  qwirq ci init [--env]             create the CMDB tables in your app database
  qwirq ci-type define <name> --prefix <P> [--attr k=type ...]   define a CI type
  qwirq ci-type update <name> [--prefix P] [--attr k=type ...]   update prefix / merge attribute schema
  qwirq ci-type ls                  list CI types
  qwirq ci-type show <name>         show one CI type
  qwirq ci-type rm <name>           remove a CI type
  qwirq ci ls [--type t] [--name n]   list CIs
  qwirq ci show <ref>               show a CI and its relationships
  qwirq ci new --type t --name "..." [--attr k=v ...]
  qwirq ci set <ref> [--name <n>] [--attr k=v ...]
  qwirq ci rm <ref> [--yes]         delete a CI (its relationships cascade)
  qwirq ci relate <from> <to> --type <relType> [--remove]   typed directional CI relationship

  (work/ci verbs accept --env <e>; default prod. Run 'qwirq work init' / 'qwirq ci init' once first.)

  qwirq workplan init [--env <e>]       install/update the six Workplan type policies (REQ/PRJ/EPC/STY/TSK/SPR); idempotent
  qwirq workplan types [--env <e>]      show which Workplan types are installed and their state machines
  qwirq workplan create <type> --title "..." [--parent <ref> | --project <p> | --epic <e> | --story <s>]
                                        [--assignee a] [--priority n] [--due d] [--points n]
                                        [--start <date> --end <date>] [--field k=v ...] [--json] [--env <e>]
                                        create a Workplan item (type = request|project|epic|story|task|sprint)
  qwirq workplan set <ref> [--title t] [--assignee a] [--priority n] [--due d] [--points n]
                                        [--field k=v ...] [--json] [--env <e>]   edit fields on any Workplan item
  qwirq workplan transition <ref> <state> [--note "..."] [--json] [--env <e>]   guarded state transition
  qwirq workplan move <ref> (<parentRef> | --root) [--json] [--env <e>]   reparent a Workplan item
  qwirq workplan link <from> <to> --type <t> [--remove] [--json] [--env <e>]   typed link between items
  qwirq workplan sprint assign <storyRef> <sprintRef> [--remove] [--json] [--env <e>]   sprint membership
  qwirq workplan ls [--type t] [--state s] [--assignee a] [--parent <ref>] [--roots] [--json] [--env <e>]
  qwirq workplan show <ref> [--json] [--env <e>]   show a Workplan item with links and recent events

  (Transitions are server-gated — owner required to start projects/stories/tasks; story points required
   before in-review; terminal states: rejected/converted, done/cancelled, closed. Sprint assignment uses
   'workplan sprint assign'. Type hierarchy: request, project -> epic -> story -> task, sprint.)

  Pass --as <email> to any authenticated command to ASSERT your identity: the CLI verifies the
  signed-in session resolves to that email and refuses (exit 1, no write) on a mismatch, so a script
  never mis-attributes a write to whoever happens to be logged in.

Endpoints default to production (auth/api/git .qwirq.com) and can be overridden in
~/.qwirq/config.json (keys authBase/apiBase/gitBase) or per-command via QWIRQ_AUTH_URL,
QWIRQ_API_URL, QWIRQ_GIT_URL. \`qwirq logout\` clears your login but keeps those overrides.

Agent auth and profile isolation:
  QWIRQ_TOKEN=<PAT>    use this PAT for every command, before any stored token/keychain lookup.
                       This is the stateless path for agents and CI that already hold a PAT.
  QWIRQ_HOME=<dir>     use <dir> instead of ~/.qwirq for config and the OS credential store.
                       Use one QWIRQ_HOME per agent/profile so owner and builder sessions never
                       collide. The git credential-helper and every qwirq command read the same
                       scoped token, so git pushes follow the selected profile too.

Exit codes (stable, for scripts): 0 success; 1 any error (a message is printed to stderr).
A \`dev\`/\`types\` run exits with the underlying npm script's code.`

function indentTree(nodes, depth, lines) {
  for (const n of nodes || []) {
    const mark = n.kind === 'thread' ? '▸' : '·'
    lines.push(`${'  '.repeat(depth)}${mark} ${n.restricted ? '🔒 ' : ''}${n.title}  (${n.qid})`)
    if (n.children?.length) indentTree(n.children, depth + 1, lines)
  }
}

const csv = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean)

// Parse a --transition-rule "<from>><to>:<flag>[,<flag>]" into [edge, rule] (tasks 0.2, #124). Flags:
// note|assignee|weave (booleans) and fields(a|b|c) (requireFields list). e.g. "todo>doing:assignee,note".
function parseTransitionRule(s) {
  const ci = s.indexOf(':')
  const edge = (ci < 0 ? s : s.slice(0, ci)).trim()
  if (!/^[^>]+>[^>]+$/.test(edge)) throw new Error(`bad --transition-rule edge "${edge}" (expected from>to)`)
  const rule = {}
  for (const f of (ci < 0 ? '' : s.slice(ci + 1)).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = f.match(/^fields\(([^)]*)\)$/)
    if (m) rule.requireFields = m[1].split('|').map((x) => x.trim()).filter(Boolean)
    else if (f === 'note') rule.requireNote = true
    else if (f === 'assignee') rule.requireAssignee = true
    else if (f === 'weave') rule.requireWeave = true
    else throw new Error(`unknown transition-rule flag "${f}" (note|assignee|weave|fields(a|b))`)
  }
  return [edge, rule]
}

// Parse a --field-type "<name>:<kind>[(v1|v2)]" into [name, fieldType] (tasks 0.2, #124). Kinds:
// string|number|boolean|date|enum(a|b)|numeric-enum(1|2|3). e.g. "points:numeric-enum(1|2|3|5|8)".
function parseFieldType(s) {
  const ci = s.indexOf(':')
  if (ci < 0) throw new Error(`bad --field-type "${s}" (expected name:kind)`)
  const name = s.slice(0, ci).trim()
  const m = s.slice(ci + 1).trim().match(/^([a-z-]+)(?:\(([^)]*)\))?$/)
  if (!m) throw new Error(`bad --field-type spec for "${name}"`)
  const kind = m[1]
  const vals = (m[2] || '').split('|').map((x) => x.trim()).filter(Boolean)
  if (kind === 'enum') return [name, { kind: 'enum', values: vals }]
  if (kind === 'numeric-enum') return [name, { kind: 'numeric-enum', values: vals.map(Number) }]
  if (['string', 'number', 'boolean', 'date'].includes(kind)) return [name, { kind }]
  throw new Error(`unknown field-type kind "${kind}" (string|number|boolean|date|enum(...)|numeric-enum(...))`)
}

// Build a work-item-type policy from flags, merged onto `base` (the existing policy for `update`, {} for
// `define`). Only keys whose flags are present are overridden; the rest carry over. Covers the 0.1 policy
// + the 0.2 keys (requireParent, transitionRules, fieldTypes) so both define and update set them (#124).
function buildPolicy(flags, base = {}, requireStates = false) {
  const policy = { ...base }
  if (flags.states !== undefined) {
    const states = csv(flags.states)
    if (!states.length) throw new Error('--states must be a non-empty comma list')
    policy.states = states
  }
  if (requireStates && !(policy.states && policy.states.length)) throw new Error('--states is required (e.g. open,closed)')
  if (flags.initial !== undefined) policy.initialState = String(flags.initial)
  else if (policy.initialState == null && policy.states) policy.initialState = policy.states[0]
  if (flags.transitions !== undefined) {
    const transitions = {}
    for (const pair of csv(flags.transitions)) {
      const [from, to] = pair.split('>').map((s) => s.trim())
      if (!from || !to) throw new Error(`bad --transitions entry "${pair}" (expected from>to)`)
      ;(transitions[from] ||= []).push(to)
    }
    policy.transitions = transitions
  } else if (policy.transitions == null) policy.transitions = {}
  if (flags['no-parent']) policy.allowedParentTypes = []
  else if (flags.parents !== undefined) policy.allowedParentTypes = csv(flags.parents)
  else if (policy.allowedParentTypes === undefined) policy.allowedParentTypes = null
  if (flags.required !== undefined) policy.requiredFields = csv(flags.required)
  else if (policy.requiredFields == null) policy.requiredFields = []
  if (flags.ext) policy.hasExtension = true
  else if (flags['no-ext']) policy.hasExtension = false
  else if (policy.hasExtension == null) policy.hasExtension = false
  if (flags['require-parent']) policy.requireParent = true
  else if (flags['no-require-parent']) policy.requireParent = false
  const rules = asList(flags['transition-rule'])
  if (rules.length) {
    policy.transitionRules = { ...(policy.transitionRules || {}) }
    for (const r of rules) { const [edge, rule] = parseTransitionRule(r); policy.transitionRules[edge] = rule }
  }
  const fts = asList(flags['field-type'])
  if (fts.length) {
    policy.fieldTypes = { ...(policy.fieldTypes || {}) }
    for (const f of fts) { const [n, ft] = parseFieldType(f); policy.fieldTypes[n] = ft }
  }
  return policy
}

// Canonical Workplan scrum-object type policies. Installed via `qwirq workplan init`; each maps to a
// @qwirq/tasks type with a well-known prefix and state machine. Six types: Request (REQ, intake),
// Project (PRJ), Epic (EPC), Story (STY, story points enforced), Task (TSK), Sprint (SPR).
// These are TENANT CONFIGURATION (not baked into the platform) — the CLI installs them on demand.
const WP_TYPES = ['request', 'project', 'epic', 'story', 'task', 'sprint']
const WP_CONFIG = {
  request: {
    prefix: 'REQ',
    policy: {
      states: ['submitted', 'triaged', 'rejected', 'converted'], initialState: 'submitted',
      transitions: { submitted: ['triaged'], triaged: ['rejected', 'converted'] },
      allowedParentTypes: [], requireParent: false, requiredFields: [], hasExtension: true,
      transitionRules: {}, fieldTypes: {},
    },
  },
  project: {
    prefix: 'PRJ',
    policy: {
      states: ['planning', 'active', 'on-hold', 'done', 'cancelled'], initialState: 'planning',
      transitions: { planning: ['active', 'cancelled'], active: ['on-hold', 'done', 'cancelled'], 'on-hold': ['active', 'cancelled'] },
      allowedParentTypes: [], requireParent: false, requiredFields: [], hasExtension: false,
      transitionRules: { 'planning>active': { requireAssignee: true } }, fieldTypes: {},
    },
  },
  epic: {
    prefix: 'EPC',
    policy: {
      states: ['open', 'in-progress', 'done', 'cancelled'], initialState: 'open',
      transitions: { open: ['in-progress', 'cancelled'], 'in-progress': ['done', 'cancelled'] },
      allowedParentTypes: ['project'], requireParent: true, requiredFields: [], hasExtension: false,
      transitionRules: {}, fieldTypes: {},
    },
  },
  story: {
    prefix: 'STY',
    policy: {
      states: ['open', 'in-progress', 'in-review', 'done', 'cancelled'], initialState: 'open',
      transitions: { open: ['in-progress', 'cancelled'], 'in-progress': ['in-review', 'cancelled'], 'in-review': ['done', 'in-progress'] },
      // STRICT (#211, #366): story requires an EPIC parent — Project>Epic>Story chain enforced.
      // Previously ['epic','project']; corrected per Nathan's ruling (board contribution #366).
      allowedParentTypes: ['epic'], requireParent: true, requiredFields: [], hasExtension: true,
      transitionRules: { 'open>in-progress': { requireAssignee: true }, 'in-progress>in-review': { requireFields: ['points'] } },
      fieldTypes: { points: { kind: 'numeric-enum', values: [1, 2, 3, 5, 8, 13] } },
    },
  },
  task: {
    prefix: 'TSK',
    policy: {
      states: ['todo', 'doing', 'done', 'cancelled'], initialState: 'todo',
      transitions: { todo: ['doing', 'cancelled'], doing: ['done', 'cancelled', 'todo'] },
      // FLEXIBLE (#211): task attaches at project, epic, OR story — any work tier.
      // Previously ['story','epic']; extended to include 'project' per Nathan's ruling.
      allowedParentTypes: ['project', 'epic', 'story'], requireParent: true, requiredFields: [], hasExtension: false,
      transitionRules: { 'todo>doing': { requireAssignee: true } }, fieldTypes: {},
    },
  },
  sprint: {
    prefix: 'SPR',
    policy: {
      states: ['planning', 'active', 'closed', 'cancelled'], initialState: 'planning',
      transitions: { planning: ['active', 'cancelled'], active: ['closed', 'cancelled'] },
      allowedParentTypes: ['project'], requireParent: false, requiredFields: ['start', 'end'], hasExtension: true,
      transitionRules: {}, fieldTypes: { start: { kind: 'date' }, end: { kind: 'date' } },
    },
  },
}

async function main() {
  const argv = process.argv.slice(2)
  const group = argv[0]
  const { positional, flags } = parseArgs(argv.slice(1))

  if (!group || group === 'help' || flags.help || group === '--help') { out(HELP); return }

  // Identity-assertion guard (#148, FRICTION-9): `--as <email>` verifies the ambient session actually
  // resolves to that identity before running anything, and REFUSES on a mismatch, so a script can never
  // silently mis-attribute a write to whoever happens to be signed in. Opt-in; skipped for local /
  // no-session commands and the git credential-helper (whose stdout is a strict protocol).
  const NO_IDENTITY = new Set(['login', 'logout', 'credential-helper', 'git', 'validate', 'schema', 'init', 'clone'])
  if (typeof flags.as === 'string' && flags.as.trim() && !NO_IDENTITY.has(group)) {
    const expected = flags.as.trim().toLowerCase()
    let me
    try { me = await apiFetch('GET', '/api/v1/whoami') }
    catch (e) { return fail(`--as ${flags.as}: could not verify the active identity (${e.message})`) }
    const actual = String(me?.user?.email ?? '')
    if (actual.toLowerCase() !== expected) {
      return fail(`--as ${flags.as}, but this session is signed in as ${actual || '(unknown)'}. Refusing so the write is not mis-attributed; run \`qwirq login\` as ${flags.as}, or drop --as.`)
    }
    err(`✓ acting as ${actual}${me.company?.name ? ` · ${me.company.name}` : ''}`)
  }

  switch (group) {
    case 'login': return login({ noBrowser: !!flags['no-browser'] })

    case 'logout': { clearConfig(); out('Signed out.'); return }

    case 'credential-helper': {
      // git credential helper: on `get`, hand git our stored PAT for the qwirq git host.
      // store/erase are no-ops (the token is managed by `qwirq login`). Writes ONLY the
      // credential lines to stdout so it satisfies git's credential protocol.
      if (positional[0] !== 'get') return
      const input = await readStdin().catch(() => '')
      const kv = {}
      for (const line of input.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim() }
      const cfg = loadConfig()
      let gitHost = ''
      try { gitHost = new URL(cfg.gitBase).host } catch { /* ignore */ }
      if (kv.host && gitHost && kv.host !== gitHost) return // not our host
      const token = readToken()
      if (!token) return
      process.stdout.write(`username=qwirq\npassword=${token}\n`)
      return
    }

    case 'git': {
      if (positional[0] !== 'setup') return fail('usage: qwirq git setup')
      const base = loadConfig().gitBase.replace(/\/+$/, '')
      const key = `credential.${base}.helper`
      // Reset any inherited helper (e.g. Git Credential Manager) for THIS host, then add ours.
      // The empty value clears helpers accumulated from broader scopes, so a system/global
      // helper can't pop an interactive prompt for git.qwirq.com; only our PAT helper runs.
      try { execFileSync('git', ['config', '--global', '--unset-all', key], { stdio: 'ignore' }) } catch { /* none set */ }
      execFileSync('git', ['config', '--global', '--add', key, ''], { stdio: 'inherit' })
      execFileSync('git', ['config', '--global', '--add', key, '!qwirq credential-helper'], { stdio: 'inherit' })
      execFileSync('git', ['config', '--global', `credential.${base}.username`, 'qwirq'], { stdio: 'inherit' })
      out(`git will authenticate to ${base} with your qwirq login (run 'qwirq login' first).\nClone a project with: qwirq clone <project>`)
      return
    }

    case 'repo':
    case 'repository': {
      const sub = positional[0]
      const slug = positional[1]
      if (sub === 'ls') {
        const { repositories } = await apiFetch('GET', '/api/v1/repositories')
        if (!repositories.length) { out('(no repositories)'); return }
        for (const r of repositories) out(`${r.slug}\t${r.mine ? '(owner) ' : ''}${r.name}`)
        return
      }
      if (sub === 'new') {
        if (!slug) return fail('usage: qwirq repo new <slug> [--name <text>]')
        const body = { slug, name: typeof flags.name === 'string' ? flags.name : slug }
        const r = await apiFetch('POST', '/api/v1/repositories', { body })
        out(`Created repository ${r.repository.slug}. Clone it with: qwirq clone ${r.repository.slug}`)
        return
      }
      if (sub === 'rename') {
        if (!slug) return fail('usage: qwirq repo rename <slug> [--slug <new>] [--name <text>]')
        const body = {}
        if (typeof flags.slug === 'string') body.slug = flags.slug
        if (typeof flags.name === 'string') body.name = flags.name
        if (!body.slug && !body.name) return fail('nothing to change (use --slug and/or --name)')
        const r = await apiFetch('PATCH', `/api/v1/repositories/${encodeURIComponent(slug)}`, { body })
        out(`Renamed ${slug}${body.slug ? ` → ${r.slug}` : ''}.`)
        return
      }
      if (sub === 'rm') {
        if (!slug) return fail('usage: qwirq repo rm <slug> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Delete repository "${slug}"? This deletes the repo and its history and cannot be undone. [y/N] `)
          if (ok === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        await apiFetch('DELETE', `/api/v1/repositories/${encodeURIComponent(slug)}`)
        out(`Deleted ${slug}.`)
        return
      }
      if (sub === 'share') {
        const grantee = positional[2]
        if (!slug || !grantee) return fail('usage: qwirq repo share <slug> <email|role|group> [--role|--group] [--read|--manage|--own]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        const permission = flags.own ? 'own' : flags.manage ? 'manage' : 'read'
        await apiFetch('POST', `/api/v1/repositories/${encodeURIComponent(slug)}/grants`, { body: { grantee, kind, permission } })
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Shared ${slug} with ${tag} (${permission}).`)
        return
      }
      if (sub === 'unshare') {
        const grantee = positional[2]
        if (!slug || !grantee) return fail('usage: qwirq repo unshare <slug> <email|role|group> [--role|--group]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        await apiFetch('DELETE', `/api/v1/repositories/${encodeURIComponent(slug)}/grants?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Unshared ${slug} from ${tag}.`)
        return
      }
      if (sub === 'grants') {
        if (!slug) return fail('usage: qwirq repo grants <slug>')
        const { grants } = await apiFetch('GET', `/api/v1/repositories/${encodeURIComponent(slug)}/grants`)
        if (!grants.length) { out('(private — not shared)'); return }
        for (const g of grants) out(`${g.permission.padEnd(7)} ${g.userEmail || (g.roleName ? '@' + g.roleName : '#' + g.groupName)}`)
        return
      }
      return fail('usage: qwirq repo <ls|new|rename|rm|share|unshare|grants>')
    }

    case 'project': {
      const sub = positional[0]
      const slug = positional[1]
      if (sub === 'ls') {
        const { projects } = await apiFetch('GET', '/api/v1/projects')
        if (!projects.length) { out('(no projects)'); return }
        for (const pr of projects) out(`${pr.slug}\t${pr.mine ? '(owner) ' : ''}${pr.name}`)
        return
      }
      if (sub === 'new') {
        if (!slug) return fail('usage: qwirq project new <slug> [--name <text>]')
        const body = { slug, name: typeof flags.name === 'string' ? flags.name : slug }
        const r = await apiFetch('POST', '/api/v1/projects', { body })
        out(`Created project ${r.project.slug}. Clone it with: qwirq clone ${r.project.slug}`)
        return
      }
      if (sub === 'rename') {
        if (!slug) return fail('usage: qwirq project rename <slug> [--slug <new>] [--name <text>]')
        const body = {}
        if (typeof flags.slug === 'string') body.slug = flags.slug
        if (typeof flags.name === 'string') body.name = flags.name
        if (!body.slug && !body.name) return fail('nothing to change (use --slug and/or --name)')
        const r = await apiFetch('PATCH', `/api/v1/projects/${encodeURIComponent(slug)}`, { body })
        out(`Renamed ${slug}${body.slug ? ` → ${r.slug}` : ''}.`)
        return
      }
      if (sub === 'rm') {
        if (!slug) return fail('usage: qwirq project rm <slug> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Delete project "${slug}"? This deletes the repo and its history and cannot be undone. [y/N] `)
          if (ok === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        await apiFetch('DELETE', `/api/v1/projects/${encodeURIComponent(slug)}`)
        out(`Deleted ${slug}.`)
        return
      }
      if (sub === 'share') {
        const grantee = positional[2]
        if (!slug || !grantee) return fail('usage: qwirq project share <slug> <email|role|group> [--role|--group] [--read|--manage|--own]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        const permission = flags.own ? 'own' : flags.manage ? 'manage' : 'read'
        await apiFetch('POST', `/api/v1/projects/${encodeURIComponent(slug)}/grants`, { body: { grantee, kind, permission } })
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Shared ${slug} with ${tag} (${permission}).`)
        return
      }
      if (sub === 'unshare') {
        const grantee = positional[2]
        if (!slug || !grantee) return fail('usage: qwirq project unshare <slug> <email|role|group> [--role|--group]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        await apiFetch('DELETE', `/api/v1/projects/${encodeURIComponent(slug)}/grants?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Unshared ${slug} from ${tag}.`)
        return
      }
      if (sub === 'grants') {
        if (!slug) return fail('usage: qwirq project grants <slug>')
        const { grants } = await apiFetch('GET', `/api/v1/projects/${encodeURIComponent(slug)}/grants`)
        if (!grants.length) { out('(private — not shared)'); return }
        for (const g of grants) out(`${g.permission.padEnd(7)} ${g.userEmail || (g.roleName ? '@' + g.roleName : '#' + g.groupName)}`)
        return
      }
      return fail('usage: qwirq project <ls|new|rename|rm|share|unshare|grants>')
    }

    case 'data': {
      const sub = positional[0]
      const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
      if (sub === 'status') {
        const s = await apiFetch('GET', '/api/v1/data')
        if (!s.provisioned) { out('No app database yet. Create one with: qwirq data provision'); return }
        out(`app database: ready (region ${s.region}) · environments: ${s.envs.join(', ')}`)
        return
      }
      if (sub === 'provision') {
        const r = await apiFetch('POST', '/api/v1/data/provision')
        out(r.already
          ? `App database already exists (region ${r.region}).`
          : `Provisioned your app database (region ${r.region}). Try: qwirq data query "select 1 as hello"`)
        return
      }
      if (sub === 'tables') {
        const env = typeof flags.env === 'string' ? flags.env : 'prod'
        const { tables } = await apiFetch('GET', `/api/v1/data/tables?env=${encodeURIComponent(env)}`)
        if (!tables.length) { out(`(no tables in ${env})`); return }
        for (const t of tables) out(t)
        return
      }
      if (sub === 'query') {
        const sql = positional.slice(1).join(' ').trim()
        if (!sql) return fail('usage: qwirq data query "<sql>" [--env <env>]')
        const env = typeof flags.env === 'string' ? flags.env : 'prod'
        const r = await apiFetch('POST', '/api/v1/data/query', { body: { sql, env } })
        if (r.columns && r.columns.length) {
          out(r.columns.join('\t'))
          for (const row of r.rows) out(r.columns.map((c) => fmt(row[c])).join('\t'))
          out(`(${r.rowCount} row${r.rowCount === 1 ? '' : 's'})`)
        } else {
          out('OK')
        }
        return
      }
      if (sub === 'migrate') {
        const env = typeof flags.env === 'string' ? flags.env : 'prod'
        const dir = typeof flags.dir === 'string' ? flags.dir : 'migrations'
        // Each *.sql file (sorted by name) is one migration: id = filename, up = its SQL.
        let files
        try { files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() }
        catch { return fail(`no migrations directory: ${dir} (use --dir <path>)`) }
        if (!files.length) return fail(`no .sql files in ${dir}`)
        const migrations = files.map((f) => ({ id: f.replace(/\.sql$/, ''), up: readFileSync(join(dir, f), 'utf8') }))
        const r = await apiFetch('POST', '/api/v1/data/migrate', { body: { env, migrations } })
        out(r.applied.length ? `applied (${env}): ${r.applied.join(', ')}` : `nothing to apply (${env})`)
        if (r.skipped.length) out(`already applied: ${r.skipped.length}`)
        return
      }
      if (sub === 'migrations') {
        const env = typeof flags.env === 'string' ? flags.env : 'prod'
        const { applied } = await apiFetch('GET', `/api/v1/data/migrate?env=${encodeURIComponent(env)}`)
        if (!applied.length) { out(`(no migrations applied in ${env})`); return }
        for (const id of applied) out(id)
        return
      }
      return fail('usage: qwirq data <status|provision|tables|query|migrate|migrations>')
    }

    case 'clone': {
      const name = positional[0]
      if (!name) return fail('usage: qwirq clone <project>')
      const me = await apiFetch('GET', '/api/v1/whoami')
      const base = loadConfig().gitBase.replace(/\/+$/, '')
      const url = `${base}/${me.company.qid}/${name}.git`
      out(`Cloning ${url}`)
      execFileSync('git', ['clone', url, ...positional.slice(1)], { stdio: 'inherit' })
      return
    }

    case 'init': {
      // Scaffold a buildable QWIRQ Project: a qwirq.yaml manifest + a React UI (provides.app) + server-side
      // logic on the published primitives (@qwirq/tasks + @qwirq/cmdb), plus a local dev loop. Copies
      // templates/project/, replacing __NAME__ and renaming dotfiles. DX-1 (the authoring entrypoint).
      const name = positional[0]
      if (!name) return fail('usage: qwirq init <name>')
      if (!/^[a-z][a-z0-9-]*$/.test(name)) return fail('name must be kebab-case (a-z, 0-9, -) starting with a letter')
      const dest = resolve(process.cwd(), name)
      if (existsSync(dest)) return fail(`${name}/ already exists`)
      const tplRoot = join(here, '..', 'templates', 'project')
      const RENAME = { _npmrc: '.npmrc', _gitignore: '.gitignore' }
      const walk = (srcDir, dstDir) => {
        mkdirSync(dstDir, { recursive: true })
        for (const e of readdirSync(srcDir, { withFileTypes: true })) {
          const src = join(srcDir, e.name)
          const dst = join(dstDir, RENAME[e.name] ?? e.name)
          if (e.isDirectory()) walk(src, dst)
          else writeFileSync(dst, readFileSync(src, 'utf8').split('__NAME__').join(name))
        }
      }
      walk(tplRoot, dest)
      // Wire editor validation (DX-5 #44): drop the schema into .qwirq/ and point qwirq.yaml at it, so
      // the manifest validates + autocompletes in VS Code (with the standard YAML extension) out of the box.
      writeLocalSchema(dest)
      const manifestPath = join(dest, 'qwirq.yaml')
      writeFileSync(manifestPath, ensureModeline(readFileSync(manifestPath, 'utf8'), LOCAL_SCHEMA_REL))
      out(`Scaffolded ${name}/  (qwirq.yaml + a React app + @qwirq/tasks/@qwirq/cmdb on the app DB)`)
      out('next:')
      out(`  cd ${name}`)
      out('  npm install        # pulls @qwirq/* (needs a read:packages token in your .npmrc)')
      out('  qwirq dev          # binds a dev app DB and runs it')
      return
    }

    case 'validate': {
      // Validate qwirq.yaml against the manifest schema — the same schema the editor validates against,
      // so the CLI and the editor agree. DX-5 (#44).
      const file = typeof flags.file === 'string' ? flags.file : 'qwirq.yaml'
      let text
      try { text = readFileSync(file, 'utf8') }
      catch { return fail(`no ${file} here (run in a project dir, or pass --file <path>)`) }
      let value
      try { value = parseManifestText(text) } catch (e) { return fail(e.message) }
      const errors = validateManifest(value)
      if (!errors.length) { out(`${file} is valid.`); return }
      err(`${file} has ${errors.length} problem${errors.length === 1 ? '' : 's'}:`)
      for (const e of errors) err(`  - ${e}`)
      process.exitCode = 1
      return
    }

    case 'schema': {
      // Turn on editor validation for an EXISTING project: write the schema into .qwirq/ and add the
      // yaml-language-server modeline to qwirq.yaml (or point at the public URL with --url). DX-5 (#44).
      const file = typeof flags.file === 'string' ? flags.file : 'qwirq.yaml'
      if (!existsSync(file)) return fail(`no ${file} here (run in a project dir, or pass --file <path>)`)
      const ref = flags.url ? SCHEMA_URL : writeLocalSchema(process.cwd())
      const before = readFileSync(file, 'utf8')
      const after = ensureModeline(before, ref)
      if (after === before) { out(`${file} already references a schema.`); return }
      writeFileSync(file, after)
      out(flags.url
        ? `Pointed ${file} at ${SCHEMA_URL}. Reopen it in VS Code to validate + autocomplete.`
        : `Wrote ${LOCAL_SCHEMA_REL} and pointed ${file} at it. Reopen it in VS Code to validate + autocomplete.`)
      return
    }

    case 'dev': {
      // Run the project's dev script with the dev app-DB connection bound as QWIRQ_DB_URL, so server-side
      // code using @qwirq/tasks/@qwirq/cmdb runs locally. DX-1 (the local authoring loop).
      const url = await resolveDevDbUrl(flags)
      if (!url) return
      const script = typeof flags.script === 'string' ? flags.script : 'dev'
      process.stderr.write(`qwirq dev: dev app DB bound (QWIRQ_DB_URL); running \`npm run ${script}\`\n`)
      const r = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true, env: { ...process.env, QWIRQ_DB_URL: url } })
      process.exitCode = r.status ?? 0
      return
    }

    case 'types': {
      // Schema-to-types codegen (DX-2): bind the dev app DB and run the project's `types` script, which
      // writes .qwirq/schema.d.ts so `createBridge<QwirqDB>()` types every bridge('table') to real columns.
      const url = await resolveDevDbUrl(flags)
      if (!url) return
      process.stderr.write('qwirq types: introspecting the app DB; writing .qwirq/schema.d.ts\n')
      const r = spawnSync('npm', ['run', 'types'], { stdio: 'inherit', shell: true, env: { ...process.env, QWIRQ_DB_URL: url } })
      process.exitCode = r.status ?? 0
      return
    }

    case 'whoami': {
      const me = await apiFetch('GET', '/api/v1/whoami')
      out(`${me.user.email}  ·  ${me.company.name} (${me.company.role})`)
      return
    }

    case 'weave': {
      const sub = positional[0]
      if (sub === 'ls') {
        const { weaves } = await apiFetch('GET', '/api/v1/weaves')
        if (!weaves.length) { out('(no weaves)'); return }
        for (const w of weaves) out(`${w.qid}\t${w.restricted ? '🔒 ' : ''}${w.name}`)
        return
      }
      if (sub === 'new') {
        const name = positional.slice(1).join(' ').trim()
        if (!name) return fail('usage: qwirq weave new <name>')
        const r = await apiFetch('POST', '/api/v1/weaves', { body: { name } })
        out(`created weave ${r.weaveQID}  ${r.name}`)
        return
      }
      if (sub === 'rm') {
        const weaveQID = positional[1]
        if (!weaveQID) return fail('usage: qwirq weave rm <weaveQID> [--yes]')
        if (!flags.yes) {
          const okGo = await promptYesNo(`Delete weave ${weaveQID} and everything in it? This cannot be undone. [y/N] `)
          if (okGo === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!okGo) { out('Cancelled.'); return }
        }
        await apiFetch('DELETE', `/api/v1/weaves/${encodeURIComponent(weaveQID)}`)
        out(`Deleted weave ${weaveQID}.`)
        return
      }
      if (sub === 'access') {
        const weaveQID = positional[1]
        if (!weaveQID) return fail('usage: qwirq weave access <weaveQID>')
        const { grants } = await apiFetch('GET', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/grants`)
        const audience = grants.filter((g) => g.permission !== 'own')
        if (!audience.length) { out('(open — everyone in the company can read)'); return }
        out('restricted to:')
        for (const g of audience) out(`  ${g.permission.padEnd(7)} ${g.userEmail || (g.roleName ? '@' + g.roleName : '#' + g.groupName)}`)
        return
      }
      if (sub === 'restrict') {
        const weaveQID = positional[1]
        const grantee = positional[2]
        if (!weaveQID || !grantee) return fail('usage: qwirq weave restrict <weaveQID> <email|role|group> [--role|--group] [--manage] [--remove]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        if (flags.remove) {
          await apiFetch('DELETE', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/grants?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
          out(`Removed ${tag} from weave ${weaveQID}'s audience.`)
        } else {
          const permission = flags.manage ? 'manage' : 'read'
          await apiFetch('POST', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/grants`, { body: { grantee, kind, permission } })
          out(`Restricted weave ${weaveQID} to ${tag} (${permission}). It is now visible only to its audience.`)
        }
        return
      }
      return fail('usage: qwirq weave <ls|new|rm|access|restrict>')
    }

    case 'tree': {
      const weaveQID = positional[0]
      if (!weaveQID) return fail('usage: qwirq tree <weaveQID>')
      const { tree } = await apiFetch('GET', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/tree`)
      const lines = []
      indentTree(tree, 0, lines)
      out(lines.length ? lines.join('\n') : '(empty)')
      return
    }

    case 'thread': {
      const sub = positional[0]
      if (sub === 'new') {
        const weaveQID = flags.weave
        const title = typeof flags.title === 'string' ? flags.title : ''
        if (!weaveQID || !title) return fail('usage: qwirq thread new --weave <id> --title <t>')
        // A thread is a node at the weave root (no parent); same create endpoint as articles.
        const created = await apiFetch('POST', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/nodes`, {
          body: { kind: 'thread', title },
        })
        out(`created thread ${created.nodeQID}  ${title}`)
        return
      }
      return fail('usage: qwirq thread new --weave <id> --title <t>')
    }

    case 'article': {
      const sub = positional[0]
      const qid = positional[1]
      if (sub === 'get') {
        if (!qid) return fail('usage: qwirq article get <qid>')
        const { article } = await apiFetch('GET', `/api/v1/articles/${encodeURIComponent(qid)}`)
        out(article.bodyMd ?? '')
        return
      }
      if (sub === 'edit') {
        if (!qid) return fail('usage: qwirq article edit <qid>')
        const { article } = await apiFetch('GET', `/api/v1/articles/${encodeURIComponent(qid)}`)
        const edited = await editInEditor(article.bodyMd ?? '')
        if (edited === (article.bodyMd ?? '')) { out('No changes.'); return }
        await apiFetch('PATCH', `/api/v1/articles/${encodeURIComponent(qid)}`, { body: { bodyMd: edited } })
        out('Saved.')
        return
      }
      if (sub === 'new') {
        const weaveQID = flags.weave
        const title = typeof flags.title === 'string' ? flags.title : ''
        if (!weaveQID || !title) return fail('usage: qwirq article new --weave <id> --title <t> [--thread <id>] [--file <f> | --stdin]')
        const parentQID = typeof flags.thread === 'string' ? flags.thread : null
        const created = await apiFetch('POST', `/api/v1/weaves/${encodeURIComponent(weaveQID)}/nodes`, {
          body: { kind: 'article', title, parentQID },
        })
        let body = null
        if (flags.stdin) body = await readStdin()
        else if (typeof flags.file === 'string') body = (await import('node:fs')).readFileSync(flags.file, 'utf8')
        if (body != null) await apiFetch('PATCH', `/api/v1/articles/${encodeURIComponent(created.nodeQID)}`, { body: { bodyMd: body } })
        out(`created article ${created.nodeQID}  ${title}`)
        return
      }
      if (sub === 'rm') {
        if (!qid) return fail('usage: qwirq article rm <qid>')
        await apiFetch('DELETE', `/api/v1/nodes/${encodeURIComponent(qid)}`)
        out('Deleted.')
        return
      }
      return fail('usage: qwirq article <get|edit|new|rm>')
    }

    case 'node': {
      const sub = positional[0]
      const qid = positional[1]
      if (sub === 'access') {
        if (!qid) return fail('usage: qwirq node access <qid>')
        const { grants } = await apiFetch('GET', `/api/v1/nodes/${encodeURIComponent(qid)}/grants`)
        const audience = grants.filter((g) => g.permission !== 'own')
        if (!audience.length) { out('(open — inherits from its weave / threads)'); return }
        out('restricted to:')
        for (const g of audience) out(`  ${g.permission.padEnd(7)} ${g.userEmail || (g.roleName ? '@' + g.roleName : '#' + g.groupName)}`)
        return
      }
      if (sub === 'restrict') {
        const grantee = positional[2]
        if (!qid || !grantee) return fail('usage: qwirq node restrict <qid> <email|role|group> [--role|--group] [--manage] [--remove]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        if (flags.remove) {
          await apiFetch('DELETE', `/api/v1/nodes/${encodeURIComponent(qid)}/grants?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
          out(`Removed ${tag} from node ${qid}'s audience.`)
        } else {
          const permission = flags.manage ? 'manage' : 'read'
          await apiFetch('POST', `/api/v1/nodes/${encodeURIComponent(qid)}/grants`, { body: { grantee, kind, permission } })
          out(`Restricted node ${qid} to ${tag} (${permission}).`)
        }
        return
      }
      return fail('usage: qwirq node <access|restrict>')
    }

    case 'secret': {
      const sub = positional[0]
      const name = positional[1]

      // Categories ORGANIZE, never AUTHORIZE (grants stay per-secret). `qwirq secret cat <new|ls|rename|rm>`.
      if (sub === 'cat') {
        const catsub = positional[1]
        if (catsub === 'new') {
          const cname = positional[2]
          if (!cname) return fail('usage: qwirq secret cat new <name> [--desc <text>]')
          const body = { name: cname }
          if (flags.desc !== undefined || flags.description !== undefined) body.description = String(flags.desc ?? flags.description)
          await apiFetch('POST', '/api/v1/secrets/categories', { body })
          out(`Created category "${cname}". File secrets into it with: qwirq secret set <name> --cat ${cname}`)
          return
        }
        if (catsub === 'ls') {
          const { categories } = await apiFetch('GET', '/api/v1/secrets/categories')
          if (!categories.length) { out('(no categories — create one with: qwirq secret cat new <name>)'); return }
          for (const c of categories) {
            const desc = c.description ? `  — ${c.description}` : ''
            out(`${c.name}  (${c.secretCount} secret${c.secretCount === 1 ? '' : 's'})${desc}`)
          }
          return
        }
        if (catsub === 'rename') {
          const oldName = positional[2]
          const newName = positional[3]
          if (!oldName || !newName) return fail('usage: qwirq secret cat rename <old> <new>')
          await apiFetch('PATCH', `/api/v1/secrets/categories/${encodeURIComponent(oldName)}`, { body: { newName } })
          out(`Renamed category "${oldName}" → "${newName}".`)
          return
        }
        if (catsub === 'rm') {
          const cname = positional[2]
          if (!cname) return fail('usage: qwirq secret cat rm <name>')
          const r = await apiFetch('DELETE', `/api/v1/secrets/categories/${encodeURIComponent(cname)}`)
          out(`Deleted category "${cname}".${r.unfiled ? ` ${r.unfiled} secret${r.unfiled === 1 ? '' : 's'} became Uncategorized (no secret was deleted).` : ''}`)
          return
        }
        return fail('usage: qwirq secret cat <new|ls|rename|rm>')
      }

      if (sub === 'ls' || sub === 'search') {
        const { secrets } = await apiFetch('GET', '/api/v1/secrets')
        let list = secrets
        if (flags.mine) list = list.filter((s) => s.scope === 'user')
        if (flags.company) list = list.filter((s) => s.scope === 'company')
        const q = (positional[1] || '').toLowerCase()
        if (q) list = list.filter((s) => [s.label, s.name, s.key, s.description].some((f) => (f || '').toLowerCase().includes(q)))
        if (typeof flags.cat === 'string') {
          const want = flags.cat.toLowerCase()
          const uncat = want === '' || want === 'uncategorized'
          list = list.filter((s) => (uncat ? !s.category : (s.category || '').toLowerCase() === want))
        }
        if (!list.length) { out(q ? `(no secrets match "${positional[1]}")` : flags.cat !== undefined ? '(no secrets in that category)' : '(no secrets)'); return }
        const fmtLine = (s) => {
          const title = s.label || s.name
          const bits = [s.label ? s.name : null, s.key ? `key:${s.key}` : null, s.scope === 'company' ? `company · ${s.owner}` : null].filter(Boolean)
          const meta = bits.length ? `  [${bits.join(' · ')}]` : ''
          const desc = s.description ? `  — ${s.description}` : ''
          return `${title}${meta}${desc}`
        }
        // Group by category (Uncategorized last) so a sprawling vault reads as an organized one.
        // Stay flat (unchanged) when no categories are in play, so non-users see no extra noise.
        const groups = new Map()
        for (const s of list) { const k = s.category || null; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s) }
        const named = [...groups.keys()].filter((k) => k !== null).sort((a, b) => a.localeCompare(b))
        if (!named.length && flags.cat === undefined) { for (const s of list) out(fmtLine(s)); return }
        const order = [...named, ...(groups.has(null) ? [null] : [])]
        let first = true
        for (const k of order) {
          if (!first) out('')
          first = false
          out(`# ${k === null ? 'Uncategorized' : k}`)
          for (const s of groups.get(k)) out(`  ${fmtLine(s)}`)
        }
        return
      }
      if (sub === 'show') {
        if (!name) return fail('usage: qwirq secret show <name>')
        const { secret: s } = await apiFetch('GET', `/api/v1/secrets/${encodeURIComponent(name)}`)
        out(s.label || s.name)
        if (s.description) out(`  ${s.description}`)
        if (s.label) out(`  logical key: ${s.name}`)
        out(`  key:         ${s.key || '(none)'}`)
        out(`  category:    ${s.category || '(uncategorized)'}`)
        out(`  scope:       ${s.scope}${s.scope === 'company' ? ` (owner ${s.owner})` : ''}`)
        out(`  value:       (hidden — run: qwirq secret reveal ${s.name})`)
        return
      }
      if (sub === 'reveal') {
        if (!name) return fail('usage: qwirq secret reveal <name>')
        const r = await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(name)}/reveal`)
        out(r.value) // value to stdout (clean for pipes)
        // handling guidance to stderr, so it never contaminates a pipe
        process.stderr.write('Sensitive: do not save to disk, logs, or shell history. (tip: qwirq secret copy)\n')
        return
      }
      if (sub === 'copy') {
        if (!name) return fail('usage: qwirq secret copy <name>')
        // Reuse the audited reveal path, then put the value straight on the clipboard so it
        // never lands in the terminal scrollback. Mirrors the web list's one-click copy.
        const r = await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(name)}/reveal`)
        try { await copyToClipboard(r.value) }
        catch (e) { return fail(`could not copy to clipboard (${e.message}); use: qwirq secret reveal ${name}`) }
        out(`Copied ${name} to the clipboard.`)
        return
      }
      if (sub === 'set') {
        if (!name) return fail('usage: qwirq secret set <name> [--stdin] [--label <text>] [--key <k>] [--desc <text>] [--cat <category>]')
        const hasLabel = flags.label !== undefined
        const hasKey = flags.key !== undefined
        const hasDesc = flags.desc !== undefined || flags.description !== undefined
        const hasCat = flags.cat !== undefined // --cat <name> files it; --cat "" clears to Uncategorized
        const hasMeta = hasLabel || hasKey || hasDesc || hasCat
        const body = {}
        if (flags.stdin) {
          body.value = (await readStdin()).replace(/\r?\n$/, '')
        } else if (!hasMeta) {
          const v = await promptHidden(`Value for ${name}: `)
          if (!v) return fail('value is required')
          body.value = v
        }
        if (hasLabel) body.label = String(flags.label)
        if (hasKey) body.key = String(flags.key)
        if (hasDesc) body.description = String(flags.desc ?? flags.description)
        if (hasCat) body.category = flags.cat === true ? '' : String(flags.cat)
        // Filing into a category that doesn't exist: refuse with the fix (the existing categories +
        // how to make one), rather than a server error. Clearing (--cat "") needs no check.
        if (hasCat && body.category !== '') {
          const { categories } = await apiFetch('GET', '/api/v1/secrets/categories')
          if (!categories.some((c) => c.name.toLowerCase() === body.category.toLowerCase())) {
            const have = categories.length ? categories.map((c) => c.name).join(', ') : '(none yet)'
            return fail(`no category "${body.category}". Existing: ${have}. Create it with: qwirq secret cat new ${body.category}`)
          }
        }
        const parts = []
        if (body.value !== undefined) parts.push('value')
        if (hasLabel) parts.push('name')
        if (hasKey) parts.push('key')
        if (hasDesc) parts.push('description')
        if (hasCat) parts.push(body.category === '' ? 'uncategorized' : `category=${body.category}`)
        if (!parts.length) return fail('nothing to set')
        await apiFetch('PUT', `/api/v1/secrets/${encodeURIComponent(name)}`, { body })
        out(`Set ${name} (${parts.join(', ')}).`)
        return
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: qwirq secret rm <name> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Delete secret "${name}"? This cannot be undone. [y/N] `)
          if (ok === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        await apiFetch('DELETE', `/api/v1/secrets/${encodeURIComponent(name)}`)
        out(`Deleted ${name}.`)
        return
      }
      if (sub === 'share') {
        const grantee = positional[2]
        if (!name || !grantee) return fail('usage: qwirq secret share <name> <email|role|group> [--role|--group] [--read|--manage|--own]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        const permission = flags.own ? 'own' : flags.manage ? 'manage' : 'read'
        await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(name)}/share`, { body: { grantee, kind, permission } })
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Shared ${name} with ${tag} (${permission}).`)
        return
      }
      if (sub === 'unshare') {
        const grantee = positional[2]
        if (!name || !grantee) return fail('usage: qwirq secret unshare <name> <email|role|group> [--role|--group]')
        const kind = flags.group ? 'group' : flags.role ? 'role' : 'user'
        await apiFetch('DELETE', `/api/v1/secrets/${encodeURIComponent(name)}/share?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
        const tag = kind === 'group' ? '#' + grantee : kind === 'role' ? '@' + grantee : grantee
        out(`Unshared ${name} from ${tag}.`)
        return
      }
      if (sub === 'grants') {
        if (!name) return fail('usage: qwirq secret grants <name>')
        const { grants } = await apiFetch('GET', `/api/v1/secrets/${encodeURIComponent(name)}/grants`)
        if (!grants.length) { out('(private — not shared)'); return }
        for (const g of grants) out(`${g.permission.padEnd(7)} ${g.userEmail || (g.roleName ? '@' + g.roleName : '#' + g.groupName)}`)
        return
      }
      return fail('usage: qwirq secret <ls|search|show|reveal|copy|set|rm|share|unshare|grants>')
    }

    case 'token': {
      // Personal access tokens (qwirq_pat_) for CLI / agent / API use (#115). auth owns the table, so
      // these route to authBase. mint prints the plaintext ONCE; ls/revoke never expose it.
      const sub = positional[0]
      // --expires <days> sets a TTL; --no-expiry mints a non-expiring token; neither = server default.
      const mintBody = () => {
        const body = {}
        if (typeof flags.name === 'string') body.name = flags.name
        if (typeof flags.scope === 'string') body.scope = flags.scope
        if (flags['no-expiry']) body.ttlDays = null
        else if (flags.expires !== undefined && flags.expires !== true) body.ttlDays = Number(flags.expires)
        return body
      }
      const printMinted = (r) => {
        out(r.token) // value to stdout (clean for capture)
        process.stderr.write(`Minted token #${r.qid} for ${r.for}. Shown once — store it now (it is not recoverable).\n`)
        process.stderr.write('Sensitive: keep it out of logs, history, and shared files.\n')
      }
      const fmtToken = (t) => {
        const status = t.revokedAt ? 'REVOKED' : (t.expiresAt && new Date(t.expiresAt) < new Date() ? 'EXPIRED' : 'active')
        const used = t.lastUsedAt ? `used ${t.lastUsedAt.slice(0, 10)}` : 'never used'
        const exp = t.expiresAt ? `expires ${t.expiresAt.slice(0, 10)}` : 'no expiry'
        return `${String(t.qid).padEnd(5)} ${status.padEnd(8)} ${t.name}${t.scope ? ` [scope:${t.scope}]` : ''}  ·  created ${t.createdAt.slice(0, 10)} · ${used} · ${exp}`
      }
      if (sub === 'mint') {
        const r = await authFetch('POST', '/api/tokens', { body: mintBody() })
        printMinted(r)
        return
      }
      if (sub === 'ls') {
        const { tokens, for: who } = await authFetch('GET', '/api/tokens')
        if (!tokens.length) { out('(no tokens)'); return }
        out(`tokens for ${who}:`)
        for (const t of tokens) out('  ' + fmtToken(t))
        return
      }
      if (sub === 'revoke') {
        const qid = positional[1]
        if (!qid) return fail('usage: qwirq token revoke <qid> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Revoke token #${qid}? Anything using it stops working immediately. [y/N] `)
          if (ok === null) return fail('refusing to revoke in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        await authFetch('DELETE', `/api/tokens/${encodeURIComponent(qid)}`)
        out(`Revoked token #${qid}.`)
        return
      }
      return fail('usage: qwirq token <mint|ls|revoke>\n  mint [--name <l>] [--scope <s>] [--expires <days> | --no-expiry]')
    }

    case 'agent': {
      // Agent principals (users.kind='agent') + their PATs (#115/#83). Owner-gated. Lets the owner mint
      // a web-scoped PAT for an agent (claude@/pursuit@) so it can use the session exchange — moving it
      // off a vaulted password. mintBody mirrors `token`.
      const sub = positional[0]
      const email = positional[1]
      const agentRoles = new Set(['builder', 'owner'])
      const mintBody = (forEmail) => {
        const body = { forEmail }
        if (typeof flags.name === 'string') body.name = flags.name
        if (typeof flags.scope === 'string') body.scope = flags.scope
        if (flags['no-expiry']) body.ttlDays = null
        else if (flags.expires !== undefined && flags.expires !== true) body.ttlDays = Number(flags.expires)
        return body
      }
      const fmtToken = (t) => {
        const status = t.revokedAt ? 'REVOKED' : (t.expiresAt && new Date(t.expiresAt) < new Date() ? 'EXPIRED' : 'active')
        const exp = t.expiresAt ? `expires ${t.expiresAt.slice(0, 10)}` : 'no expiry'
        return `${String(t.qid).padEnd(5)} ${status.padEnd(8)} ${t.name}${t.scope ? ` [scope:${t.scope}]` : ''}  ·  ${exp}`
      }
      if (sub === 'ls') {
        const { agents } = await authFetch('GET', '/api/agents')
        if (!agents.length) { out('(no agent principals)'); return }
        for (const a of agents) out(`${a.email}  (${a.roleName})`)
        return
      }
      if (sub === 'new') {
        // Create an agent principal (kind='agent', no password); mint its PAT separately via `agent token`.
        if (!email) return fail('usage: qwirq agent new <email> [--role builder|owner]')
        const body = { email }
        if (flags.role !== undefined) {
          if (typeof flags.role !== 'string' || !agentRoles.has(flags.role)) return fail('usage: qwirq agent new <email> [--role builder|owner]')
          body.role = flags.role
        }
        const { agent } = await authFetch('POST', '/api/agents', { body })
        out(`Created agent ${agent.email} (${agent.roleName}). Mint its token with: qwirq agent token ${agent.email} --scope web`)
        return
      }
      if (sub === 'suspend') {
        // Suspend an agent: revoke ALL its tokens + disable it immediately (#129).
        if (!email) return fail('usage: qwirq agent suspend <email> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Suspend agent ${email}? This revokes ALL its tokens and disables it immediately. [y/N] `)
          if (ok === null) return fail('refusing to suspend in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        const r = await authFetch('POST', `/api/agents/${encodeURIComponent(email)}/suspend`)
        out(`Suspended agent ${r.email}. Revoked ${r.revoked} token${r.revoked === 1 ? '' : 's'}; it can no longer authenticate.`)
        return
      }
      if (sub === 'unsuspend') {
        if (!email) return fail('usage: qwirq agent unsuspend <email>')
        const r = await authFetch('POST', `/api/agents/${encodeURIComponent(email)}/unsuspend`)
        out(`Unsuspended agent ${r.email}. Mint a new token if it needs to authenticate.`)
        return
      }
      if (sub === 'token') {
        if (!email) return fail('usage: qwirq agent token <email> [--name <l>] [--scope <s>] [--expires <days> | --no-expiry]')
        const r = await authFetch('POST', '/api/tokens', { body: mintBody(email) })
        out(r.token)
        process.stderr.write(`Minted token #${r.qid} for agent ${r.for}. Shown once — store it in the agent's config now.\n`)
        process.stderr.write('Sensitive: keep it out of logs, history, and shared files.\n')
        return
      }
      if (sub === 'tokens') {
        if (!email) return fail('usage: qwirq agent tokens <email>')
        const { tokens, for: who } = await authFetch('GET', `/api/tokens?email=${encodeURIComponent(email)}`)
        if (!tokens.length) { out(`(no tokens for ${who})`); return }
        out(`tokens for ${who}:`)
        for (const t of tokens) out('  ' + fmtToken(t))
        return
      }
      if (sub === 'revoke') {
        const qid = positional[2]
        if (!email || !qid) return fail('usage: qwirq agent revoke <email> <qid> [--yes]')
        if (!flags.yes) {
          const ok = await promptYesNo(`Revoke agent ${email}'s token #${qid}? It stops working immediately. [y/N] `)
          if (ok === null) return fail('refusing to revoke in a non-interactive shell without --yes')
          if (!ok) { out('Cancelled.'); return }
        }
        await authFetch('DELETE', `/api/tokens/${encodeURIComponent(qid)}?email=${encodeURIComponent(email)}`)
        out(`Revoked agent ${email}'s token #${qid}.`)
        return
      }
      return fail('usage: qwirq agent <ls|new|suspend|unsuspend|token|tokens|revoke>\n  new <email> [--role builder|owner]   suspend <email> [--yes]   unsuspend <email>   token <email> [--scope web] [--expires <days>|--no-expiry]')
    }

    case 'members': {
      const { members } = await apiFetch('GET', '/api/v1/members')
      for (const m of members) out(`${m.email}  (${m.roleName})`)
      return
    }

    case 'group': {
      const sub = positional[0]
      if (sub === 'ls') {
        const { groups } = await apiFetch('GET', '/api/v1/groups')
        if (!groups.length) { out('(no groups)'); return }
        for (const g of groups) out(`${g.name}  (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})`)
        return
      }
      if (sub === 'create') {
        const gname = positional.slice(1).join(' ').trim()
        if (!gname) return fail('usage: qwirq group create <name>')
        await apiFetch('POST', '/api/v1/groups', { body: { name: gname } })
        out(`Created group ${gname}.`)
        return
      }
      // member ops address a group by name
      const gname = positional[1]
      if (sub === 'members' || sub === 'add' || sub === 'rm') {
        if (!gname) return fail(`usage: qwirq group ${sub} <group> ${sub === 'members' ? '' : '<email>'}`)
        const { groups } = await apiFetch('GET', '/api/v1/groups')
        const g = groups.find((x) => x.name.toLowerCase() === gname.toLowerCase())
        if (!g) return fail(`no such group: ${gname}`)
        if (sub === 'members') {
          const { members } = await apiFetch('GET', `/api/v1/groups/${g.qid}/members`)
          if (!members.length) { out('(no members)'); return }
          for (const m of members) out(`${m.email}  (${m.roleName})`)
          return
        }
        const email = positional[2]
        if (!email) return fail(`usage: qwirq group ${sub} <group> <email>`)
        if (sub === 'add') {
          await apiFetch('POST', `/api/v1/groups/${g.qid}/members`, { body: { email } })
          out(`Added ${email} to ${g.name}.`)
        } else {
          await apiFetch('DELETE', `/api/v1/groups/${g.qid}/members?email=${encodeURIComponent(email)}`)
          out(`Removed ${email} from ${g.name}.`)
        }
        return
      }
      return fail('usage: qwirq group <ls|create|members|add|rm>')
    }

    case 'work-type': {
      // Define + inspect work-item TYPES (declarative policy; tenant data, no domain vocabulary baked in).
      const sub = positional[0]
      const name = positional[1]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      if (sub === 'define') {
        if (!name || typeof flags.prefix !== 'string') return fail('usage: qwirq work-type define <name> --prefix <P> --states a,b,c [--initial a] [--transitions "a>b,b>c"] [--parents t1,t2|--no-parent] [--require-parent] [--ext] [--required f1,f2] [--transition-rule "a>b:assignee,note,fields(x|y)"] [--field-type "points:numeric-enum(1|2|3)"]')
        let policy
        try { policy = buildPolicy(flags, {}, true) } catch (e) { return fail(e.message) }
        const { type } = await appCall('tasks', { op: 'type-define', env, name, prefix: flags.prefix, policy })
        out(`defined work-item type ${type.name} (prefix ${type.prefix}); states: ${type.policy.states.join(', ')}`)
        return
      }
      if (sub === 'update') {
        // F-009: pipelines are configuration, and configuration evolves. Fetch the current type, override
        // only the keys whose flags are present, and send the merged patch (the lib enforces the safety
        // contract: no occupied state may vanish). --prefix and/or any policy flag(s); at least one required.
        if (!name) return fail('usage: qwirq work-type update <name> [--prefix P] [--states ...] [--initial s] [--transitions "a>b,b>c"] [--parents ...|--no-parent] [--require-parent|--no-require-parent] [--required f1,f2] [--ext|--no-ext] [--transition-rule "a>b:assignee" ...] [--field-type "k:enum(x|y)" ...]')
        const { type: existing } = await appCall('tasks', { op: 'type-get', env, name })
        if (!existing) return fail(`no such work-item type: ${name}`)
        const patch = {}
        if (typeof flags.prefix === 'string') patch.prefix = flags.prefix
        const policyFlags = ['states', 'initial', 'transitions', 'parents', 'no-parent', 'required', 'ext', 'no-ext', 'require-parent', 'no-require-parent', 'transition-rule', 'field-type']
        if (policyFlags.some((f) => flags[f] !== undefined)) {
          try { patch.policy = buildPolicy(flags, existing.policy, false) } catch (e) { return fail(e.message) }
        }
        if (patch.prefix === undefined && patch.policy === undefined) return fail('nothing to change (pass --prefix and/or a policy flag)')
        const { type } = await appCall('tasks', { op: 'type-update', env, name, ...patch })
        out(`updated work-item type ${type.name}.`)
        return
      }
      if (sub === 'ls') {
        const { types } = await appCall('tasks', { op: 'type-ls', env })
        if (!types.length) { out('(no work-item types — run: qwirq work init, then qwirq work-type define …)'); return }
        for (const t of types) out(`${t.name}\t${t.prefix}\t[${t.policy.states.join(', ')}]${t.policy.hasExtension ? '  +ext' : ''}`)
        return
      }
      if (sub === 'show') {
        if (!name) return fail('usage: qwirq work-type show <name>')
        const { type } = await appCall('tasks', { op: 'type-get', env, name })
        if (!type) { out(`(no such type: ${name})`); return }
        out(`${type.name}  (prefix ${type.prefix})`)
        out(`  states:     ${type.policy.states.join(', ')}`)
        out(`  initial:    ${type.policy.initialState}`)
        const tr = Object.entries(type.policy.transitions)
        out(`  transitions:${tr.length ? '' : ' (none — all states terminal)'}`)
        for (const [from, tos] of tr) out(`    ${from} -> ${tos.join(', ')}`)
        out(`  parents:    ${type.policy.allowedParentTypes === null ? 'any' : (type.policy.allowedParentTypes.length ? type.policy.allowedParentTypes.join(', ') : 'none (root only)')}${type.policy.requireParent ? ' (required)' : ''}`)
        out(`  extension:  ${type.policy.hasExtension ? `yes${type.policy.requiredFields.length ? ` (required: ${type.policy.requiredFields.join(', ')})` : ''}` : 'no'}`)
        const rules = Object.entries(type.policy.transitionRules || {})
        if (rules.length) {
          out('  rules:')
          for (const [edge, r] of rules) {
            const gates = [r.requireNote && 'note', r.requireAssignee && 'assignee', r.requireWeave && 'weave', r.requireFields?.length && `fields(${r.requireFields.join('|')})`].filter(Boolean)
            out(`    ${edge}: ${gates.join(', ')}`)
          }
        }
        const fts = Object.entries(type.policy.fieldTypes || {})
        if (fts.length) {
          out('  field types:')
          for (const [fn, ft] of fts) out(`    ${fn}: ${ft.kind}${ft.values ? `(${ft.values.join('|')})` : ''}`)
        }
        return
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: qwirq work-type rm <name>')
        await appCall('tasks', { op: 'type-rm', env, name })
        out(`removed work-item type ${name}.`)
        return
      }
      return fail('usage: qwirq work-type <define|update|ls|show|rm>')
    }

    case 'link-type': {
      // The OPTIONAL link-type registry (tasks 0.2.1, #124/FRICTION-7). Registering a link type CONSTRAINS
      // its edges (allowed from/to item types, source states, cardinality); unregistered types stay opaque
      // and unconstrained. Additive + default-off: with nothing registered every `work link` works as before.
      const sub = positional[0]
      const name = positional[1]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      const fmtLinkType = (lt) => {
        const bits = [
          `from:${lt.fromTypes ? lt.fromTypes.join('|') : 'any'}`,
          `to:${lt.toTypes ? lt.toTypes.join('|') : 'any'}`,
          lt.fromStates ? `fromStates:${lt.fromStates.join('|')}` : null,
          lt.maxFrom != null ? `maxFrom:${lt.maxFrom}` : null,
          lt.maxTo != null ? `maxTo:${lt.maxTo}` : null,
        ].filter(Boolean)
        return `${lt.name}\t${bits.join('  ')}`
      }
      if (sub === 'define') {
        if (!name) return fail('usage: qwirq link-type define <name> [--from-types a,b] [--to-types c,d] [--from-states s1,s2] [--max-from N] [--max-to N]')
        const linkType = {
          name,
          fromTypes: typeof flags['from-types'] === 'string' ? csv(flags['from-types']) : null,
          toTypes: typeof flags['to-types'] === 'string' ? csv(flags['to-types']) : null,
          fromStates: typeof flags['from-states'] === 'string' ? csv(flags['from-states']) : null,
          maxFrom: flags['max-from'] !== undefined && flags['max-from'] !== true ? Number(flags['max-from']) : null,
          maxTo: flags['max-to'] !== undefined && flags['max-to'] !== true ? Number(flags['max-to']) : null,
        }
        await appCall('tasks', { op: 'link-type-define', env, linkType })
        out(`registered link type "${name}". Edges of this type are now constrained (work link throws link_not_allowed on a violation).`)
        return
      }
      if (sub === 'ls') {
        const { linkTypes } = await appCall('tasks', { op: 'link-type-ls', env })
        if (!linkTypes.length) { out('(no registered link types — every link type is opaque/unconstrained)'); return }
        for (const lt of linkTypes) out(fmtLinkType(lt))
        return
      }
      if (sub === 'show') {
        if (!name) return fail('usage: qwirq link-type show <name>')
        const { linkType } = await appCall('tasks', { op: 'link-type-get', env, name })
        if (!linkType) { out(`(${name} is not registered — it stays opaque and unconstrained)`); return }
        out(`${linkType.name}`)
        out(`  from types:  ${linkType.fromTypes ? linkType.fromTypes.join(', ') : 'any'}`)
        out(`  to types:    ${linkType.toTypes ? linkType.toTypes.join(', ') : 'any'}`)
        out(`  from states: ${linkType.fromStates ? linkType.fromStates.join(', ') : 'any'}`)
        out(`  max from:    ${linkType.maxFrom != null ? linkType.maxFrom : 'unlimited'}`)
        out(`  max to:      ${linkType.maxTo != null ? linkType.maxTo : 'unlimited'}`)
        return
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: qwirq link-type rm <name>')
        await appCall('tasks', { op: 'link-type-rm', env, name })
        out(`removed link type "${name}" (its edges are opaque/unconstrained again).`)
        return
      }
      return fail('usage: qwirq link-type <define|ls|show|rm>')
    }

    case 'work': {
      // The primary interface for work items (WORKPLAN-PLAN §5): CRUD, state transitions, the parent tree,
      // typed links, and the CMDB CI seam. Items are addressed by short id (T-1) or numeric id.
      const sub = positional[0]
      const ref = positional[1]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      if (sub === 'init') {
        const { applied } = await appCall('tasks', { op: 'migrate', env })
        out(applied.length ? `created work-item tables (${applied.join(', ')}).` : 'work-item tables already present.')
        return
      }
      if (sub === 'ls') {
        const filter = {}
        if (typeof flags.type === 'string') filter.type = flags.type
        if (typeof flags.state === 'string') filter.state = flags.state
        if (typeof flags.assignee === 'string') filter.assignee = flags.assignee
        if (flags.roots) filter.parent = null
        else if (typeof flags.parent === 'string') filter.parent = flags.parent
        const { items } = await appCall('tasks', { op: 'list', env, filter })
        if (!items.length) { out('(no work items)'); return }
        for (const w of items) out(`${w.shortId}\t${w.state}\t${w.title}${w.assignee ? `\t@${w.assignee}` : ''}`)
        return
      }
      if (sub === 'show') {
        if (!ref) return fail('usage: qwirq work show <ref>')
        const { item } = await appCall('tasks', { op: 'get', env, ref })
        out(`${item.shortId}  ${item.title}`)
        out(`  type:   ${item.type}`)
        out(`  state:  ${item.state}`)
        if (item.parentId) out(`  parent: ${item.parentId}`)
        if (item.assignee) out(`  assignee: ${item.assignee}`)
        if (item.priority != null) out(`  priority: ${item.priority}`)
        if (item.due) out(`  due:    ${item.due}`)
        if (item.fields && Object.keys(item.fields).length) out(`  fields: ${JSON.stringify(item.fields)}`)
        const { links } = await appCall('tasks', { op: 'links', env, ref })
        for (const l of links.outgoing) out(`  link →  ${l.linkType} ${l.toId}`)
        for (const l of links.incoming) out(`  link ←  ${l.linkType} ${l.fromId}`)
        const { cis } = await appCall('tasks', { op: 'cis', env, ref })
        for (const c of cis) out(`  ci:     ${c.rel} ${c.ciId}`)
        const { events } = await appCall('tasks', { op: 'events', env, ref })
        for (const e of events.slice(-5)) out(`  · ${e.at}  ${e.kind}${e.fromState ? ` ${e.fromState}->${e.toState}` : e.toState ? ` ${e.toState}` : ''}${e.actor ? `  by ${e.actor}` : ''}${e.note ? ` — "${e.note}"` : ''}`)
        return
      }
      if (sub === 'new') {
        if (typeof flags.type !== 'string' || typeof flags.title !== 'string') return fail('usage: qwirq work new --type <t> --title "..." [--parent <ref>] [--assignee a] [--priority n] [--due d] [--field k=v ...]')
        const input = { type: flags.type, title: flags.title }
        if (typeof flags.parent === 'string') input.parent = flags.parent
        if (typeof flags.assignee === 'string') input.assignee = flags.assignee
        if (flags.priority !== undefined && flags.priority !== true) input.priority = Number(flags.priority)
        if (typeof flags.due === 'string') input.due = flags.due
        const fields = parseKeyVals(flags.field)
        if (Object.keys(fields).length) input.fields = fields
        const { item } = await appCall('tasks', { op: 'create', env, input })
        out(`created ${item.shortId}  ${item.title}  [${item.state}]`)
        return
      }
      if (sub === 'set') {
        if (!ref) return fail('usage: qwirq work set <ref> [--title <t>] [--assignee a] [--priority n] [--due d] [--field k=v ...]')
        const patch = {}
        if (typeof flags.title === 'string') patch.title = flags.title
        if (flags.assignee !== undefined) patch.assignee = flags.assignee === true ? null : flags.assignee
        if (flags.priority !== undefined) patch.priority = flags.priority === true ? null : Number(flags.priority)
        if (flags.due !== undefined) patch.due = flags.due === true ? null : flags.due
        const fields = parseKeyVals(flags.field)
        if (Object.keys(fields).length) patch.fields = fields
        if (!Object.keys(patch).length) return fail('nothing to change (use --title/--assignee/--priority/--due/--field)')
        const { item } = await appCall('tasks', { op: 'update', env, ref, patch })
        out(`updated ${item.shortId}.`)
        return
      }
      if (sub === 'move') {
        if (!ref) return fail('usage: qwirq work move <ref> <parentRef | --root>')
        const parent = flags.root ? null : positional[2]
        if (parent === undefined) return fail('provide a new parent ref, or --root to detach to the top level')
        const { item } = await appCall('tasks', { op: 'set-parent', env, ref, parent })
        out(`moved ${item.shortId} ${parent == null ? 'to root' : `under ${parent}`}.`)
        return
      }
      if (sub === 'transition') {
        const toState = positional[2]
        if (!ref || !toState) return fail('usage: qwirq work transition <ref> <state> [--note "..."]')
        const { item } = await appCall('tasks', { op: 'transition', env, ref, toState, note: typeof flags.note === 'string' ? flags.note : undefined })
        out(`${item.shortId} → ${item.state}`)
        return
      }
      if (sub === 'tree') {
        if (!ref) return fail('usage: qwirq work tree <ref>')
        const { tree } = await appCall('tasks', { op: 'tree', env, ref })
        const lines = []
        const walk = (n, depth) => { lines.push(`${'  '.repeat(depth)}${n.shortId}  ${n.title}  [${n.state}]`); for (const c of n.children) walk(c, depth + 1) }
        walk(tree, 0)
        out(lines.join('\n'))
        return
      }
      if (sub === 'rm') {
        if (!ref) return fail('usage: qwirq work rm <ref> [--yes]')
        if (!flags.yes) {
          const okGo = await promptYesNo(`Delete work item ${ref}? This cannot be undone. [y/N] `)
          if (okGo === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!okGo) { out('Cancelled.'); return }
        }
        await appCall('tasks', { op: 'remove', env, ref })
        out(`deleted ${ref}.`)
        return
      }
      if (sub === 'link') {
        const to = positional[2]
        if (!ref || !to || typeof flags.type !== 'string') return fail('usage: qwirq work link <from> <to> --type <t> [--remove]')
        if (flags.remove) { await appCall('tasks', { op: 'unlink', env, from: ref, to, linkType: flags.type }); out(`unlinked ${ref} -[${flags.type}]-> ${to}.`); return }
        await appCall('tasks', { op: 'link', env, from: ref, to, linkType: flags.type })
        out(`linked ${ref} -[${flags.type}]-> ${to}.`)
        return
      }
      if (sub === 'link-ci') {
        const ciRef = positional[2]
        if (!ref || !ciRef) return fail('usage: qwirq work link-ci <ref> <ciRef> [--rel <r>] [--remove]')
        // The seam stores a numeric CI id (a soft reference). Resolve a CI short id (BLD-1) to its
        // numeric id via cmdb first; a numeric ref passes straight through.
        let ciId = ciRef
        if (!/^\d+$/.test(String(ciRef))) ciId = (await appCall('cmdb', { op: 'get', env, ref: ciRef })).ci.id
        const rel = typeof flags.rel === 'string' ? flags.rel : undefined
        if (flags.remove) { await appCall('tasks', { op: 'unlink-ci', env, ref, ciId, rel }); out(`unlinked ${ref} from CI ${ciRef}.`); return }
        await appCall('tasks', { op: 'link-ci', env, ref, ciId, rel })
        out(`linked ${ref} to CI ${ciRef}${rel ? ` (${rel})` : ''}.`)
        return
      }
      return fail('usage: qwirq work <init|ls|show|new|set|move|transition|tree|rm|link|link-ci>')
    }

    case 'workplan': {
      // Workplan scrum-object verbs: create + manage Request/Project/Epic/Story/Task/Sprint through
      // the same server-side gates as `work` (no raw CRUD bypass). Six canonical types with their
      // state machines + transition rules, installed once via `workplan init`. --json for
      // agent/script consumption; --env <e> for env override (default: prod).
      const sub = positional[0]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      const json = !!flags.json
      const emitJson = (data) => { out(JSON.stringify(data)) }

      if (sub === 'init') {
        const migrated = await appCall('tasks', { op: 'migrate', env })
        if (!json && migrated.applied.length) out(`created work-item tables (${migrated.applied.join(', ')}).`)
        // Apply Workplan-owned waix_ tables (board #214). Must run after 'migrate' (work_items must exist).
        const waixMigrated = await appCall('tasks', { op: 'waix-init', env })
        if (!json && waixMigrated.applied.length) out(`created Workplan waix_ tables (${waixMigrated.applied.join(', ')}).`)
        const results = []
        for (const name of WP_TYPES) {
          const cfg = WP_CONFIG[name]
          const existing = await appCall('tasks', { op: 'type-get', env, name }).then((r) => r.type).catch(() => null)
          if (existing) {
            await appCall('tasks', { op: 'type-update', env, name, prefix: cfg.prefix, policy: cfg.policy })
            results.push({ name, prefix: cfg.prefix, action: 'updated' })
            if (!json) out(`  ${name} (${cfg.prefix}): updated`)
          } else {
            await appCall('tasks', { op: 'type-define', env, name, prefix: cfg.prefix, policy: cfg.policy })
            results.push({ name, prefix: cfg.prefix, action: 'defined' })
            if (!json) out(`  ${name} (${cfg.prefix}): defined`)
          }
        }
        if (json) emitJson({ ok: true, results, waixApplied: waixMigrated.applied })
        else out('Workplan types ready.')
        return
      }

      if (sub === 'types') {
        const { types } = await appCall('tasks', { op: 'type-ls', env })
        const wpSet = new Set(WP_TYPES)
        const wpInstalled = types.filter((t) => wpSet.has(t.name))
        const missing = WP_TYPES.filter((n) => !types.some((t) => t.name === n))
        if (json) { emitJson({ ok: true, types: wpInstalled, missing }); return }
        if (!wpInstalled.length) { out('(no Workplan types — run: qwirq workplan init)'); return }
        for (const t of wpInstalled) out(`${t.prefix}\t${t.name}\t[${t.policy.states.join(', ')}]`)
        if (missing.length) out(`not installed: ${missing.join(', ')}  — run: qwirq workplan init`)
        return
      }

      if (sub === 'create') {
        const type = positional[1]
        if (!type || !WP_TYPES.includes(type)) return fail(`usage: qwirq workplan create <${WP_TYPES.join('|')}> --title "..." [type-specific flags]`)
        if (typeof flags.title !== 'string' || !flags.title.trim()) return fail('--title is required')
        const cfg = WP_CONFIG[type]
        const input = { type, title: flags.title.trim() }
        const parentRef = typeof flags.parent === 'string' ? flags.parent
          : typeof flags.project === 'string' ? flags.project
          : typeof flags.epic === 'string' ? flags.epic
          : typeof flags.story === 'string' ? flags.story
          : undefined
        if (parentRef !== undefined) input.parent = parentRef
        else if (cfg.policy.requireParent) return fail(`${type} requires a parent (${cfg.policy.allowedParentTypes.join(' or ')}); use --parent <ref>`)
        if (typeof flags.assignee === 'string') input.assignee = flags.assignee
        if (flags.priority !== undefined && flags.priority !== true) input.priority = Number(flags.priority)
        if (typeof flags.due === 'string') input.due = flags.due
        const fieldKv = parseKeyVals(flags.field)
        if (type === 'sprint') {
          if (typeof flags.start !== 'string' && !('start' in fieldKv)) return fail('sprint requires --start <date>')
          if (typeof flags.end !== 'string' && !('end' in fieldKv)) return fail('sprint requires --end <date>')
          if (typeof flags.start === 'string') fieldKv.start = flags.start
          if (typeof flags.end === 'string') fieldKv.end = flags.end
        }
        if (flags.points !== undefined && flags.points !== true) fieldKv.points = Number(flags.points)
        if (Object.keys(fieldKv).length) input.fields = fieldKv
        const { item } = await appCall('tasks', { op: 'create', env, input })
        if (json) { emitJson({ ok: true, item }); return }
        out(`created ${item.shortId}  ${item.title}  [${item.state}]${item.assignee ? `  @${item.assignee}` : ''}`)
        return
      }

      if (sub === 'set') {
        const ref = positional[1]
        if (!ref) return fail('usage: qwirq workplan set <ref> [--title t] [--assignee a] [--priority n] [--due d] [--points n] [--field k=v ...]')
        const patch = {}
        if (typeof flags.title === 'string') patch.title = flags.title
        if (flags.assignee !== undefined) patch.assignee = flags.assignee === true ? null : flags.assignee
        if (flags.priority !== undefined) patch.priority = flags.priority === true ? null : Number(flags.priority)
        if (flags.due !== undefined) patch.due = flags.due === true ? null : flags.due
        const fieldKv = parseKeyVals(flags.field)
        if (flags.points !== undefined && flags.points !== true) fieldKv.points = Number(flags.points)
        if (Object.keys(fieldKv).length) patch.fields = fieldKv
        if (!Object.keys(patch).length) return fail('nothing to change (use --title/--assignee/--priority/--due/--points/--field)')
        const { item } = await appCall('tasks', { op: 'update', env, ref, patch })
        if (json) { emitJson({ ok: true, item }); return }
        out(`updated ${item.shortId}.`)
        return
      }

      if (sub === 'transition') {
        const ref = positional[1]
        const toState = positional[2]
        if (!ref || !toState) return fail('usage: qwirq workplan transition <ref> <state> [--note "..."]')
        const { item } = await appCall('tasks', { op: 'transition', env, ref, toState, note: typeof flags.note === 'string' ? flags.note : undefined })
        if (json) { emitJson({ ok: true, item }); return }
        out(`${item.shortId} → ${item.state}`)
        return
      }

      if (sub === 'move') {
        const ref = positional[1]
        if (!ref) return fail('usage: qwirq workplan move <ref> (<parentRef> | --root)')
        const parent = flags.root ? null : positional[2]
        if (parent === undefined) return fail('provide a new parent ref, or --root to detach to the top level')
        const { item } = await appCall('tasks', { op: 'set-parent', env, ref, parent })
        if (json) { emitJson({ ok: true, item }); return }
        out(`moved ${item.shortId} ${parent == null ? 'to root' : `under ${parent}`}.`)
        return
      }

      if (sub === 'link') {
        const from = positional[1]
        const to = positional[2]
        if (!from || !to || typeof flags.type !== 'string') return fail('usage: qwirq workplan link <from> <to> --type <t> [--remove]')
        if (flags.remove) {
          await appCall('tasks', { op: 'unlink', env, from, to, linkType: flags.type })
          if (json) { emitJson({ ok: true, action: 'unlinked', from, to, linkType: flags.type }); return }
          out(`unlinked ${from} -[${flags.type}]-> ${to}.`)
          return
        }
        await appCall('tasks', { op: 'link', env, from, to, linkType: flags.type })
        if (json) { emitJson({ ok: true, action: 'linked', from, to, linkType: flags.type }); return }
        out(`linked ${from} -[${flags.type}]-> ${to}.`)
        return
      }

      if (sub === 'sprint') {
        const sprintSub = positional[1]
        if (sprintSub === 'assign') {
          const storyRef = positional[2]
          const sprintRef = positional[3]
          if (!storyRef || !sprintRef) return fail('usage: qwirq workplan sprint assign <storyRef> <sprintRef> [--remove]')
          if (flags.remove) {
            await appCall('tasks', { op: 'unlink', env, from: storyRef, to: sprintRef, linkType: 'sprint' })
            if (json) { emitJson({ ok: true, action: 'unassigned', item: storyRef, sprint: sprintRef }); return }
            out(`removed ${storyRef} from sprint ${sprintRef}.`)
            return
          }
          await appCall('tasks', { op: 'link', env, from: storyRef, to: sprintRef, linkType: 'sprint' })
          if (json) { emitJson({ ok: true, action: 'assigned', item: storyRef, sprint: sprintRef }); return }
          out(`assigned ${storyRef} to sprint ${sprintRef}.`)
          return
        }
        return fail('usage: qwirq workplan sprint assign <storyRef> <sprintRef> [--remove]')
      }

      if (sub === 'ls') {
        const filter = {}
        if (typeof flags.type === 'string') {
          if (!WP_TYPES.includes(flags.type)) return fail(`unknown type: ${flags.type}. Valid: ${WP_TYPES.join(', ')}`)
          filter.type = flags.type
        }
        if (typeof flags.state === 'string') filter.state = flags.state
        if (typeof flags.assignee === 'string') filter.assignee = flags.assignee
        if (flags.roots) filter.parent = null
        else if (typeof flags.parent === 'string') filter.parent = flags.parent
        const { items } = await appCall('tasks', { op: 'list', env, filter })
        const wpSet = new Set(WP_TYPES)
        const wpItems = filter.type ? items : items.filter((i) => wpSet.has(i.type))
        if (json) { emitJson({ ok: true, items: wpItems }); return }
        if (!wpItems.length) { out('(no items)'); return }
        for (const i of wpItems) out(`${i.shortId}\t${i.type}\t${i.state}\t${i.title}${i.assignee ? `\t@${i.assignee}` : ''}`)
        return
      }

      if (sub === 'show') {
        const ref = positional[1]
        if (!ref) return fail('usage: qwirq workplan show <ref>')
        const { item } = await appCall('tasks', { op: 'get', env, ref })
        const { links } = await appCall('tasks', { op: 'links', env, ref })
        const { events } = await appCall('tasks', { op: 'events', env, ref })
        if (json) { emitJson({ ok: true, item, links, events: events.slice(-10) }); return }
        out(`${item.shortId}  ${item.title}`)
        out(`  type:   ${item.type}`)
        out(`  state:  ${item.state}`)
        if (item.parentId) out(`  parent: ${item.parentId}`)
        if (item.assignee) out(`  assignee: ${item.assignee}`)
        if (item.priority != null) out(`  priority: ${item.priority}`)
        if (item.due) out(`  due:    ${item.due}`)
        if (item.fields && Object.keys(item.fields).length) out(`  fields: ${JSON.stringify(item.fields)}`)
        for (const l of links.outgoing) out(`  link →  ${l.linkType} ${l.toId}`)
        for (const l of links.incoming) out(`  link ←  ${l.linkType} ${l.fromId}`)
        for (const e of events.slice(-5)) out(`  · ${e.at}  ${e.kind}${e.fromState ? ` ${e.fromState}->${e.toState}` : e.toState ? ` ${e.toState}` : ''}${e.actor ? `  by ${e.actor}` : ''}${e.note ? ` — "${e.note}"` : ''}`)
        return
      }

      return fail('usage: qwirq workplan <init|types|create|set|transition|move|link|sprint|ls|show>')
    }

    case 'ci-type': {
      const sub = positional[0]
      const name = positional[1]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      if (sub === 'define') {
        if (!name || typeof flags.prefix !== 'string') return fail('usage: qwirq ci-type define <name> --prefix <P> [--attr k=type ...]')
        const attributeSchema = parseKeyVals(flags.attr)
        const { type } = await appCall('cmdb', { op: 'type-define', env, name, prefix: flags.prefix, attributeSchema })
        out(`defined CI type ${type.name} (prefix ${type.prefix}).`)
        return
      }
      if (sub === 'update') {
        // cmdb 0.2.0 updateType: change the prefix and/or merge attribute-schema keys (additive). #124.
        if (!name) return fail('usage: qwirq ci-type update <name> [--prefix P] [--attr k=type ...]')
        const { type: existing } = await appCall('cmdb', { op: 'type-get', env, name })
        if (!existing) return fail(`no such CI type: ${name}`)
        const patch = {}
        if (typeof flags.prefix === 'string') patch.prefix = flags.prefix
        const attrs = parseKeyVals(flags.attr)
        if (Object.keys(attrs).length) patch.attributeSchema = { ...existing.attributeSchema, ...attrs }
        if (patch.prefix === undefined && patch.attributeSchema === undefined) return fail('nothing to change (pass --prefix and/or --attr k=type)')
        const { type } = await appCall('cmdb', { op: 'type-update', env, name, ...patch })
        out(`updated CI type ${type.name}.`)
        return
      }
      if (sub === 'ls') {
        const { types } = await appCall('cmdb', { op: 'type-ls', env })
        if (!types.length) { out('(no CI types — run: qwirq ci init, then qwirq ci-type define …)'); return }
        for (const t of types) out(`${t.name}\t${t.prefix}${Object.keys(t.attributeSchema).length ? `\t{${Object.keys(t.attributeSchema).join(', ')}}` : ''}`)
        return
      }
      if (sub === 'show') {
        if (!name) return fail('usage: qwirq ci-type show <name>')
        const { type } = await appCall('cmdb', { op: 'type-get', env, name })
        if (!type) { out(`(no such CI type: ${name})`); return }
        out(`${type.name}  (prefix ${type.prefix})`)
        if (Object.keys(type.attributeSchema).length) out(`  attributes: ${JSON.stringify(type.attributeSchema)}`)
        return
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: qwirq ci-type rm <name>')
        await appCall('cmdb', { op: 'type-rm', env, name })
        out(`removed CI type ${name}.`)
        return
      }
      return fail('usage: qwirq ci-type <define|update|ls|show|rm>')
    }

    case 'ci': {
      // Configuration items: the lightweight subject primitive (WORKPLAN-PLAN §2). CRUD + typed
      // directional relationships. Addressed by short id (BLD-1) or numeric id.
      const sub = positional[0]
      const ref = positional[1]
      const env = typeof flags.env === 'string' ? flags.env : undefined
      if (sub === 'init') {
        const { applied } = await appCall('cmdb', { op: 'migrate', env })
        out(applied.length ? `created CMDB tables (${applied.join(', ')}).` : 'CMDB tables already present.')
        return
      }
      if (sub === 'ls') {
        const filter = {}
        if (typeof flags.type === 'string') filter.type = flags.type
        if (typeof flags.name === 'string') filter.name = flags.name
        const { cis } = await appCall('cmdb', { op: 'list', env, filter })
        if (!cis.length) { out('(no CIs)'); return }
        for (const c of cis) out(`${c.shortId}\t${c.type}\t${c.name}`)
        return
      }
      if (sub === 'show') {
        if (!ref) return fail('usage: qwirq ci show <ref>')
        const { ci } = await appCall('cmdb', { op: 'get', env, ref })
        out(`${ci.shortId}  ${ci.name}`)
        out(`  type: ${ci.type}`)
        if (Object.keys(ci.attributes).length) out(`  attributes: ${JSON.stringify(ci.attributes)}`)
        const { relationships } = await appCall('cmdb', { op: 'relationships', env, ref })
        for (const r of relationships.outgoing) out(`  rel →  ${r.relType} ${r.toId}`)
        for (const r of relationships.incoming) out(`  rel ←  ${r.relType} ${r.fromId}`)
        return
      }
      if (sub === 'new') {
        if (typeof flags.type !== 'string' || typeof flags.name !== 'string') return fail('usage: qwirq ci new --type <t> --name "..." [--attr k=v ...]')
        const input = { type: flags.type, name: flags.name }
        const attributes = parseKeyVals(flags.attr)
        if (Object.keys(attributes).length) input.attributes = attributes
        const { ci } = await appCall('cmdb', { op: 'create', env, input })
        out(`created ${ci.shortId}  ${ci.name}`)
        return
      }
      if (sub === 'set') {
        if (!ref) return fail('usage: qwirq ci set <ref> [--name <n>] [--attr k=v ...]')
        const patch = {}
        if (typeof flags.name === 'string') patch.name = flags.name
        const attributes = parseKeyVals(flags.attr)
        if (Object.keys(attributes).length) patch.attributes = attributes
        if (!Object.keys(patch).length) return fail('nothing to change (use --name/--attr)')
        const { ci } = await appCall('cmdb', { op: 'update', env, ref, patch })
        out(`updated ${ci.shortId}.`)
        return
      }
      if (sub === 'rm') {
        if (!ref) return fail('usage: qwirq ci rm <ref> [--yes]')
        if (!flags.yes) {
          const okGo = await promptYesNo(`Delete CI ${ref} and its relationships? This cannot be undone. [y/N] `)
          if (okGo === null) return fail('refusing to delete in a non-interactive shell without --yes')
          if (!okGo) { out('Cancelled.'); return }
        }
        await appCall('cmdb', { op: 'remove', env, ref })
        out(`deleted ${ref}.`)
        return
      }
      if (sub === 'relate') {
        const to = positional[2]
        if (!ref || !to || typeof flags.type !== 'string') return fail('usage: qwirq ci relate <from> <to> --type <relType> [--remove]')
        if (flags.remove) { await appCall('cmdb', { op: 'unrelate', env, from: ref, to, relType: flags.type }); out(`unrelated ${ref} -[${flags.type}]-> ${to}.`); return }
        await appCall('cmdb', { op: 'relate', env, from: ref, to, relType: flags.type })
        out(`related ${ref} -[${flags.type}]-> ${to}.`)
        return
      }
      return fail('usage: qwirq ci <init|ls|show|new|set|rm|relate>')
    }

    default:
      return fail(`unknown command: ${group}\n\n${HELP}`)
  }
}

main().catch((e) => fail(e?.message ?? String(e)))
