import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

describe("chat greeting / non-chat model source contract", () => {
  it("skips video/image/audio generators when the turn guard says chat", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/chat-interface-enhanced.tsx"),
      "utf8",
    )
    assert.match(source, /resolveChatTurnModel/)
    assert.match(source, /chatTurnGuard/)
    assert.match(source, /skipMediaGenerator/)
    assert.match(source, /reject_media/)
  })

  it("generate remaps greetings off non-chat models before the provider client", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "backend/src/routes/ai.js"),
      "utf8",
    )
    assert.match(source, /chat-model-guard/)
    assert.match(source, /resolveChatTurnModel/)
    assert.match(source, /GREETING_NOT_VIDEO_MESSAGE/)
  })
})
