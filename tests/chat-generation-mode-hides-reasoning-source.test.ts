import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

describe("generation modes hide text-reasoning controls", () => {
  it("defines the generation-mode gate as exactly the four gen modalities", () => {
    assert.match(
      chatInterface,
      /const isMediaToolActive = isImageGenerationActive \|\| isVoiceGenerationActive \|\| isMusicGenerationActive \|\| isVideoGenerationActive;/,
      "the gate must cover Imágenes, Voz, Música and Video — and nothing else",
    )
    assert.doesNotMatch(
      chatInterface,
      /const isMediaToolActive = [^;]*isWebSearchActive/,
      "web search answers with the text model, so its reasoning controls stay",
    )
  })

  it("hides the context meter while a generation modality is active", () => {
    assert.match(
      chatInterface,
      /\{!isMediaToolActive && \(\s*<ComposerContextMenu/,
      "the token/cost meter must not render during image/video/voice/music turns",
    )
  })

  it("hides the effort picker (slider + fast mode) while a generation modality is active", () => {
    assert.match(
      chatInterface,
      /\{!isMediaToolActive && \(\s*<ComposerEffortMenu/,
      "effort and fast mode take no reasoningEffort on generation turns",
    )
  })

  it("keeps both controls wired for normal text turns", () => {
    assert.match(
      chatInterface,
      /<ComposerContextMenu\s+messages=\{currentChat\?\.messages \|\| \[\]\}\s+selectedModel=\{currentChat\?\.model \|\| selectedModel\}\s+availableModels=\{availableModels\}/,
    )
    assert.match(
      chatInterface,
      /<ComposerEffortMenu\s+selectedEffort=\{selectedEffort\}\s+setSelectedEffort=\{setSelectedEffort\}/,
    )
  })
})
