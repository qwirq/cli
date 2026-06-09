import React from 'react'

// Your app's UI (a Module Federation remote, the `provides.app.entry`). It builds into an artifact and
// deploys into your QWIRQ instance on `git push` (the P0-c pipeline). A browser remote cannot import the
// server-side @qwirq/* data libs; it reaches app data through the in-instance backend seam
// (qwirq.yaml `provides.functions`, DX-4) when you grow past CLI-first.
export default function App() {
  return (
    <div style={{ padding: 16 }}>
      <strong>__NAME__</strong>
      <p>A QWIRQ app on @qwirq/tasks + @qwirq/cmdb.</p>
    </div>
  )
}
