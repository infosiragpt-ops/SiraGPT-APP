import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearSessionCodexProject,
  clearWorkspaceCodexProject,
  linkedCodexProject,
  persistSessionCodexProject,
  persistWorkspaceCodexProject,
  readSessionCodexProject,
  readWorkspaceCodexProject,
} from "../lib/codex/codex-project-link"

describe("codex project links", () => {
  it("shares one project across a company and falls back to legacy session links", () => {
    const values = new Map<string, string>()
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage },
    })

    try {
      persistWorkspaceCodexProject("company-1", "codex-company")
      assert.equal(readWorkspaceCodexProject("company-1"), "codex-company")
      assert.equal(
        linkedCodexProject({ workspaceId: "company-1", sessionId: "department-1" }),
        "codex-company",
      )

      persistSessionCodexProject("department-1", "codex-specialist")
      assert.equal(readSessionCodexProject("department-1"), "codex-specialist")
      assert.equal(
        linkedCodexProject({ workspaceId: "company-1", sessionId: "department-1" }),
        "codex-company",
      )

      clearWorkspaceCodexProject("company-1")
      assert.equal(
        linkedCodexProject({ workspaceId: "company-1", sessionId: "department-1" }),
        "codex-specialist",
      )
      clearSessionCodexProject("department-1")
      assert.equal(linkedCodexProject({ workspaceId: "company-1" }), null)
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
