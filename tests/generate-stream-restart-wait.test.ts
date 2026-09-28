import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { RESTART_MAX_WAIT_MS, RESTART_POLL_INTERVAL_MS } from "../lib/generate-retry-policy"

const apiSource = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")

function section(startMarker: string, endMarker: string): string {
  const start = apiSource.indexOf(startMarker)
  assert.ok(start >= 0, `missing ${startMarker}`)
  const end = apiSource.indexOf(endMarker, start)
  assert.ok(end > start, `missing ${endMarker}`)
  return apiSource.slice(start, end)
}

describe("generate client waits out a backend restart", () => {
  it("polls HEAD /api/health/ready (the backend, in both topologies) with a bounded budget", () => {
    assert.ok(RESTART_MAX_WAIT_MS <= 120_000, "restart wait is capped at 120 s")
    assert.ok(RESTART_POLL_INTERVAL_MS >= 1_000, "health is not polled in a tight loop")
    const wait = section("private async waitForBackendLive(", "private async streamGenerateTurn(")
    // Next's own /api/health/live reports the FRONTEND; its /health/ready
    // pings the backend, and the backend serves /api/health/ready itself.
    assert.match(wait, /`\$\{this\.baseURL\}\/health\/ready`/)
    assert.doesNotMatch(wait, /\/health\/live`/)
    assert.match(wait, /method: 'HEAD'/)
    assert.match(wait, /Math\.min\(RESTART_MAX_WAIT_MS, options\.maxWaitMs\)/)
    assert.match(wait, /delay = RESTART_POLL_INTERVAL_MS/)
  })

  it("honours Retry-After and the caller's Stop", () => {
    const wait = section("private async waitForBackendLive(", "private async streamGenerateTurn(")
    assert.match(wait, /options\.firstDelayMs/, "the first wait is the server's Retry-After")
    assert.match(wait, /if \(options\.signal\?\.aborted\) return 'aborted'/)
    assert.match(wait, /waitMs\(Math\.min\(delay, remaining\), options\.signal\)/)

    const generate = section("private async streamGenerateTurn(", "async generateImage(")
    assert.match(generate, /parseRetryAfterMs\(getResponseHeader\(response, 'retry-after'\), details\)/)
    assert.match(generate, /this\.waitForBackendLive\(\{ firstDelayMs, maxWaitMs: remaining, signal \}\)/)
    assert.match(generate, /\? Math\.max\(failure\.retryAfterMs \?\? 0, Math\.min\(15_000, RESTART_POLL_INTERVAL_MS \* 2 \*\* \(restartTries - 1\)\)\)\s*: failure\.retryAfterMs/)
    assert.match(generate, /if \(live === 'aborted' \|\| signal\?\.aborted\) return 'stop'/)
    assert.match(generate, /RESTART_MAX_WAIT_MS - \(now - restartingSince\)/)
  })

  it("spends no attempt on turn_in_progress / restarting and bounds both", () => {
    const generate = section("private async streamGenerateTurn(", "async generateImage(")
    assert.match(generate, /if \(now - turnInProgressSince >= TURN_IN_PROGRESS_MAX_WAIT_MS\) \{\s*turnInProgressExhausted = true;\s*return 'stop';/)
    // An explicit drain always waits for free; a code-less gateway status
    // only when the backend was really down and came back.
    assert.match(generate, /if \(live === 'ready' \|\| \(explicitRestart && live === 'first'\)\) return 'free';/)
    // One chat read per wait, never a burst.
    assert.match(generate, /options\.tryRecoverPersistedTurn\(\{ attempts: 1 \}\)/)
    assert.match(generate, /if \(await recoverPersistedTurn\(\)\) return 'recovered'/)
    assert.match(generate, /if \(next === 'free'\) \{ attempt--; continue; \}/)
    assert.match(generate, /if \(\+\+loopGuard > 400\) break;/)
    assert.match(generate, /rateLimitedRetries > MAX_RATE_LIMITED_RETRIES/)
  })

  it("uses the follower connect timeout once after a connect timeout, within a total budget", () => {
    const generate = section("private async streamGenerateTurn(", "async generateImage(")
    assert.match(generate, /connectTimedOutLastAttempt \? GENERATE_FOLLOWER_CONNECT_MS : GENERATE_STREAM_CONNECT_MS/)
    assert.match(generate, /connectTimedOutLastAttempt = false;/)
    assert.match(generate, /if \(error\?\.code === 'stream_connect_timeout'\) connectTimedOutLastAttempt = true;/)
    assert.match(generate, /GENERATE_TOTAL_CONNECT_BUDGET_MS - connectSpentMs/)
  })

  it("delivers a give-up after content, and an exhausted in-progress wait, as non-retryable", () => {
    const generate = section("async generateAIStream(", "async generateImage(")
    assert.match(generate, /if \(hasDeliveredAnyContent\) \{\s*decorated\.contentDelivered = true;\s*decorated\.retryable = false;/)
    assert.match(generate, /if \(turnInProgressExhausted && decorated\.kind === 'turn_in_progress'\) \{\s*decorated\.retryable = false;/)
  })

  it("classifies an SSE error frame with its own status (402 quota / 413 overflow)", () => {
    const generate = section("async generateAIStream(", "async generateImage(")
    assert.match(generate, /const frameStatus = Number\(jsonData\.status\);/)
    assert.match(generate, /status: Number\.isFinite\(frameStatus\) && frameStatus > 0 \? frameStatus : null,/)
  })

  it("never builds a user message ending in a raw «HTTP nnn»", () => {
    const generate = section("async generateAIStream(", "async generateImage(")
    assert.doesNotMatch(generate, /`HTTP \$\{[^}]+\}`/)
    assert.doesNotMatch(generate, /new Error\([^)]*HTTP \d{3}/)
    assert.doesNotMatch(generate, /computeBackoff/)
    assert.doesNotMatch(generate, /\/429\|too many\|rate\/i/)
    assert.match(generate, /deliverStreamError\(withGenerateFailure\(lastError\)\)/)
  })
})
