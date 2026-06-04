#!/usr/bin/env node
// qwirq — the QWIRQ command line. Work with Knowledge (Texere) and Secrets from the terminal.
import { apiFetch } from '../src/api.mjs'
import { login } from '../src/login.mjs'
import { loadConfig, clearConfig } from '../src/config.mjs'
import { parseArgs, out, fail, readStdin, promptHidden, editInEditor } from '../src/util.mjs'

const HELP = `qwirq — Knowledge (Texere) + Secrets from the terminal

  qwirq login [--no-browser]        sign in (device flow)
  qwirq logout                      forget the stored token
  qwirq whoami                      show user + active company

  qwirq weave ls                    list weaves
  qwirq weave new <name>            create a weave
  qwirq tree <weaveQID>             show a weave's thread/article tree

  qwirq article get <qid>           print an article's markdown
  qwirq article edit <qid>          edit an article body in $EDITOR
  qwirq article new --weave <id> --title <t> [--thread <id>] [--file <f> | --stdin]
  qwirq article rm <qid>            delete an article (or thread) and its subtree

  qwirq secret ls [--mine|--company]   list secrets (scope + owner)
  qwirq secret reveal <name>        print a secret value (audited)
  qwirq secret set <name> [--stdin] set a secret (hidden prompt, or value from stdin)
  qwirq secret rm <name>            delete a secret
  qwirq secret share <name> <email|role> [--role] [--read|--manage|--own]
  qwirq secret unshare <name> <email|role> [--role]
  qwirq secret grants <name>        show who a secret is shared with
  qwirq members                     list your company's members

Endpoints come from ~/.qwirq/config.json (override: QWIRQ_API_URL, QWIRQ_AUTH_URL).`

function indentTree(nodes, depth, lines) {
  for (const n of nodes || []) {
    const mark = n.kind === 'thread' ? '▸' : '·'
    lines.push(`${'  '.repeat(depth)}${mark} ${n.title}  (${n.qid})`)
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
        for (const w of weaves) out(`${w.qid}\t${w.name}`)
        return
      }
      if (sub === 'new') {
        const name = positional.slice(1).join(' ').trim()
        if (!name) return fail('usage: qwirq weave new <name>')
        const r = await apiFetch('POST', '/api/v1/weaves', { body: { name } })
        out(`created weave ${r.weaveQID}  ${r.name}`)
        return
      }
      return fail('usage: qwirq weave <ls|new>')
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

    case 'secret': {
      const sub = positional[0]
      const name = positional[1]
      if (sub === 'ls') {
        const { secrets } = await apiFetch('GET', '/api/v1/secrets')
        let list = secrets
        if (flags.mine) list = list.filter((s) => s.scope === 'user')
        if (flags.company) list = list.filter((s) => s.scope === 'company')
        if (!list.length) { out('(no secrets)'); return }
        for (const s of list) out(s.scope === 'company' ? `${s.name}  [company · ${s.owner}]` : s.name)
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
        if (!name) return fail('usage: qwirq secret set <name> [--stdin]')
        let value = flags.stdin ? (await readStdin()).replace(/\r?\n$/, '') : await promptHidden(`Value for ${name}: `)
        if (!value) return fail('value is required')
        await apiFetch('PUT', `/api/v1/secrets/${encodeURIComponent(name)}`, { body: { value } })
        out(`Set ${name}.`)
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
        if (!name || !grantee) return fail('usage: qwirq secret share <name> <email|role> [--role] [--read|--manage|--own]')
        const kind = flags.role ? 'role' : 'user'
        const permission = flags.own ? 'own' : flags.manage ? 'manage' : 'read'
        await apiFetch('POST', `/api/v1/secrets/${encodeURIComponent(name)}/share`, { body: { grantee, kind, permission } })
        out(`Shared ${name} with ${kind === 'role' ? '@' + grantee : grantee} (${permission}).`)
        return
      }
      if (sub === 'unshare') {
        const grantee = positional[2]
        if (!name || !grantee) return fail('usage: qwirq secret unshare <name> <email|role> [--role]')
        const kind = flags.role ? 'role' : 'user'
        await apiFetch('DELETE', `/api/v1/secrets/${encodeURIComponent(name)}/share?kind=${kind}&grantee=${encodeURIComponent(grantee)}`)
        out(`Unshared ${name} from ${kind === 'role' ? '@' + grantee : grantee}.`)
        return
      }
      if (sub === 'grants') {
        if (!name) return fail('usage: qwirq secret grants <name>')
        const { grants } = await apiFetch('GET', `/api/v1/secrets/${encodeURIComponent(name)}/grants`)
        if (!grants.length) { out('(private — not shared)'); return }
        for (const g of grants) out(`${g.permission.padEnd(7)} ${g.userEmail || '@' + g.roleName}`)
        return
      }
      return fail('usage: qwirq secret <ls|reveal|set|rm|share|unshare|grants>')
    }

    case 'members': {
      const { members } = await apiFetch('GET', '/api/v1/members')
      for (const m of members) out(`${m.email}  (${m.roleName})`)
      return
    }

    default:
      return fail(`unknown command: ${group}\n\n${HELP}`)
  }
}

main().catch((e) => fail(e?.message ?? String(e)))
