import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  agentInitials,
  askAgentPlaceholder,
  CODE_MOBILE_GROK_MAX_PX,
  isCodeMobileGrokWidth,
} from "../lib/code-mobile-grok"

const workspace = readFileSync("components/code/code-workspace.tsx", "utf8")
const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const chrome = readFileSync("components/code/code-mobile-grok-chrome.tsx", "utf8")
const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const styles = readFileSync("app/globals.css", "utf8")
const docs = readFileSync("docs/code-mobile-grok.md", "utf8")

describe("phone /code Grok chrome", () => {
  it("activates only below the 768px breakpoint and leaves desktop chrome intact", () => {
    assert.equal(CODE_MOBILE_GROK_MAX_PX, 768)
    assert.equal(isCodeMobileGrokWidth(375), true)
    assert.equal(isCodeMobileGrokWidth(767), true)
    assert.equal(isCodeMobileGrokWidth(768), false)
    assert.equal(isCodeMobileGrokWidth(1280), false)
    assert.match(workspace, /data-testid=\{isMobile \? "code-mobile-grok-shell" : "code-workspace-desktop"\}/)
    assert.match(workspace, /\{isMobile \? null : \(/)
    assert.match(workspace, /<WorkspaceTopBar/)
    assert.match(workspace, /\[APPS company rail\] \| \[CEO Office\] \| \[Preview\]/)
    assert.match(workspace, /<MemoAICodeChatPanel embedded \/>/)
    assert.doesNotMatch(
      workspace,
      /if \(isMobile\) \{[\s\S]{0,800}\{ id: "chat", label: "Empresa" \}/,
    )
  })

  it("renders the Grok header, capsule composer, and computer overlay on the phone path", () => {
    assert.match(chrome, /data-testid="code-mobile-grok-fill"/)
    assert.match(chrome, /flex h-full min-h-0 flex-1 flex-col/)
    assert.match(chat, /<CodeMobileGrokShell>/)
    assert.match(chat, /data-testid=\{isMobileGrok \? "code-mobile-grok-transcript"/)
    assert.match(chat, /className="min-h-0 flex-1 overflow-y-auto p-4"/)
    assert.match(company, /phoneChatFill/)
    assert.match(company, /relative flex min-h-0 flex-1 flex-col overflow-hidden/)
    assert.match(workspace, /h-full min-h-0 bg-white/)
    assert.match(workspace, /h-screen bg-background/)
    assert.match(styles, /--app-viewport-height/)
    assert.match(styles, /\.code-mobile-grok-composer[\s\S]*position:\s*sticky/)
    assert.match(chrome, /data-testid="code-mobile-grok-header"/)
    assert.match(chrome, /data-testid="code-mobile-grok-back"/)
    assert.match(chrome, /data-testid="code-mobile-grok-agent-pill"/)
    assert.match(chrome, /data-testid="code-mobile-grok-online"/)
    assert.match(chrome, /data-testid="code-mobile-grok-computer"/)
    assert.match(chrome, /data-testid="code-mobile-grok-computer-overlay"/)
    assert.match(chrome, /<DepartmentComputerPane/)
    assert.match(chat, /<CodeMobileGrokHeader/)
    assert.match(chat, /askAgentPlaceholder\(grokAgentName\)/)
    assert.match(chat, /data-testid="code-mobile-grok-input"/)
    assert.match(chat, /<CodeMobileGrokMic/)
    assert.match(chat, /data-testid="code-mobile-grok-model"/)
    assert.match(chat, /data-testid=\{circular \? "code-mobile-grok-plus"/)
    assert.match(chat, /CODE_OPEN_CURRENT_DEPARTMENT_COMPUTER_EVENT/)
    assert.match(workspace, /<CodeMobileComputerOverlay/)
    assert.match(styles, /\.code-mobile-grok-capsule/)
    assert.match(styles, /\.code-mobile-grok-circle/)
  })

  it("keeps send, attachments, voice, and DeepSeek-only models on the phone composer", () => {
    assert.equal(askAgentPlaceholder("Prueba"), "Ask Prueba")
    assert.equal(askAgentPlaceholder(""), "Ask Agent")
    assert.equal(agentInitials("Prueba"), "P")
    assert.match(chat, /listDeepSeekGenerationModels\(catalog\)/)
    assert.match(chat, /if \(isMobileGrok\) return listDeepSeekGenerationModels/)
    assert.match(chat, /onAttach=\{\(\) => codeFileInputRef\.current\?\.click\(\)\}/)
    assert.match(chat, /<ComposerSendArrow className="h-4 w-4" \/>/)
    assert.doesNotMatch(
      chat,
      /if \(isMobileGrok\) return listDeepSeekGenerationModels[\s\S]{0,80}OpenRouter/,
    )
    assert.match(company, /hideCompanyTools=\{isMobile\}/)
  })

  it("documents the phone-only contract", () => {
    assert.match(docs, /Grok Bot/)
    assert.match(docs, /768/)
    assert.match(docs, /DeepSeek/)
    assert.match(docs, /production-main/)
  })
})
