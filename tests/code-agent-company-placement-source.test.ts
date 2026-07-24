import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const workspaceSource = readFileSync("components/code/code-workspace.tsx", "utf8")
const sidebarSource = readFileSync("components/app-sidebar.tsx", "utf8")
const companySource = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const chatSource = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const contextSource = readFileSync("lib/code-workspace-context.tsx", "utf8")
const sessionsSource = readFileSync("lib/code-chat-sessions.ts", "utf8")

describe("agent company placement", () => {
  it("keeps the three desktop surfaces visible", () => {
    assert.match(workspaceSource, /\[APPS company rail\] \| \[CEO Office\] \| \[Preview\]/)
    assert.match(workspaceSource, /<MemoAgentCompanyPanel \/>[\s\S]*?<MemoAICodeChatPanel embedded \/>/)
    assert.match(companySource, /createPortal\(panel, dockSlot\)/)
    assert.match(companySource, /data-agent-company-dock=\{dockedInAppsRail \? "apps" : "workspace"\}/)
  })

  it("opens department chats directly and keeps social resources inside the company rail", () => {
    assert.match(companySource, /const openDepartmentChat = React\.useCallback/)
    assert.match(companySource, /setActiveCodeChatSession\(sessionId\)/)
    assert.match(companySource, /<ResourcesView workspaceId=/)
    assert.match(companySource, /facebook:[\s\S]*linkedin:[\s\S]*x:/i)
  })

  it("docks the company navigator in the expanded APPS rail", () => {
    assert.match(sidebarSource, /AgentCompanyAppsSlot/)
    assert.match(sidebarSource, /registerAgentCompanySlot/)
    assert.match(sidebarSource, /<AgentCompanyAppsSlot \/>/)
  })

  it("passes proactive state explicitly and creates parallel sessions atomically", () => {
    assert.match(companySource, /proactive=\{proactiveOn\}/)
    assert.doesNotMatch(chatSource, /subscribeProactiveCompany/)
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
