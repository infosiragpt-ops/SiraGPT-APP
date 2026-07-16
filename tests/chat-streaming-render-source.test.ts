import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

describe("chat streaming render source contract", () => {
  it("does not hide the latest user message while a chat is marked streaming", () => {
    assert.match(
      source,
      /const isAssistantMessage = \(message: any\): boolean =>\s*String\(message\?\.role \|\| ""\)\.toUpperCase\(\) === "ASSISTANT"/,
      "the render path needs an explicit assistant-role guard"
    )

    assert.match(
      source,
      /const lastMessage = messages\[messages\.length - 1\][\s\S]{0,180}const streamingCandidate = isStreaming && isAssistantMessage\(lastMessage\)[\s\S]{0,80}\? lastMessage\s*: null/,
      "only an assistant message may be removed from stable rendering as the streaming candidate"
    )

    assert.match(
      source,
      /streamingCandidate\s*\?\s*messages\.slice\(0, -1\)\.filter\(\(message\) => shouldRenderChatMessage\(message\)\)\s*:\s*messages\.filter\(\(message\) => shouldRenderChatMessage\(message\)\)/,
      "when the last message is a user message, the full message list must remain in stable rendering"
    )
  })
})
