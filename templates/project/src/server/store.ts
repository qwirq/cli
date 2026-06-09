/**
 * The app-DB seam. Your server-side logic reaches its tenant's app-plane data through a @qwirq/bridge
 * handle.
 *
 * - Deployed in a QWIRQ instance: the runtime binds the AMBIENT bridge per execution — app code just
 *   imports `{ bridge }` and uses it (no setup, no way to reach another tenant).
 * - Local dev (`qwirq dev` / `npm run dev`): set `QWIRQ_DB_URL` to a dev app DB and we open an explicit
 *   handle. `qwirq dev` injects that env var for you.
 */
import { createBridge, bridge as ambient, type Bridge } from '@qwirq/bridge'
import { migrateTasks } from '@qwirq/tasks'
import { migrateCmdb } from '@qwirq/cmdb'

export interface AppDb {
  bridge: Bridge
  close: () => Promise<void>
}

/** A bridge to the app DB: the explicit dev handle if `QWIRQ_DB_URL` is set, else the ambient (deployed). */
export function appDb(): AppDb {
  const url = process.env.QWIRQ_DB_URL
  if (url) {
    const b = createBridge(url)
    return { bridge: b as unknown as Bridge, close: () => b.close() }
  }
  return { bridge: ambient, close: async () => {} }
}

/** Ensure the platform primitive tables exist in the app DB (idempotent). Run at setup / dev start. */
export async function ensureSchema(url = process.env.QWIRQ_DB_URL): Promise<void> {
  if (!url) throw new Error('ensureSchema needs QWIRQ_DB_URL (qwirq dev binds it for local dev)')
  await migrateTasks(url)
  await migrateCmdb(url)
}
