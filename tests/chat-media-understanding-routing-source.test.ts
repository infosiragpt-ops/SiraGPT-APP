import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

function between(start: string, end: string, from = 0): string {
  const startIndex = source.indexOf(start, from)
  assert.ok(startIndex >= 0, `missing ${start}`)
  const endIndex = source.indexOf(end, startIndex)
  assert.ok(endIndex > startIndex, `missing ${end} after ${start}`)
  return source.slice(startIndex, endIndex)
}

describe("media-understanding routing (source contract)", () => {
  it("imports the pure helpers from composer-files", () => {
    const imports = between('import {\n  attachmentHasPreviewSource,', '} from "@/lib/chat/composer-files"')
    assert.match(imports, /\battachmentsBesideImagesAreMedia,/)
    assert.match(imports, /\bisMediaUnderstandingTurn,/)
    assert.match(imports, /\bresolveMediaFollowupFiles,/)
  })

  it("decides the media turn before any tool mode and before classifyIntent", () => {
    const send = between("const handleSend = async () => {", "const handleGmailCommand = async")
    const decided = send.indexOf("const mediaUnderstandingTurn = !codingWorkspace")
    assert.ok(decided > 0, "handleSend must compute mediaUnderstandingTurn")
    assert.match(
      send,
      /const mediaFollowupFiles = !codingWorkspace && composerFiles\.length === 0\s*\? resolveMediaFollowupFiles\(msg, currentChat\?\.messages \|\| \[\]\)/,
    )
    assert.match(send, /const mediaUnderstandingTurn = !codingWorkspace\s*&& \(mediaFollowupFiles\.length > 0 \|\| isMediaUnderstandingTurn\(msg, composerFiles\)\);/)

    const freePreview = send.indexOf("const activeFreePreviewTool = isFreePlan && !mediaUnderstandingTurn")
    const imagePreflight = send.indexOf("if ((isImageGenerationActive || chatType === 'image') && !mediaUnderstandingTurn) {")
    const videoSticky = send.indexOf("if ((isVideoGenerationActive || chatType === 'video') && !mediaUnderstandingTurn) {")
    const voice = send.indexOf("if (isVoiceGenerationActive && !mediaUnderstandingTurn) {")
    const music = send.indexOf("if (isMusicGenerationActive && !mediaUnderstandingTurn) {")
    const agentLoop = send.indexOf("|| mediaUnderstandingTurn")
    const earlyAgentTask = send.indexOf("await handleAgentTask(msg, filesToSend, { userMessageAlreadyAdded: false, idempotencyKey })", agentLoop)
    const classify = send.indexOf("await aiService.classifyIntent(")
    for (const [name, index] of Object.entries({ freePreview, imagePreflight, videoSticky, voice, music, agentLoop, earlyAgentTask, classify })) {
      assert.ok(index > 0, `missing ${name}`)
    }
    assert.ok(decided < freePreview && freePreview < imagePreflight, "the media decision gates the premium preview and image-model preflight")
    assert.ok(imagePreflight < videoSticky && videoSticky < voice && voice < music, "sticky Video/Voz/Música chips cannot claim a media turn")
    assert.ok(music < agentLoop && agentLoop < earlyAgentTask && earlyAgentTask < classify, "media turns reach handleAgentTask before classifyIntent")
    assert.match(send, /const shouldStartAgenticLoopImmediately = shouldUseWorkModeAgent\s*\|\| mediaUnderstandingTurn/)
  })

  it("sends recordings beside a video/image intent to the agent task instead of the image-only toast", () => {
    const send = between("const handleSend = async () => {", "const handleGmailCommand = async")
    const guard = between("if (intent === 'image' || intent === 'video') {", "const runContextPipeline = async", source.indexOf("await aiService.classifyIntent("))
    assert.ok(send.includes(guard))
    const handOff = guard.indexOf("if (attachmentsBesideImagesAreMedia(filesToSend)) {")
    const toast = guard.indexOf('toast.error("Solo se permiten archivos de imagen para esta tarea.");')
    assert.ok(handOff > 0 && toast > handOff, "the media hand-off must run before the image-only toast")
    assert.match(
      guard.slice(handOff, toast),
      /if \(await handleAgentTask\(msg, filesToSend, \{\s*userMessageAlreadyAdded: true,\s*assistantMessageId: assistantPlaceholder\.id,\s*idempotencyKey,\s*\}\)\) markQueuedSendSucceeded\(\);\s*return;/,
    )
  })

  it("never auto-flips Video or Voz for a recording or a draft about one", () => {
    assert.match(
      source,
      /const composerHasMediaAttachment = React\.useMemo\(\s*\(\) => uploadedFiles\.some\(\(file: any\) => isAudioComposerFile\(file\) \|\| isVideoComposerFile\(file\)\),/,
    )
    assert.match(
      source,
      /const draftIsMediaUnderstanding = React\.useMemo\(\(\) => \{[\s\S]{0,160}if \(uploadedFiles\.length > 0\) return isMediaUnderstandingTurn\(draft, uploadedFiles\);\s*return resolveMediaFollowupFiles\(draft, currentChat\?\.messages \|\| \[\]\)\.length > 0;/,
    )
    assert.match(
      source,
      /const wantsVideo = shouldAutoActivateVideoGeneration\(input\)\s*&& !composerHasMediaAttachment\s*&& !draftIsMediaUnderstanding;/,
    )
    const autoMode = between("const autoModeActivationRef = React.useRef", "React.useEffect(() => {\n    setActiveSearchActivityId(null);")
    const skip = autoMode.indexOf("if (draftIsMediaUnderstanding) return;")
    const decide = autoMode.indexOf("const decision = detectComposerAutoMode(draft, { attachments: uploadedFiles as any });")
    assert.ok(skip > 0 && decide > skip, "the auto mode skips media drafts before classifying")
  })

  it("keeps queued media turns for the opened chat's durable agent task", () => {
    const drain = between("const bgIndex = pendingMsgQueueRef.current.findIndex", "if (bgIndex < 0) return")
    assert.match(drain, /if \(isMediaUnderstandingTurn\(item\.msg, item\.files \|\| \[\]\)\) return false;/)
  })
})
