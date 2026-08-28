import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatSource = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)
const composerSource = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

describe("agentes generate single-flight + video reject", () => {
  it("joins extra addMessage mounts on the same chat/turn", () => {
    assert.match(chatSource, /addMessageFlights\.run\(addFlightKey/)
    assert.match(chatSource, /VIDEO_TEXT_GENERATE_ERROR_ES/)
    assert.match(chatSource, /isVideoTextGenerateModel/)
  })

  it("rejects VIDEO catalog picks in the picker and composer before text generate", () => {
    assert.match(composerSource, /isVideoTextGenerateModel\(model\) && chatTypes !== "video"/)
    assert.match(composerSource, /isVideoTextGenerateModel\(selectedCatalog \|\| selectedModel\)/)
    assert.match(composerSource, /VIDEO_TEXT_GENERATE_ERROR_ES/)
  })
})
