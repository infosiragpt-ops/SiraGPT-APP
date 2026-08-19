import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  renameWorkspaceFile,
  updateWorkspaceFile,
  type CodeWorkspaceState,
} from "../lib/code-workspace-state"

function workspace(entries: Record<string, string>, activePath: string | null = null): CodeWorkspaceState {
  const files = Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [
      path,
      { path, content, language: "typescript", updatedAt: 1 },
    ]),
  )
  const openTabs = Object.keys(entries)
  return { files, openTabs, activePath: activePath ?? openTabs[0] ?? null }
}

describe("code workspace file transitions", () => {
  it("emits a write only when an existing file content really changes", () => {
    const initial = workspace({ "src/app.ts": "before" })
    const missing = updateWorkspaceFile(initial, "missing.ts", "after", 2)
    const unchanged = updateWorkspaceFile(initial, "src/app.ts", "before", 2)
    const changed = updateWorkspaceFile(initial, "src/app.ts", "after", 2)

    assert.strictEqual(missing.state, initial)
    assert.equal(missing.mirror, null)
    assert.strictEqual(unchanged.state, initial)
    assert.equal(unchanged.mirror, null)
    assert.equal(changed.state.files["src/app.ts"].content, "after")
    assert.equal(changed.state.files["src/app.ts"].updatedAt, 2)
    assert.deepEqual(changed.mirror, { kind: "write", path: "src/app.ts", content: "after" })
  })

  it("focuses an existing file without overwriting or mirroring it", () => {
    const initial = workspace({ "src/app.ts": "keep", "src/other.ts": "other" }, "src/other.ts")
    const result = createWorkspaceFile(initial, "src/app.ts", "do not overwrite", 2)

    assert.equal(result.state.activePath, "src/app.ts")
    assert.equal(result.state.files["src/app.ts"].content, "keep")
    assert.equal(result.mirror, null)
  })

  it("creates, renames and deletes with one explicit mirror command per transition", () => {
    const initial = workspace({ "src/app.ts": "app" })
    const created = createWorkspaceFile(initial, "src/new.tsx", "new", 2)
    const renamed = renameWorkspaceFile(created.state, "src/new.tsx", "src/view.tsx", 3)
    const deleted = deleteWorkspaceFile(renamed.state, "src/view.tsx")

    assert.deepEqual(created.mirror, { kind: "write", path: "src/new.tsx", content: "new" })
    assert.deepEqual(renamed.mirror, {
      kind: "rename",
      from: "src/new.tsx",
      to: "src/view.tsx",
    })
    assert.deepEqual(deleted.mirror, { kind: "delete", path: "src/view.tsx" })
    assert.equal(deleted.state.files["src/view.tsx"], undefined)
    assert.equal(deleted.state.activePath, "src/app.ts")
  })

  it("refuses missing/colliding rename and missing delete without mirror commands", () => {
    const initial = workspace({ "src/a.ts": "a", "src/b.ts": "b" })
    const missingRename = renameWorkspaceFile(initial, "missing.ts", "src/c.ts", 2)
    const collidingRename = renameWorkspaceFile(initial, "src/a.ts", "src/b.ts", 2)
    const missingDelete = deleteWorkspaceFile(initial, "missing.ts")

    for (const result of [missingRename, collidingRename, missingDelete]) {
      assert.strictEqual(result.state, initial)
      assert.equal(result.mirror, null)
    }
  })
})
