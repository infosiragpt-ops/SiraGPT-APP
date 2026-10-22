import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
const sidebarSource = readFileSync("components/app-sidebar.tsx", "utf8")
const contextSource = readFileSync("lib/code-workspace-context.tsx", "utf8")
const sessionsSource = readFileSync("lib/code-chat-sessions.ts", "utf8")

describe("agent company placement", () => {

  it("docks the company navigator in the expanded APPS rail", () => {
    assert.match(sidebarSource, /AgentCompanyAppsSlot/)
    assert.match(sidebarSource, /registerAgentCompanySlot/)
    assert.match(sidebarSource, /<AgentCompanyAppsSlot \/>/)
  })

  it("passes proactive state explicitly and creates parallel sessions atomically", () => {
    assert.match(contextSource, /setChatSessionStore\(\(prev\) =>[\s\S]*?createCodeChatSessionRecord/)
  })

  it("does not re-enter React while bootstrapping a fresh session store", () => {
    assert.match(
      contextSource,
      /setChatSessionStore\(ensureDefaultSession\(workspaceSessionKey, readCodeChatStore\(\)\)\)/,
    )
    assert.match(sessionsSource, /window\.setTimeout\(fire, 0\)/)
    assert.doesNotMatch(sessionsSource, /queueMicrotask\(fire\)/)
  })
})
