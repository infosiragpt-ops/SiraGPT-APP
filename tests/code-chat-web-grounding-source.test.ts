import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

describe("CEO Office public-web transport", () => {
  it("keeps general agent tools disabled while opting into public grounding", () => {
    assert.match(source, /disableAgentic:\s*true/)
    assert.match(source, /enableWebGrounding:\s*webGroundedConversation/)
    assert.match(source, /webGroundingQuery:\s*webGroundedConversation\s*\?\s*text\s*:\s*undefined/)
  })

  it("replaces rather than appends the backend final safety scrub", () => {
    assert.match(
      source,
      /onReplace:\s*\(content\)\s*=>\s*\{[\s\S]*?assistantText\s*=\s*content[\s\S]*?content,[\s\S]*?\}/,
    )
  })
})
