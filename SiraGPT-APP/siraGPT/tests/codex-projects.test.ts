import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"

import {
  codexEntryDisplayPath,
  codexIdForLocalFolder,
  codexIdForProject,
  listCodexProjects,
  removeCodexProject,
  upsertCodexProject,
} from "../lib/codex-projects"

describe("codex-projects registry", () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    ;(globalThis as { localStorage: Storage }).localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: (key) => { storage.delete(key) },
      clear: () => { storage.clear() },
      key: () => null,
      length: 0,
    } as Storage
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  it("builds stable ids for local folders and projects", () => {
    assert.equal(codexIdForLocalFolder("siraGPT"), "local:siragpt")
    assert.equal(codexIdForProject("abc-123"), "project:abc-123")
  })

  it("upserts and sorts by recency", () => {
    upsertCodexProject({ id: "local:a", name: "A", kind: "local-folder", updatedAt: 10 })
    upsertCodexProject({ id: "project:b", name: "B", kind: "project", updatedAt: 20 })
    const rows = listCodexProjects()
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.id, "project:b")
  })

  it("removes entries by id", () => {
    upsertCodexProject({ id: "local:a", name: "A", kind: "local-folder" })
    const rows = removeCodexProject("local:a")
    assert.equal(rows.length, 0)
  })

  it("formats display path for picker", () => {
    assert.equal(
      codexEntryDisplayPath({
        id: "local:siragpt",
        name: "siraGPT",
        kind: "local-folder",
        updatedAt: 1,
      }),
      "~/Desktop/siraGPT",
    )
    assert.equal(
      codexEntryDisplayPath({
        id: "local:x",
        name: "x",
        kind: "local-folder",
        displayPath: "~/Projects/x",
        updatedAt: 1,
      }),
      "~/Projects/x",
    )
  })
})
