import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterfacePath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const chatInterface = fs.readFileSync(chatInterfacePath, "utf8")

function functionBody(name: string) {
  const start = chatInterface.indexOf(`const ${name} =`)
  assert.notEqual(start, -1, `missing ${name}`)
  const open = chatInterface.indexOf("{", start)
  assert.notEqual(open, -1, `missing ${name} body`)
  let depth = 0
  for (let index = open; index < chatInterface.length; index += 1) {
    const ch = chatInterface[index]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return chatInterface.slice(open, index + 1)
    }
  }
  assert.fail(`unbalanced ${name} body`)
}

describe("chat composer typing performance source contract", () => {
  it("keeps stable composer controls from re-rendering on every keystroke", () => {
    assert.match(
      chatInterface,
      /const\s+ActiveOptionsDisplay\s*=\s*React\.memo\(/,
      "attachment chips must be memoized so long-paste chips do not relayout on every character"
    )
    assert.match(
      chatInterface,
      /const\s+NavbarModelSelector\s*=\s*React\.memo\(/,
      "model selector must be memoized so provider buttons do not flicker on every character"
    )
    assert.match(
      chatInterface,
      /const\s+removeFile\s*=\s*React\.useCallback\(/,
      "attachment-chip callbacks passed into the memoized chip rail must be stable"
    )
    assert.match(
      chatInterface,
      /const\s+handleComposerAttachmentPreview\s*=\s*React\.useCallback\(/,
      "composer preview callback must not invalidate memoized chips on every parent render"
    )
  })

  it("isolates the transcript from high-frequency composer state", () => {
    const transcriptStart = chatInterface.indexOf("const ChatMessageList =")
    const chatContentStart = chatInterface.indexOf("function ChatInterfaceContent()")

    assert.ok(transcriptStart >= 0, "the transcript component must exist")
    assert.ok(chatContentStart > transcriptStart, "the transcript must be declared outside the chat shell")
    assert.match(
      chatInterface.slice(transcriptStart, chatContentStart),
      /const\s+ChatMessageList\s*=\s*React\.memo\(/,
      "typing must not reconcile historical message renderers"
    )
    assert.match(
      chatInterface.slice(chatContentStart),
      /<ChatMessageList[\s\S]*messages=\{currentChat\?\.messages\s*\?\?\s*EMPTY_CHAT_MESSAGES\}/,
      "the chat shell must pass a stable empty-list fallback"
    )
    assert.doesNotMatch(
      chatInterface.slice(chatContentStart),
      /const\s+messages\s*=\s*dedupeMessages/,
      "deduplication must not run in the composer-owning parent"
    )
  })

  it("does not schedule duplicate textarea resize work per input event", () => {
    const changeBody = functionBody("handleTextareaChange")
    const resizeBody = functionBody("resizeComposerTextarea")

    assert.doesNotMatch(
      changeBody,
      /requestAnimationFrame\s*\(\s*resizeComposerTextarea\s*\)/,
      "native typing should not schedule resize in both onChange and the input effect"
    )
    assert.match(
      chatInterface,
      /const\s+scheduleComposerTextareaResize\s*=\s*React\.useCallback\(/,
      "textarea measurements must be coalesced to one animation frame"
    )
    assert.doesNotMatch(
      resizeBody,
      /requestAnimationFrame/,
      "the measured resize must not enqueue a second layout frame"
    )
  })

  it("updates layout CSS variables only when their pixel values change", () => {
    const syncBody = functionBody("syncChatLayoutVars")

    assert.match(
      chatInterface,
      /const\s+chatLayoutVarsRef\s*=\s*React\.useRef<Record<string,\s*number>>\(\{\}\)/,
      "layout vars should keep a previous-value cache"
    )
    assert.match(
      syncBody,
      /if\s*\(\s*chatLayoutVarsRef\.current\[name\]\s*===\s*roundedValue\s*\)\s*return/,
      "CSS vars should not be re-written when the measured value is unchanged"
    )
  })
})
