import assert from "node:assert/strict"
import test from "node:test"

import {
  MISSING_STATUS_RETRY_LIMIT,
  STATUS_POLL_UNAVAILABLE,
  buildFileProcessingStatusUrl,
  decideProcessingStatusPoll,
  resolveProcessingPollGiveUp,
} from "../lib/file-processing-status-client"

test("buildFileProcessingStatusUrl uses the normalized API root and encodes the id", () => {
  assert.equal(
    buildFileProcessingStatusUrl("abc 1", "https://api.siragpt.com/api"),
    "https://api.siragpt.com/api/files/abc%201/processing-status",
  )
  assert.equal(
    buildFileProcessingStatusUrl("file-1", "https://api.siragpt.com/api/"),
    "https://api.siragpt.com/api/files/file-1/processing-status",
  )
})

test("decideProcessingStatusPoll retries transient failures and stops on auth/gone", () => {
  assert.equal(decideProcessingStatusPoll(200, 1), "apply")
  assert.equal(decideProcessingStatusPoll(401, 1), "stop")
  assert.equal(decideProcessingStatusPoll(403, 2), "stop")
  assert.equal(decideProcessingStatusPoll(410, 1), "stop")
  assert.equal(decideProcessingStatusPoll(500, 1), "retry")
  assert.equal(decideProcessingStatusPoll(502, 4), "retry")
  assert.equal(decideProcessingStatusPoll(429, 2), "retry")
  assert.equal(decideProcessingStatusPoll(404, 1), "retry")
  assert.equal(decideProcessingStatusPoll(404, MISSING_STATUS_RETRY_LIMIT), "retry")
  assert.equal(decideProcessingStatusPoll(404, MISSING_STATUS_RETRY_LIMIT + 1), "stop")
})

test("resolveProcessingPollGiveUp never leaves a null stage spinning", () => {
  assert.deepEqual(resolveProcessingPollGiveUp(null), {
    stage: "failed",
    error: STATUS_POLL_UNAVAILABLE,
  })
  assert.deepEqual(resolveProcessingPollGiveUp(undefined), {
    stage: "failed",
    error: STATUS_POLL_UNAVAILABLE,
  })
  assert.deepEqual(resolveProcessingPollGiveUp("extracting"), {
    stage: "ready",
    error: null,
  })
  assert.deepEqual(resolveProcessingPollGiveUp("indexing"), {
    stage: "ready",
    error: null,
  })
  assert.deepEqual(resolveProcessingPollGiveUp("ready"), {
    stage: "ready",
    error: null,
  })
  assert.deepEqual(resolveProcessingPollGiveUp("failed"), {
    stage: "failed",
    error: null,
  })
})
