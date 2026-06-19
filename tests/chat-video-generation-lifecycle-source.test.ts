import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const chatContext = fs.readFileSync(path.join(root, "lib", "chat-context-integrated.tsx"), "utf8")
const chatComponent = fs.readFileSync(path.join(root, "components", "chat-interface-enhanced.tsx"), "utf8")
const apiClient = fs.readFileSync(path.join(root, "lib", "api.ts"), "utf8")
const aiRoute = fs.readFileSync(path.join(root, "backend", "src", "routes", "ai.js"), "utf8")
const videoRoute = fs.readFileSync(path.join(root, "backend", "src", "routes", "video.js"), "utf8")

describe("chat video generation lifecycle source contract", () => {
  it("keeps the composer busy until video polling reaches a terminal state", () => {
    assert.match(
      chatContext,
      /onOperationStarted\?: \(operationId: string\) => void/,
      "video options must expose operation-start lifecycle callback"
    )
    assert.match(
      chatContext,
      /onGenerationSettled\?: \(status: VideoGenerationTerminalStatus, payload\?: any\) => void/,
      "video options must expose terminal lifecycle callback"
    )
    assert.match(
      chatContext,
      /pollVideoStatus\(videoResponse\.operationId, messageId, activeChat\.id,[\s\S]{0,180}onSettled: options\?\.onGenerationSettled/,
      "addVideoMessage must wire polling completion back to the composer"
    )
    assert.match(
      chatComponent,
      /if \(!pollingStarted\) \{[\s\S]{0,80}settleLocalVideoState\(\);[\s\S]{0,40}\}/,
      "handleVideoGeneration must not clear local video state immediately after kickoff"
    )
  })

  it("lets the stop button cancel the active video operation", () => {
    assert.match(
      apiClient,
      /async cancelVideoGeneration\(operationId: string\)/,
      "api client must expose video operation cancellation"
    )
    assert.match(
      chatComponent,
      /currentVideoOperationIdRef\.current[\s\S]{0,220}apiClient\.cancelVideoGeneration\(videoOperationId\)/,
      "stopActiveGeneration must cancel the current video operation id"
    )
    assert.match(
      chatContext,
      /options\?\.signal\?\.addEventListener\('abort', onAbort, \{ once: true \}\)/,
      "video polling must stop when the composer AbortController is aborted"
    )
  })

  it("does not leave failed or cancelled videos stuck in processing", () => {
    assert.match(
      aiRoute,
      /router\.post\('\/video-cancel\/:operationId'/,
      "AI route must proxy cancellation for frontend callers"
    )
    assert.match(
      videoRoute,
      /router\.post\('\/cancel\/:operationId'/,
      "video route must mark active operations cancelled"
    )
    assert.match(
      aiRoute,
      /\['failed', 'cancelled'\]\.includes\(String\(statusResponse\.data\.status/,
      "status route must persist failed and cancelled terminal states"
    )
    assert.match(
      chatContext,
      /Date\.now\(\) - startedAt > pollTimeoutMs[\s\S]{0,260}cancelVideoGeneration\(operationId\)/,
      "polling must time out and cancel instead of rendering forever"
    )
  })
})
