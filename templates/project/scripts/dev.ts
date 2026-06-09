/**
 * Local dev entry. `qwirq dev` runs this with `QWIRQ_DB_URL` bound to a dev app DB. It ensures the
 * platform primitive tables exist and exercises @qwirq/tasks + @qwirq/cmdb against the real DB — proving
 * the authoring loop. Replace this demo with your app's logic.
 */
import { ensureSchema, appDb } from '../src/server/store'
import * as tasks from '@qwirq/tasks'
import * as cmdb from '@qwirq/cmdb'

async function main() {
  if (!process.env.QWIRQ_DB_URL) {
    console.error('QWIRQ_DB_URL is not set. Run `qwirq dev` (it binds your dev app DB).')
    process.exit(2)
  }
  await ensureSchema()
  const { bridge: b, close } = appDb()
  try {
    await tasks.installDefaultType(b)
    const wi = await tasks.create(b, { type: 'default', title: 'First work item' }, 'dev')
    console.log('connected to the dev app DB; primitives are live.')
    console.log('  work item :', wi.shortId, '·', wi.title, '·', wi.state)
    console.log('  work items:', (await tasks.list(b)).length, 'total')
    console.log('the authoring loop works. build your app from here.')
  } finally {
    await close()
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
