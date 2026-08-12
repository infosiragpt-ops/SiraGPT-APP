import assert from "node:assert/strict"
import { test } from "node:test"

import { changedWorkspaceFiles } from "../lib/code-agent/workspace-diff"

test("changedWorkspaceFiles reports only new or edited files", () => {
  const before = {
    "src/app.tsx": "export default function App() { return null }",
    "package.json": "{\"name\":\"old\"}",
  }
  const after = {
    "src/app.tsx": { path: "src/app.tsx", content: "export default function App() { return <h1>Hola</h1> }" },
    "package.json": { path: "package.json", content: "{\"name\":\"old\"}" },
    "src/page.tsx": { path: "src/page.tsx", content: "export default function Page() { return null }" },
  }

  assert.deepEqual(changedWorkspaceFiles(before, after), [
    { path: "src/app.tsx", content: "export default function App() { return <h1>Hola</h1> }" },
    { path: "src/page.tsx", content: "export default function Page() { return null }" },
  ])
})

test("changedWorkspaceFiles ignores a stale React snapshot (same object twice)", () => {
  const snapshot = {
    "src/app.tsx": { path: "src/app.tsx", content: "same" },
  }
  const before = { "src/app.tsx": "same" }
  assert.deepEqual(changedWorkspaceFiles(before, snapshot), [])
})
