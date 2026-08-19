import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)

const start = source.indexOf("const addMessage = useCallback(")
const end = source.indexOf("  const retryPendingMessage = useCallback", start)
assert.ok(start >= 0 && end > start)
const addMessage = source.slice(start, end)

describe("chat cancellation before intent classification completes", () => {
  it("arms the controller before classification and fences every billable endpoint", () => {
    const controllerIndex = addMessage.indexOf("const controller = new AbortController()")
    const classifyIndex = addMessage.indexOf("await aiService.classifyIntent")
    const firstFenceIndex = addMessage.indexOf("throwIfTurnCancelled();", classifyIndex)

    assert.ok(controllerIndex >= 0 && controllerIndex < classifyIndex)
    assert.ok(firstFenceIndex > classifyIndex)
    assert.match(addMessage, /markChatStreaming\(activeChat\.id, streamId, controller\)/)
    assert.match(addMessage, /controller\.signal\.aborted[\s\S]*?cancelled\.name = 'AbortError'/)

    const endpoints = [
      "generateChart",
      "generateFigmaFlowchart",
      "generateArtifactStream",
      "generateDocStream",
      "generateVizStream",
      "solveMathStream",
      "generatePlanStream",
      "generateAIStream",
    ]
    for (const endpoint of endpoints) {
      assert.match(
        addMessage,
        new RegExp(`throwIfTurnCancelled\\(\\);[\\s\\S]{0,500}apiClient\\.${endpoint}\\(`),
        `${endpoint} must be fenced after a delayed classifier resolves`,
      )
    }

    assert.match(
      addMessage,
      /controller\.signal\.aborted \|\| error\?\.name === 'AbortError'[\s\S]{0,300}clearThisPendingTurn\(\)/,
    )
  })
})
