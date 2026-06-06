#!/usr/bin/env node
// qwirq — the QWIRQ command line. Work with Knowledge (Texere) and Secrets from the terminal.
import { execFileSync } from 'node:child_process'
import { apiFetch } from '../src/api.mjs'
import { login } from '../src/login.mjs'
import { loadConfig, clearConfig } from '../src/config.mjs'
import { parseArgs, out, fail, readStdin, promptHidden, editInEditor } from '../src/util.mjs'

const HELP = `qwirq — Knowledge (Texere) + Secrets from the terminal

  qwirq login [--no-browser]        sign in (device flow)
  qwirq logout                      forget the stored token
  qwirq whoami                      show user + active company

  qwirq weave ls                    list weaves (🔒 = restricted)
  qwirq weave new <name>            create a weave
  qwirq weave access <weaveQID>     show a weave's audience (open, or who it's restricted to)
  qwirq weave restrict <weaveQID> <email|role|group> [--role|--group] [--manage] [--remove]
  qwirq tree <weaveQID>             show a weave's thread/article tree

  qwirq article get <qid>           print an article's markdown
  qwirq article edit <qid>          edit an article body in $EDITOR
  qwirq article new --weave <id> --title <t> [--thread <id>] [--file <f> | --stdin]
  qwirq article rm <qid>            delete an article (or thread) and its subtree
  qwirq node access <qid>           show a document/thread's audience (open, or who it's restricted to)
  qwirq node restrict <qid> <email|role|group> [--role|--group] [--manage] [--remove]

  qwirq secret ls [query] [--mine|--company]   list/search secrets (name · key · description)
  qwirq secret show <name>          view a secret object (label, logical key, description; value hidden)
  qwirq secret reveal <name>        print a secret value (audited)
  qwirq secret set <name> [--stdin] [--label <t>] [--key <k>] [--desc <text>]   set value and/or metadata
  qwirq secret rm <name>            delete a secret
  qwirq secret share <name> <email|role|group> [--role|--group] [--read|--manage|--own]
  qwirq secret unshare <name> <email|role|group> [--role|--group]
  qwirq secret grants <name>        show who a secret is shared with
  qwirq members                     list your company's members

  qwirq group ls                    list groups
  qwirq group create <name>         create a group (admin)
  qwirq group members <name>        list a group's members
  qwirq group add <name> <email>    add a member to a group (admin)
  qwirq group rm <name> <email>     remove a member from a group (admin)

  qwirq git setup                   let git authenticate to git.qwirq.com with your qwirq login
  qwirq clone <project>             clone a project repo over HTTPS (uses your login, no keys)

Endpoints come from ~/.qwirq/config.json (override: QWIRQ_API_URL, QWIRQ_AUTH_URL, QWIRQ_GIT_URL).`

function indentTree(nodes, depth, lines) {
  for (const n of nodes || []) {
    const mark = n.kind === 'thread' ? '▸' : '·'
    lines.push(`${'  '.repeat(depth)}${mark} ${n.restricted ? '🔒 ' : ''}${n.title}  (${n.qid})`)
    if (n.children?.length) indentTree(n.children, depth + 1, lines)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const group = argv[0]
  const { positional, flags } = parseArgs(argv.slice(1))

  if (!group || group === 'help' || flags.help || group === '--help') { out(HELP); return }

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
      if (!cfg.token) return
      process.stdout.write(`username=qwirq\npassword=${cfg.token}\n`)
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
      return fail('usage: qwirq weave <ls|new|access|restrict>')
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
      if (sub === 'ls' || sub === 'search') {
        const { secrets } = await apiFetch('GET', '/api/v1/secrets')
        let list = secrets
        if (flags.mine) list = list.filter((s) => s.scope === 'user')
        if (flags.company) list = list.filter((s) => s.scope === 'company')
        const q = (positional[1] || '').toLowerCase()
        if (q) list = list.filter((s) => [s.label, s.name, s.key, s.description].some((f) => (f || '').toLowerCase().includes(q)))
        if (!list.length) { out(q ? `(no secrets match "${positional[1]}")` : '(no secrets)'); return }
        for (const s of list) {
          const title = s.label || s.name
          const sub = [s.label ? s.name : null, s.key ? `key:${s.key}` : null, s.scope === 'company' ? `company · ${s.owner}` : null].filter(Boolean)
          const meta = sub.length ? `  [${sub.join(' · ')}]` : ''
          const desc = s.description ? `  — ${s.description}` : ''
          out(`${title}${meta}${desc}`)
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
        out(`  scope:       ${s.scope}${s.scope === 'company' ? ` (owner ${s.owner})` : ''}`)
        out(`  value:       (hidden — run: qwirq secret reveal ${s.name})`)
        return
      }
      if (sub === 'reveal') {
        if (!name) return fail('usage: qwirq secret reveal <name>')
        const r = await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(name)}/reveal`)
        out(r.value) // value to stdout (clean for pipes)
        // handling guidance to stderr, so it never contaminates a pipe
        process.stderr.write('Sensitive: do not save to disk, logs, or shell history.\n')
        return
      }
      if (sub === 'set') {
        if (!name) return fail('usage: qwirq secret set <name> [--stdin] [--label <text>] [--key <k>] [--desc <text>]')
        const hasLabel = flags.label !== undefined
        const hasKey = flags.key !== undefined
        const hasDesc = flags.desc !== undefined || flags.description !== undefined
        const hasMeta = hasLabel || hasKey || hasDesc
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
        const parts = []
        if (body.value !== undefined) parts.push('value')
        if (hasLabel) parts.push('name')
        if (hasKey) parts.push('key')
        if (hasDesc) parts.push('description')
        if (!parts.length) return fail('nothing to set')
        await apiFetch('PUT', `/api/v1/secrets/${encodeURIComponent(name)}`, { body })
        out(`Set ${name} (${parts.join(', ')}).`)
        return
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: qwirq secret rm <name>')
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
      return fail('usage: qwirq secret <ls|search|show|reveal|set|rm|share|unshare|grants>')
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

    default:
      return fail(`unknown command: ${group}\n\n${HELP}`)
  }
}

main().catch((e) => fail(e?.message ?? String(e)))
