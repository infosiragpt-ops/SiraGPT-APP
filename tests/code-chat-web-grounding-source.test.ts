import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

describe("CEO Office public-web transport", () => {
  it("keeps general agent tools disabled while opting into public grounding", () => {
    assert.match(source, /disableAgentic:\s*true/)
    assert.match(source, /enableWebGrounding:\s*webGroundedConversation/)
    assert.match(source, /webGroundingQuery:\s*webGroundingQuery\s*\|\|\s*undefined/)
    assert.match(source, /buildWebGroundingQuery\(text,\s*turns\)/)
  })

  it("replaces rather than appends the backend final safety scrub", () => {
    assert.match(
      source,
      /onReplace:\s*\(content\)\s*=>\s*\{[\s\S]*?assistantText\s*=\s*content[\s\S]*?content,[\s\S]*?\}/,
    )
  })

  it("keeps passthrough turns read-only even while the composer is in App mode", () => {
    assert.match(
      source,
      /`passthrough` has no explicit write intent[\s\S]{0,500}await sendPrompt\(text,\s*\{[\s\S]{0,160}autoApply:\s*false/,
    )
    assert.match(
      source,
      /!codeWriteRequest[\s\S]{0,160}isCodeInformationRequest\(text\)[\s\S]{0,160}isConversationalMessage\(text\)/,
    )
  })
})
