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
  it("renders the company in the former desktop agent column", () => {
    assert.match(workspaceSource, /\[APPS navigator\] \| \[Agent company\] \| \[Preview\]/)
    assert.match(workspaceSource, /<ResizablePanel[\s\S]*?<MemoAgentCompanyPanel \/>[\s\S]*?<ResizableHandle/)
    assert.match(companySource, /data-agent-company-dock="workspace"/)
    assert.doesNotMatch(companySource, /createPortal|subscribeAgentCompanySlot/)
  })

  it("keeps APPS as the project navigator instead of a company portal", () => {
    assert.match(sidebarSource, /<SidebarFoldersDropdown/)
    assert.doesNotMatch(sidebarSource, /AgentCompanyAppsSlot|registerAgentCompanySlot/)
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
