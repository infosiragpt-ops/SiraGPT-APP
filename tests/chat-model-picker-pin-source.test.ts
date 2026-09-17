import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceAfter(marker: string): string {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing marker: ${marker}`)
  return source.slice(start)
}

describe("model picker pin menu source contract", () => {
  it("keeps a tiny ... control that does not select the row", () => {
    const row = sliceAfter("// ModelRow — single picker entry")
    const rowEnd = row.indexOf("// Default model selector for regular chats")
    assert.notEqual(rowEnd, -1, "ModelRow must sit above the default picker")
    const content = row.slice(0, rowEnd)

    assert.match(content, /model-picker-row-more/)
    assert.match(content, />\s*\.\.\.\s*</)
    assert.match(content, /Fijar modelo/)
    assert.match(content, /Quitar fijo/)
    assert.match(content, /Usar en este chat/)
    assert.match(
      content,
      /event\.preventDefault\(\);\s*event\.stopPropagation\(\)/,
      "the ... button must stopPropagation so it does not select the row",
    )
    assert.doesNotMatch(content, /DeepSeek|Ollama|HuggingFace|moondream/)
  })
})
