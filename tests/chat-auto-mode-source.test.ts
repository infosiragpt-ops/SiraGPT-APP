import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)
const modelsRoute = fs.readFileSync(
  path.join(process.cwd(), "backend", "src", "routes", "ai.js"),
  "utf8",
)

describe("composer auto mode wiring (source contract)", () => {
  it("runs the deterministic classifier on every draft and flips the matching chip", () => {
    assert.match(chatInterface, /import \{ detectComposerAutoMode, type ComposerAutoMode \} from "@\/lib\/chat\/composer-auto-mode"/)
    assert.match(chatInterface, /const decision = detectComposerAutoMode\(draft, \{ attachments: uploadedFiles as any \}\)/)
    assert.match(
      chatInterface,
      /if \(shouldAutoActivateVideoGeneration\(draft\)\) return; \/\/ owned by the video effect/,
      "video keeps its own contract-pinned effect",
    )
    assert.match(chatInterface, /if \(decision\.mode === 'image'\) \{[\s\S]{0,400}setIsImageGenerationActive\(true\);[\s\S]{0,80}setChatType\('image'\);/)
    assert.match(chatInterface, /setSelectedImageAspectRatio\(imageAspectRatio as ImageAspectRatio\)/)
    assert.match(chatInterface, /setSelectedImageCount\(imageCount as ImageGenerationCount\)/)
    assert.match(chatInterface, /setSelectedImageQuality\(imageQuality as ImageQuality\)/)
    assert.match(chatInterface, /if \(decision\.mode === 'music'\) \{[\s\S]{0,200}setIsMusicGenerationActive\(true\);/)
    assert.match(chatInterface, /if \(decision\.mode === 'voice'\) \{[\s\S]{0,200}setIsVoiceGenerationActive\(true\);/)
    assert.match(chatInterface, /if \(decision\.mode === 'web_search'\) \{[\s\S]{0,120}setIsWebSearchActive\(true\);/)
  })

  it("never overrides a tool the user already chose and flips once per draft", () => {
    assert.match(chatInterface, /const autoModeActivationRef = React\.useRef<\{ mode: ComposerAutoMode; input: string \} \| null>\(null\);/)
    assert.match(chatInterface, /const alreadyFlipped = autoModeActivationRef\.current\?\.input === draft;/)
    assert.match(chatInterface, /if \(anyToolActive \|\| alreadyFlipped\) return;/)
  })

  it("creates new Word/PPT/Excel files through the in-process pipeline when nothing is attached", () => {
    assert.match(
      chatInterface,
      /case 'ppt':[\s\S]{0,700}if \(filesToSend\.length === 0\) \{\s*await runContextPipeline\(intent\);\s*\} else \{\s*await runClassifiedAgentTask\(\);\s*\}\s*break;/,
    )
    assert.match(
      chatInterface,
      /case 'doc':\s*if \(filesToSend\.length === 0\) \{\s*await runContextPipeline\(intent\);\s*\} else \{\s*await runClassifiedAgentTask\(\);\s*\}\s*break;/,
    )
  })

  it("lets the Voz chip list the Admin-active TTS (AUDIO) rows", () => {
    assert.match(chatInterface, /\(model\?\.type === 'VOICE' \|\| model\?\.type === 'AUDIO'\) && model\?\.isActive === true/)
    assert.match(modelsRoute, /const wantAudio = !type \|\| type === 'AUDIO' \|\| type === 'VOICE';/)
  })
})
