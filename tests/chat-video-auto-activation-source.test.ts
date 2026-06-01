import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

describe("chat video auto-activation source contract", () => {
  it("auto-enables the video tool from normal chat intent before send", () => {
    assert.match(
      source,
      /shouldAutoActivateVideoGeneration/,
      "normal chat composer must import/use the deterministic video intent helper"
    )
    assert.match(
      source,
      /setIsVideoGenerationActive\(true\)[\s\S]{0,240}setChatType\('video'\)/,
      "video intent typing should activate the same Video tool state used by the manual chip"
    )
    assert.match(
      source,
      /extractRequestedVideoDurationSeconds\(input\)/,
      "auto-activation should read explicit durations like '10 segundos' into video settings"
    )
  })

  it("keeps image attachment ids when a normal chat prompt routes to video", () => {
    assert.match(
      source,
      /case 'video':[\s\S]{0,180}handleVideoGeneration\(msg, collectUploadFileIds\(filesToSend\)\)/,
      "intent-routed video generation must preserve attached image file ids for image-to-video"
    )
  })

  it("does not turn the primary action into Voice Studio while Video mode is waiting for a prompt", () => {
    assert.match(
      source,
      /requiresPromptBeforePrimarySend[\s\S]{0,220}isVideoGenerationActive[\s\S]{0,220}chatType === 'video'/,
      "video mode must be recognized as a prompt-required primary-send state"
    )

    const needsPromptBlocks = source.match(/const needsPrompt = requiresPromptBeforePrimarySend && !hasText/g) || []
    assert.equal(
      needsPromptBlocks.length,
      2,
      "both initial and in-chat composers should derive a needsPrompt state"
    )

    const arrowAffordanceBlocks = source.match(/const Icon = canSend \|\| needsPrompt \? ArrowUp : AudioLines/g) || []
    assert.equal(
      arrowAffordanceBlocks.length,
      2,
      "both initial and in-chat composers should keep the arrow send affordance for empty Video mode instead of showing Voice Studio"
    )

    const disabledBlocks = source.match(/disabled=\{\(canSend && \(isCurrentChatLoading \|\| busy\)\) \|\| needsPrompt\}/g) || []
    assert.equal(disabledBlocks.length, 2, "empty prompt-driven video sends should be disabled in both composer variants")
  })
})
