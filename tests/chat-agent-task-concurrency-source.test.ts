import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const componentSource = readFileSync(
  join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

const stopHandler = sliceBetween(
  componentSource,
  "const stopActiveGeneration = React.useCallback(() => {",
  "// Add reasoning steps to chat messages as they come in",
)

const queueDrain = sliceBetween(
  componentSource,
  "// Drain queued messages when a chat's pipeline goes idle.",
  "// Prevent Enter key from adding new line when not holding Shift",
)

describe("chat agent-task concurrency contract", () => {
  it("stops only the task and controller owned by the visible chat", () => {
    assert.match(stopHandler, /const taskId = targetChatId \? scopedTaskId : fallbackTaskId/)
    assert.doesNotMatch(stopHandler, /const taskId = scopedTaskId \|\| fallbackTaskId/)
    assert.match(stopHandler, /if \(scopedTaskId && targetChatId && scopedController\)/)
    assert.match(stopHandler, /else if \(!targetChatId && searchAbortControllerRef\.current\)/)
    assert.match(stopHandler, /imageController === scopedController/)
    assert.match(stopHandler, /voiceController === scopedController/)
    assert.match(stopHandler, /musicController === scopedController/)
    assert.match(stopHandler, /videoController === scopedController/)
    assert.match(stopHandler, /activeStreamingChatIds\.includes\(targetChatId\)/)
  })

  it("does not drain a queued message into a chat with an active local job", () => {
    assert.match(
      queueDrain,
      /if \(activeStreamingChatIds\.includes\(item\.chatId\)\) return false;\s+if \(activeLocalJobChatIdsRef\.current\.has\(item\.chatId\)\) return false;/,
    )
    assert.match(queueDrain, /activeStreamingChatIds,\s+activeLocalJobChatIds,/)
  })
})
