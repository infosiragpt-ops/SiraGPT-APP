import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

describe("Codex project creation from /code", () => {
  it("forwards the original build prompt as the project brief", () => {
    const start = source.indexOf("const runCodexEngine = React.useCallback(")
    const end = source.indexOf("const dispatch = React.useCallback(", start)

    assert.notEqual(start, -1, "runCodexEngine must exist")
    assert.notEqual(end, -1, "dispatch must follow runCodexEngine")
    assert.match(
      source.slice(start, end),
      /codexApi\.createProject\(title, text\)/,
      "the first /code turn must not drop the brief used to choose the project starter",
    )
  })
})
