import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")
const apiSource = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")

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
      // Web search joined the inline set in 318c1f274 (keep web search
      // active after send) — the contract accepts media-only or media+web.
      /const isMediaToolActive = isImageGenerationActive \|\| isVoiceGenerationActive \|\| isMusicGenerationActive \|\| isVideoGenerationActive;[\s\S]{0,80}const shouldInlineActiveTools = isMediaToolActive( \|\| isWebSearchActive)?;/,
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
      /if \(isVoiceGenerationActive\) \{[\s\S]{0,420}await handleVoiceGeneration\(msg, filesToSend\)/,
      "Voice mode sends should bypass normal chat classification and call the deterministic speech artifact path"
    )
  })

  it("routes active Music mode to the deterministic music generation path", () => {
    assert.match(
      source,
      /if \(isMusicGenerationActive\) \{[\s\S]{0,420}await handleMusicGeneration\(msg, filesToSend\)/,
      "Music mode sends should bypass normal chat classification and call the deterministic music artifact path"
    )
    assert.doesNotMatch(
      source,
      /await handleAgentTask\(musicGoal/,
      "Music must NOT route through the unreliable agentic loop (the durable path lacks generate_music)"
    )
    assert.match(
      source,
      /await apiClient\.generateMusicMessage\(\{[\s\S]{0,200}chatId: activeChat\.id/,
      "handleMusicGeneration must call the deterministic /ai/generate-music endpoint"
    )
    assert.match(
      source,
      /toast\.success\(resp\?\.model \? `Música generada con \$\{resp\.model\}`/,
      "the success toast should surface which engine generated the track (ElevenLabs / Lyria) so an auto-fallback is visible"
    )
  })

  it("keeps Music mode visible and surviving chat creation while generation runs", () => {
    assert.match(
      source,
      /const \[isGeneratingMusic, setIsGeneratingMusic\] = React\.useState\(false\)/,
      "Music generation needs its own visible lifecycle state"
    )
    assert.match(
      source,
      /const isGeneratingMusicRef = React\.useRef\(false\)/,
      "Music generation should survive chat creation and selection effects"
    )
    assert.match(
      source,
      /isGeneratingMusicRef\.current = true;[\s\S]{0,140}setIsGeneratingMusic\(true\);[\s\S]{0,140}setIsMusicGenerationActive\(true\);[\s\S]{0,200}await handleMusicGeneration\(msg, filesToSend\)/,
      "Music sends should mark the chip as generating before the deterministic music task creates or selects a chat"
    )
    assert.match(
      source,
      /finally \{[\s\S]{0,140}isGeneratingMusicRef\.current = false;[\s\S]{0,140}setIsGeneratingMusic\(false\);[\s\S]{0,140}setIsMusicGenerationActive\(true\);/,
      "Music mode should remain selected after the music task settles"
    )
    assert.match(
      source,
      /isGeneratingMusicRef\.current[\s\S]{0,140}setIsMusicGenerationActive\(true\);[\s\S]{0,80}setChatType\('text'\);/,
      "Chat switching during music generation must preserve the visible Music tool"
    )
  })

  it("renders Music Style as a professional guided selector", () => {
    assert.match(
      source,
      /const MUSIC_STYLE_PROFILES: Record<MusicStyle,/,
      "Music style options should carry UI labels, descriptions and accents"
    )
    assert.match(
      source,
      /Estilos de producción[\s\S]{0,180}Selecciona una dirección sonora clara/,
      "The style submenu should explain what the selection controls"
    )
    assert.match(
      source,
      /MUSIC_STYLE_OPTIONS\.map\(option => \{[\s\S]{0,160}const profile = MUSIC_STYLE_PROFILES\[option\]/,
      "Style rows should render from the professional style profile metadata"
    )
    assert.match(
      source,
      /min-h-\[3\.65rem\]/,
      "Style options should be taller descriptive rows instead of a plain option list"
    )
    assert.match(
      source,
      /\{profile\.description\}<\/span>/,
      "Each style option should show its production description"
    )
    assert.match(
      source,
      /MUSIC_STYLE_PROFILES\[selectedMusicStyle\]\.description/,
      "The active Style row should show the selected style description"
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
      /isGeneratingVoiceRef\.current = true;[\s\S]{0,140}setIsGeneratingVoice\(true\);[\s\S]{0,140}setIsVoiceGenerationActive\(true\);[\s\S]{0,520}await handleVoiceGeneration\(msg, filesToSend\)/,
      "Voice sends should mark the chip as generating before the deterministic speech task creates or selects a chat"
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
    // With parallel chats the stop button became per-chat: voice now flows
    // through isCurrentChatMediaBusy (which must keep listing isGeneratingVoice)
    // into isStopButtonVisible/shouldPrioritizeStopButton. Same guarantee,
    // per-chat scoped.
    assert.match(
      source,
      /const isCurrentChatMediaBusy =[\s\S]{0,220}isGeneratingVoice/,
      "Voice generation must count as current-chat media busy"
    )
    assert.match(
      source,
      /const isStopButtonVisible =[\s\S]{0,260}isCurrentChatMediaBusy/,
      "Voice generation should force the stop button visible"
    )
    assert.match(
      source,
      /const shouldPrioritizeStopButton = isCurrentChatMediaBusy/,
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

  it("cancels Voice and Music transport instead of only clearing the spinner", () => {
    assert.match(source, /const voiceAbortControllerRef = React\.useRef<AbortController \| null>\(null\)/)
    assert.match(source, /const musicAbortControllerRef = React\.useRef<AbortController \| null>\(null\)/)
    assert.match(
      source,
      /voiceAbortControllerRef\.current = controller;[\s\S]{0,220}markLocalJobBusy\(activeChat\.id, controller\)/,
      "Voice generation must register its real request controller"
    )
    assert.match(
      source,
      /musicAbortControllerRef\.current = controller;[\s\S]{0,220}markLocalJobBusy\(activeChat\.id, controller\)/,
      "Music generation must register its real request controller"
    )
    assert.match(source, /generateSpeechMessage\(\{[\s\S]{0,300}\}, \{ signal: controller\.signal \}\)/)
    assert.match(source, /generateMusicMessage\(\{[\s\S]{0,420}\}, \{ signal: controller\.signal \}\)/)
    assert.match(source, /error: 'aborted'/)
    assert.match(apiSource, /generateSpeechMessage\([\s\S]{0,520}options: \{ signal\?: AbortSignal \}/)
    assert.match(apiSource, /generateMusicMessage\([\s\S]{0,520}options: \{ signal\?: AbortSignal \}/)
    assert.match(apiSource, /signal: options\.signal/)
  })
})
