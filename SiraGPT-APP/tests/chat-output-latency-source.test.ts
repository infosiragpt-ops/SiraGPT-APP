import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const aiServicePath = path.join(process.cwd(), "lib", "ai-service.ts")
const aiService = fs.readFileSync(aiServicePath, "utf8")

describe("chat output latency source contract", () => {
  it("uses one bounded semantic classifier before generation", () => {
    assert.match(
      aiService,
      /export const SEMANTIC_INTENT_BUDGET_MS = 650/,
      "semantic routing must have a sub-second deadline"
    )
    assert.doesNotMatch(
      aiService,
      /\/proxy\/chat\/completions/,
      "a second remote LLM classifier must not block first-token delivery"
    )
  })

  it("fails open to ordinary chat when semantic routing is unavailable", () => {
    assert.match(
      aiService,
      /const semanticIntent = await this\.classifyIntentViaSemanticRouter\([\s\S]*?if \(semanticIntent\)[\s\S]*?return 'text';/,
      "routing timeout must continue through the normal generation path"
    )
  })
})
