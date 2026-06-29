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
    assert.match(
      source,
      /extractRequestedVideoAspectRatio\(input\)/,
      "auto-activation should read explicit shapes like 'cuadrado' or 'vertical' into video settings"
    )
    assert.match(
      source,
      /extractRequestedVideoResolution\(input\)/,
      "auto-activation should read explicit resolutions like '480p' or '720p' into video settings"
    )
    assert.match(
      source,
      /extractRequestedVideoAudio\(input\)/,
      "auto-activation should read 'sin audio' and 'con audio' into video settings"
    )
    assert.match(
      source,
      /setSelectedVideoAspectRatio\(requestedAspectRatio as VideoAspectRatio\)/,
      "prompt-stated video aspect ratios must update the visible marker"
    )
  })

  it("keeps image attachment ids when a normal chat prompt routes to video", () => {
    assert.match(
      source,
      /case 'video':[\s\S]{0,220}handleVideoGeneration\(msg, collectUploadFileIds\(filesToSend\), filesToSend\)/,
      "intent-routed video generation must preserve attached image file ids for image-to-video"
    )
    assert.match(
      source,
      /isVideoGenerationActive \|\| chatType === 'video'[\s\S]{0,220}handleVideoGeneration\(msg, collectUploadFileIds\(filesToSend\), filesToSend\)/,
      "explicit video mode sends must preserve original attachment objects for image-to-video context"
    )
    assert.match(
      source,
      /shouldUseLatestImageForVideo\(prompt\)[\s\S]{0,180}collectLatestGeneratedImageUrls\(currentChat\?\.messages \|\| \[\]\)/,
      "image-to-video follow-ups must reuse the latest generated image when no new image is attached"
    )
    assert.match(
      source,
      /sourceImageFiles: sourceFiles,/,
      "original uploaded image objects must be passed into the video request options before composer cleanup"
    )
  })

  it("does not force a hardcoded Veo model when video auto-activates", () => {
    assert.doesNotMatch(
      source,
      /const DEFAULT_VIDEO_MODEL = "veo-fast"/,
      "video generation must not default to veo-fast when Admin has no active VIDEO row"
    )
    assert.doesNotMatch(
      source,
      /setSelectedVideoModel\(DEFAULT_VIDEO_MODEL\)[\s\S]{0,160}autoVideoActivationRef\.current = true/,
      "auto-activation should not override the selected video model with a hardcoded default"
    )
    assert.match(
      source,
      /const activeVideoModel = selectedVideoModel\.trim\(\)[\s\S]{0,220}Activa un modelo VIDEO en Admin > AI Models/,
      "video generation should block locally when no Admin-active VIDEO model is selected"
    )
  })

  it("keeps auto-enabled video active until the user closes it or starts a new chat", () => {
    assert.doesNotMatch(
      source,
      /hasReplacementPrompt && isVideoGenerationActive && chatType === 'video'/,
      "typing a non-video follow-up must not auto-disable the sticky video tool"
    )
    assert.match(
      source,
      /autoVideoActivationRef\.current = false;[\s\S]{0,120}resetAllToolsAndConnectors\(\)/,
      "Nuevo chat reset must clear the sticky video activation state"
    )
    assert.match(
      source,
      /handleVideoGenerationClose[\s\S]{0,160}setIsVideoGenerationActive\(false\)/,
      "the explicit X on the video chip remains the manual way to close video mode"
    )
  })

  it("renders media controls inline next to the plus button instead of the bottom tool row", () => {
    assert.match(
      source,
      /const isMediaToolActive = isImageGenerationActive \|\| isVoiceGenerationActive \|\| isMusicGenerationActive \|\| isVideoGenerationActive;[\s\S]{0,80}const shouldInlineActiveTools = isMediaToolActive;/,
      "active media modes should opt into inline composer controls"
    )
    assert.match(
      source,
      /composer-inline-active-tools[\s\S]{0,120}<ActiveToolsDisplay \{\.\.\.activeToolsProps\} \/>/,
      "media controls should render next to the plus/action button"
    )
    assert.match(
      source,
      /hasActiveTools && !shouldInlineActiveTools/,
      "the lower active-tools row should be suppressed while media controls are inline"
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

    const disabledBlocks = source.match(/disabled=\{\(canSend && busy\) \|\| needsPrompt\}/g) || []
    assert.equal(disabledBlocks.length, 2, "empty prompt-driven video sends should be disabled in both composer variants")
  })

  it("routes active Voice mode to speech generation instead of normal chat", () => {
    assert.match(
      source,
      /const VOICE_COMPOSER_PLACEHOLDER = "Escribe el texto que quieres convertir en voz"/,
      "Voice mode should ask for narration text, not an unsupported voice-design prompt"
    )
    assert.doesNotMatch(
      source,
      /Describe la voz que quieres crear/,
      "Voice mode should not promise voice-design when the working backend path is text-to-speech"
    )
    assert.match(
      source,
      /const requiresPromptBeforePrimarySend =[\s\S]{0,160}isVoiceGenerationActive/,
      "Voice mode should keep the primary button as a disabled send affordance until text is provided"
    )
    assert.match(
      source,
      /if \(isVoiceGenerationActive\) \{[\s\S]{0,420}const voiceGoal = buildVoiceGenerationGoal[\s\S]{0,420}await handleAgentTask\(voiceGoal, filesToSend, \{[\s\S]{0,160}displayGoal: msg/,
      "Voice mode sends should bypass normal chat classification and call the speech artifact path"
    )
  })

  it("routes active Music mode to music generation and keeps the tool active", () => {
    assert.match(
      source,
      /const buildMusicGenerationGoal = \(\{[\s\S]{0,700}generate_music/,
      "Music goal builder must force the generate_music tool"
    )
    assert.match(
      source,
      /if \(isMusicGenerationActive\) \{[\s\S]{0,500}const musicGoal = buildMusicGenerationGoal[\s\S]{0,500}await handleAgentTask\(musicGoal, filesToSend, \{[\s\S]{0,200}displayGoal: msg/,
      "Music mode sends should bypass normal chat classification and call the music artifact path"
    )
    assert.match(
      source,
      /if \(isMusicGenerationActive\) \{[\s\S]{0,900}finally \{[\s\S]{0,160}setIsMusicGenerationActive\(true\);/,
      "Music mode should remain selected after the music task settles"
    )
  })

  it("keeps Voice mode visible and cancellable while speech generation is running", () => {
    assert.match(
      source,
      /const \[isGeneratingVoice, setIsGeneratingVoice\] = React\.useState\(false\)/,
      "Voice generation needs its own visible lifecycle state"
    )
    assert.match(
      source,
      /const isGeneratingVoiceRef = React\.useRef\(false\)/,
      "Voice generation should survive chat creation and selection effects"
    )
    assert.match(
      source,
      /isGeneratingVoiceRef\.current = true;[\s\S]{0,140}setIsGeneratingVoice\(true\);[\s\S]{0,140}setIsVoiceGenerationActive\(true\);[\s\S]{0,520}await handleAgentTask\(voiceGoal, filesToSend, \{/,
      "Voice sends should mark the chip as generating before the agent task creates or selects a chat"
    )
    assert.match(
      source,
      /finally \{[\s\S]{0,140}isGeneratingVoiceRef\.current = false;[\s\S]{0,140}setIsGeneratingVoice\(false\);[\s\S]{0,140}setIsVoiceGenerationActive\(true\);/,
      "Voice mode should remain selected after the audio task settles"
    )
    assert.match(
      source,
      /isGeneratingVoiceRef\.current[\s\S]{0,140}setIsVoiceGenerationActive\(true\);[\s\S]{0,80}setChatType\('text'\);/,
      "Chat switching during voice generation must preserve the visible Voice tool"
    )
    assert.match(
      source,
      /if \(isGeneratingVoice\) return;[\s\S]{0,120}setIsVoiceGenerationActive\(false\);/,
      "The Voice chip close button must not deactivate the tool mid-generation"
    )
    assert.match(
      source,
      /const isStopButtonVisible =[\s\S]{0,220}isGeneratingVoice/,
      "Voice generation should force the stop button visible"
    )
    assert.match(
      source,
      /const shouldPrioritizeStopButton = isGeneratingVoice \|\| isGeneratingImage \|\| isGeneratingVideo \|\| isGeneratingPPT/,
      "Voice generation should prioritize cancel over queue-send"
    )
    assert.match(
      source,
      /isStopButtonVisible && input\.trim\(\)\.length > 0 && !shouldPrioritizeStopButton/,
      "Queue send should be suppressed while Voice generation needs the stop button"
    )
    assert.match(
      source,
      /isStopButtonVisible && \(input\.trim\(\)\.length === 0 \|\| shouldPrioritizeStopButton\)/,
      "The stop button should remain available even if the composer has text during Voice generation"
    )
  })
})
