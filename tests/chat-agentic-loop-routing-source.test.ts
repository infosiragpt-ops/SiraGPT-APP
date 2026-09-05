import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")
const agenticStepsPath = path.join(process.cwd(), "components", "agentic-steps.tsx")
const agenticStepsSource = fs.readFileSync(agenticStepsPath, "utf8")
const artifactChromePath = path.join(process.cwd(), "components", "doc", "document-artifact-chrome.tsx")
const artifactChromeSource = fs.readFileSync(artifactChromePath, "utf8")
const thinkingLoaderPath = path.join(process.cwd(), "components", "thinking-status-loader.tsx")
const thinkingLoaderSource = fs.readFileSync(thinkingLoaderPath, "utf8")
const thinkingKitPath = path.join(process.cwd(), "lib", "thinking-loaders.ts")
const thinkingKitSource = fs.readFileSync(thinkingKitPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string, haystack = source): string {
  const start = haystack.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = haystack.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return haystack.slice(start, end)
}

describe("chat agentic loop routing source contract", () => {
  it("routes deterministic research/search prompts into the visible agent loop before normal chat placeholders", () => {
    assert.match(
      source,
      /import \{[^}]*classifyIntentFastPath[^}]*\} from "@\/lib\/ai-service"/,
      "the composer must use the shared deterministic intent helper instead of a local keyword fork",
    )

    // End marker: the global sendInFlightRef lock became the per-chat latch
    // (sendInFlightChatsRef) when parallel chats landed (6af6361b7); the
    // deterministic branch still sits right before it.
    const deterministicBranch = sliceBetween(
      "const deterministicAgenticIntent = classifyIntentFastPath(msg);",
      "if (sendInFlightChatsRef.current.has(sendLatchKey)) return;",
    )

    assert.match(
      deterministicBranch,
      /\['web_search', 'agent_task', 'math', 'viz', 'chart', 'ppt'\]\.includes\(deterministicAgenticIntent\)/,
      "research/search and durable tool intents should short-circuit into the agent task surface",
    )
    assert.match(
      deterministicBranch,
      /await handleAgentTask\(msg, filesToSend, \{ userMessageAlreadyAdded: false \}\);/,
      "the deterministic fast path must start the agent loop directly, before the normal text stream placeholder",
    )
  })

  it("reuses existing optimistic messages when async classification chooses the agent route", () => {
    const helper = sliceBetween(
      "const runClassifiedAgentTask = () => handleAgentTask(msg, filesToSend, {",
      "switch (intent)",
    )
    assert.match(helper, /userMessageAlreadyAdded: true/)
    assert.match(helper, /assistantMessageId: assistantPlaceholder\.id/)
    const handler = sliceBetween(
      "const handleAgentTask = async (",
      "function FeatureRow(",
    )
    assert.match(
      handler,
      /!userMessageAlreadyAdded \|\| !liveHasUserTurn/,
      "createChat/selectChat must still graft a USER row with files when the live list has none",
    )
    assert.match(handler, /snapshotComposerFilesForMessage\(filesToSend\)/)
    assert.match(
      source,
      /const updatedMessages = \[\.\.\.\(prevChat\.messages \|\| \[\]\), userMessage, assistantPlaceholder\]/,
      "existing chats must seed the assistant bubble so RunTrace never mounts on the user message",
    )

    const switchBlock = sliceBetween("switch (intent) {", "    } catch (err: any) {")
    for (const marker of ["case 'ppt':", "case 'web_search':", "case 'agent_task':"]) {
      const caseStart = switchBlock.indexOf(marker)
      assert.notEqual(caseStart, -1, `missing ${marker}`)
      const caseSlice = switchBlock.slice(caseStart, switchBlock.indexOf("break;", caseStart))
      assert.match(caseSlice, /await runClassifiedAgentTask\(\);/)
      assert.doesNotMatch(caseSlice, /await handleAgentTask\(msg, filesToSend\);/)
    }
  })

  it("seeds the agent bubble with a visible planning step before backend events arrive", () => {
    const handler = sliceBetween(
      "const clientBootstrapStepId = 'client-agent-bootstrap';",
      "for await (const evt of agentTaskService.runIterator({",
    )

    assert.match(handler, /label: 'Analizando solicitud'/)
    assert.match(handler, /reasoning: 'Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea\.'/)
    assert.match(handler, /status: 'running'/)
    assert.match(handler, /const initialTaskState = makeInitialTaskState\(\);/)
    assert.match(handler, /let state: AgentTaskState = makeInitialTaskState\(\);/)

    const eventLoop = sliceBetween(
      "for await (const evt of agentTaskService.runIterator({",
      "        // Stream closed cleanly",
    )
    assert.match(eventLoop, /eventType === 'step_start'/)
    assert.match(eventLoop, /state = settleClientBootstrapStep\(state\);/)
  })

  it("renders the agent loop as a minimal professional activity card", () => {
    const liveBlock = sliceBetween(
      "if (isLiveActivity) {",
      "        {liveExpanded && (",
      agenticStepsSource,
    )
    // The live-activity header comment evolved ("Minimal live activity" →
    // "Claude-style live activity"); anchor on the stable phrase.
    assert.match(liveBlock, /live activity/)
    assert.match(agenticStepsSource, /aria-label="Agente trabajando"/)
    // Visible status is the LOADERS CELESTE chip, not the old "Trabajando" copy.
    assert.match(agenticStepsSource, /import \{ ThinkingStatusLoader \} from "@\/components\/thinking-status-loader"/)
    assert.match(agenticStepsSource, /import \{ loaderLabel, mapEventToLoaderState, type LoaderState \} from "@\/lib\/thinking-loaders"/)
    assert.match(liveBlock, /<ThinkingStatusLoader/)
    assert.match(liveBlock, /mapEventToLoaderState\(\{ label: headerLabel, tool: runningTimelineStep\?\.tool \}\)/)
    assert.doesNotMatch(liveBlock, /label=\{headerLabel\}/)
    assert.doesNotMatch(liveBlock, /Trabajando/)
    assert.match(thinkingLoaderSource, /thinking-shimmer-text/)
    assert.match(thinkingLoaderSource, /loaderChipSrc\(state\)/)
    assert.match(thinkingLoaderSource, /<PensandoBars /)
    assert.match(thinkingKitSource, /pensando: "Pensando…"/)
    assert.match(thinkingKitSource, /"buscando-internet": "Buscando en internet…"/)
    assert.match(thinkingKitSource, /completado: "¡Listo!"/)
    assert.match(agenticStepsSource, /ThinkingIndicator/)
    // Both generated and edited documents now share the same card chrome.
    // Check the real import and consumption as well as the extracted style;
    // checking only the helper would miss a disconnected card implementation.
    assert.match(agenticStepsSource, /import \{[^}]*DOCUMENT_CARD_CLASS[^}]*\} from "@\/components\/doc\/document-artifact-chrome"/)
    assert.match(agenticStepsSource, /className=\{cn\(DOCUMENT_CARD_CLASS,/)
    assert.match(artifactChromeSource, /export const DOCUMENT_CARD_CLASS = "[^"\n]*rounded-2xl border border-border\//)
  })

  it("keeps reloaded empty agent states visible instead of collapsing to a plain spinner", () => {
    const projection = sliceBetween(
      "function projectTimelineSteps",
      "const projected",
      agenticStepsSource,
    )
    assert.match(projection, /label: "Analizando solicitud"/)
    assert.match(projection, /reasoning: "Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea\."/)
  })

  it("renders generated speech artifacts as playable downloadable audio cards", () => {
    const audioArtifactSource = sliceBetween(
      "function AudioArtifactPlayer",
      "function ArtifactDeliveryList",
      agenticStepsSource,
    )
    assert.match(agenticStepsSource, /function isAudioArtifact\(artifact: AgentArtifact\)/)
    assert.match(agenticStepsSource, /mime\.startsWith\("audio\/"\)/)
    assert.match(agenticStepsSource, /function AudioArtifactPlayer/)
    assert.match(agenticStepsSource, /const audioRef = React\.useRef<HTMLAudioElement \| null>\(null\)/)
    assert.match(agenticStepsSource, /const generationLabel = `Generation \$\{generationIndex \+ 1\}`/)
    assert.match(agenticStepsSource, /<audio[\s\S]{0,160}ref=\{audioRef\}[\s\S]{0,160}src=\{audioSrc \|\| undefined\}/)
    assert.match(agenticStepsSource, /const objectUrl = window\.URL\.createObjectURL\(blob\)/)
    assert.match(
      agenticStepsSource,
      /function fetchArtifact\(href: string\)[\s\S]{0,220}isTrustedSiraApiUrl\(href, BACKEND_ROOT\)[\s\S]{0,120}authenticatedArtifactFetch\(href\)/,
      "trusted artifact requests must use the shared authenticated transport",
    )
    assert.equal(
      audioArtifactSource.match(/const response = await fetchArtifact\(href\)/g)?.length,
      2,
      "audio playback and download must both fetch through the trusted-origin transport",
    )
    assert.match(audioArtifactSource, /downloadBlob\(await response\.blob\(\), filename\)/)
    assert.match(
      agenticStepsSource,
      /if \(isAudioArtifact\(artifact\)\) \{[\s\S]{0,180}<AudioArtifactPlayer/,
      "audio artifacts should bypass the generic document card",
    )
  })
})
