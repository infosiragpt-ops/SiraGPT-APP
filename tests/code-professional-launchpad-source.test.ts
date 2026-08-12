import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chatSource = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const previewSource = readFileSync("components/code/preview-pane.tsx", "utf8")
const workspaceSource = readFileSync("components/code/code-workspace.tsx", "utf8")

describe("professional /code launchpad", () => {
  it("routes starter instructions through the same mode-aware durable dispatch", () => {
    assert.match(chatSource, /CODE_AGENT_REQUEST_EVENT/)
    assert.match(chatSource, /const effectiveMode = opts\?\.mode \?\? composerMode/)
    assert.match(chatSource, /parked\.text, \{ files: parked\.files, mode: parked\.mode \}/)
    assert.match(chatSource, /requestCodeAgentInstruction\(starter\.prompt, \{ mode: "app" \}\)/)
  })

  it("separates autonomous builds from local prototypes", () => {
    assert.match(previewSource, /Crear con el agente/)
    assert.match(previewSource, /Prototipos locales/)
    assert.match(previewSource, /no inician un desarrollo autónomo/)
    assert.match(previewSource, /requestCodeAgentInstruction\(starter\.prompt, \{ mode: "app" \}\)/)
  })

  it("really toggles the chat and unmounts a closed preview", () => {
    assert.match(workspaceSource, /if \(chatOpen\) \{\s*setChatOpen\(false\)/)
    assert.match(workspaceSource, /previewOpen \? \(\s*<MemoPreviewPane \/>/)
    assert.match(workspaceSource, /handleTogglePanel\("preview"\)/)
  })

  it("closes Shell through the canonical panel lifecycle", () => {
    assert.match(
      workspaceSource,
      /<TerminalPanel open=\{terminalOpen\} onClose=\{\(\) => handleClosePanel\("terminal"\)\} \/>/,
    )
    assert.doesNotMatch(
      workspaceSource,
      /<TerminalPanel open=\{terminalOpen\} onClose=\{\(\) => setTerminalOpen\(false\)\} \/>/,
    )
    assert.match(
      workspaceSource,
      /if \(terminalOpen\) \{\s*handleClosePanel\("terminal"\)/,
    )
  })

  it("uses the dynamic app viewport and safe mobile navigation", () => {
    assert.match(workspaceSource, /h-\[var\(--app-viewport-height,100dvh\)\]/)
    assert.match(workspaceSource, /pb-\[env\(safe-area-inset-bottom\)\]/)
    assert.match(workspaceSource, /role="tablist"/)
    assert.match(workspaceSource, /role="tabpanel"/)
    assert.match(workspaceSource, /aria-selected=\{mobileView === tab\.id\}/)
  })
})
