import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)

function sliceBetween(startMarker: string, endMarker: string, from = 0): string {
  const start = source.indexOf(startMarker, from)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("chat turn terminal contract", () => {
  it("never shows the English monthly-limit copy nor treats a bare 429 as quota", () => {
    assert.doesNotMatch(source, /Monthly API limit exceeded/)
    assert.doesNotMatch(source, /Please upgrade/)
    assert.doesNotMatch(source, /status === 429/)
  })

  it("reaches triggerUpgradeModal only for kind === 'quota'", () => {
    assert.match(
      source,
      /const isPlanQuotaFailure = \(error: unknown\): boolean => describeGenerateFailure\(error\)\.kind === 'quota';/,
    )
    const calls = [...source.matchAll(/triggerUpgradeModal\(errorMessage, errorData\)/g)]
    assert.equal(calls.length, 4, "the four generate error sites")
    for (const call of calls) {
      const before = source.slice(Math.max(0, (call.index ?? 0) - 500), call.index)
      assert.match(
        before,
        /if \((?:failure\.kind === 'quota'|isPlanQuotaFailure\(error\))\) \{/,
        "the upgrade prompt must sit under a quota-only condition",
      )
    }
  })

  it("settles the placeholder on close, error and catch so Pensando cannot stick", () => {
    assert.match(source, /function finalizeAssistantPlaceholder\(msg: any, opts: \{ error\?: string \| null; markEmpty\?: boolean \} = \{\}\)/)
    assert.match(source, /reasoningStreaming: false, progressStage: undefined/)
    assert.match(source, /error: GENERATE_ERROR_COPY\.empty/)

    const onClose = sliceBetween("// onClose: Jab stream khatam ho jaye", "(error) => {\n              streamFailed = true")
    assert.match(onClose, /finishReasoning\(\)/)
    assert.match(onClose, /if \(!finalPartial && !recoveredOnClose && !isUserStopped\(\)\) \{\s*finalizePlaceholder\(\{ markEmpty: true \}\)/)

    const onError = sliceBetween("(error) => {\n              streamFailed = true", "            controller.signal,")
    assert.match(onError, /finishReasoning\(\)/)
    assert.match(onError, /finalizePlaceholder\(\{ error: chatErrorText\(error/)
    assert.match(onError, /finalizeAssistantPlaceholder\(msg, \{ error: quotaMessage \}\)/)

    const catchBlock = sliceBetween("} catch (error: any) {\n        streamFailed = true;", "      } finally {")
    assert.match(catchBlock, /finalizeAssistantPlaceholder\(msg, \{ error: failureText \}\)/)
    assert.match(catchBlock, /finalizeAssistantPlaceholder\(msg, \{ error: quotaMessage \}\)/)

    const finalizePlaceholder = sliceBetween("const finalizePlaceholder = (opts", "// STEP 3: Nayi streaming API call karein")
    assert.match(finalizePlaceholder, /finalizeAssistantPlaceholder\(msg, opts\)/)
  })

  it("gives the reasoning handlers a finish() that cancels the late flush", () => {
    const handlers = sliceBetween("function createReasoningHandlers(opts: {", "function createActivityHandlers(opts: {")
    assert.match(handlers, /finish: \(\) => \{/)
    assert.match(handlers, /if \(flushTimer\) \{ clearTimeout\(flushTimer\); flushTimer = null \}/)
    assert.match(handlers, /if \(isCancelled\(\) \|\| finished\) return/)
  })

  it("marks non-retryable failures terminal and keeps retryable ones automatic with a floor", () => {
    const onError = sliceBetween("(error) => {\n              streamFailed = true", "            controller.signal,")
    assert.match(onError, /if \(failure\.retryable && !\(error as any\)\?\.contentDelivered\) \{\s*scheduleTurnRetry\(activeChat\.id, turnIdempotencyKey, pendingOwnerId, \{\s*retryAfterMs: failure\.retryAfterMs,\s*minDelayMs: PENDING_REPLAY_MIN_DELAY_MS/)
    assert.match(onError, /\} else \{\s*markTurnTerminal\(activeChat\.id, turnIdempotencyKey, pendingOwnerId, failure\.kind\)/)
  })

  it("leases the turn before the generate call and releases it in finally", () => {
    const addMessage = sliceBetween("const addMessage = useCallback(", "  const retryPendingMessage = useCallback")
    const leaseIndex = addMessage.indexOf("markTurnInFlight(activeChat.id, turnIdempotencyKey, pendingOwnerId)")
    const enableIndex = addMessage.indexOf("enableAutomaticRetry(")
    const generateIndex = addMessage.indexOf("await apiClient.generateAIStream(")
    assert.ok(enableIndex >= 0 && leaseIndex > enableIndex, "lease right after enableAutomaticRetry")
    assert.ok(generateIndex > leaseIndex, "lease before the generate call")
    assert.match(addMessage, /refreshTurnLease\(activeChat\.id, turnIdempotencyKey, pendingOwnerId\);\s*\}, TURN_LEASE_REFRESH_MS\)/)
    // Hidden tabs throttle timers: stream activity refreshes the lease too.
    assert.match(addMessage, /\(chunk\) => \{\s*touchTurnLease\(\);/)
    assert.match(addMessage, /onActivity: \(text: string, event\?: ActivityEvent\) => \{\s*touchTurnLease\(\);/)

    const finallyBlock = sliceBetween("      } finally {\n        if (turnLeaseTimer)", "      return terminalSucceeded;")
    assert.match(finallyBlock, /clearInterval\(turnLeaseTimer\)/)
    assert.match(finallyBlock, /releaseTurnLease\(activeChat\.id, turnIdempotencyKey, pendingOwnerId\)/)
  })

  it("defers a pending replay leased by another tab or already in flight here", () => {
    const retry = sliceBetween(
      "const retryPendingMessage = useCallback(async (msg: PendingMessage): Promise<PendingRetryResult> => {",
      "  useEffect(() => {",
    )
    const leaseIndex = retry.indexOf("isTurnLeasedByAnotherTab(msg.chatId, pendingTurnKey, msg.ownerId)")
    const flightIndex = retry.indexOf("apiClient.isGenerateTurnInFlight(pendingTurnKey)")
    const addIndex = retry.indexOf("await addMessage(")
    assert.ok(leaseIndex >= 0 && flightIndex >= 0 && addIndex >= 0)
    assert.ok(leaseIndex < addIndex && flightIndex < addIndex, "both checks run before addMessage")
    assert.match(retry.slice(leaseIndex, leaseIndex + 120), /\) return 'defer'/)
    assert.match(retry.slice(flightIndex, flightIndex + 80), /\) return 'defer'/)
  })

  it("gives each failed turn ONE retry path (no second answer to the same prompt)", () => {
    // A new send supersedes the chat's older drafts (never answered after it).
    const addMessage = sliceBetween("const addMessage = useCallback(", "  const retryPendingMessage = useCallback")
    assert.match(addMessage, /if \(!options\?\.reusePending\) \{\s*supersedeOtherTurns\(activeChat\.id, turnIdempotencyKey, pendingOwnerId\);/)

    // «Reintentar» (regenerate) and edit drop the drafts of the turns they replace.
    const regenerate = sliceBetween("const regenerateMessageImpl = async", "// STEP 1: Delete messages from backend first")
    assert.match(regenerate, /clearTurnsForMessages\(\s*currentChat\.id,\s*\[originalUserMessage, \.\.\.messagesToDelete\],/)
    const edit = sliceBetween("const editAndRegenerate = useCallback(", "const updatedUserMessage = {")
    assert.match(edit, /clearTurnsForMessages\(\s*currentChat\.id,\s*currentChat\.messages\.slice\(messageIndex\),/)

    // A replay is skipped once the turn was answered elsewhere or superseded,
    // and re-checked after the await (a «Reintentar» may have raced it).
    const retry = sliceBetween(
      "const retryPendingMessage = useCallback(async (msg: PendingMessage): Promise<PendingRetryResult> => {",
      "  useEffect(() => {",
    )
    assert.match(retry, /const replayState = pendingTurnReplayState\(messages, msg\)\s*if \(replayState === 'answered'\) return 'success'/)
    assert.match(retry, /if \(replayState === 'superseded'\) \{\s*markTurnTerminal\(msg\.chatId, pendingTurnKey, msg\.ownerId, 'superseded'\)\s*return 'defer'/)
    const recheck = retry.indexOf("const storedTurn = getPendingTurn(msg.chatId, pendingTurnKey, msg.ownerId)")
    const add = retry.indexOf("await addMessage(")
    assert.ok(recheck > 0 && recheck < add, "stored draft re-checked right before the replay")
  })

  it("shows the client's classified copy verbatim instead of re-normalizing it", () => {
    assert.match(source, /if \(error && typeof error\.kind === 'string' && typeof error\.message === 'string' && error\.message\.trim\(\)\) \{\s*return error\.message\.trim\(\);/)
  })
})
