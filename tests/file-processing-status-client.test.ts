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

// --- ProcessingStatusMemo (shared poll memo, 2026-10-08) -------------------------

import { ProcessingStatusMemo } from "@/lib/file-processing-status-client"

test("ProcessingStatusMemo: terminal answers expire after ttl and the newest entries survive the cap", () => {
  let now = 1_000
  const memo = new ProcessingStatusMemo<string, string>({ ttlMs: 100, max: 2, now: () => now })
  memo.rememberTerminal("a", "ready-a")
  memo.rememberTerminal("b", "ready-b")
  assert.equal(memo.terminal("a"), "ready-a")
  memo.rememberTerminal("c", "ready-c")
  assert.equal(memo.terminal("a"), null, "oldest entry evicted at the cap")
  assert.equal(memo.terminal("b"), "ready-b")
  assert.equal(memo.terminal("c"), "ready-c")
  now += 101
  assert.equal(memo.terminal("b"), null, "expired")
  assert.equal(memo.terminal("missing"), null)
})

test("ProcessingStatusMemo: concurrent callers share one in-flight run, later callers start a new one", async () => {
  const memo = new ProcessingStatusMemo<string, number>()
  let runs = 0
  let release: (value: number) => void = () => {}
  const run = () => { runs += 1; return new Promise<number>((resolve) => { release = resolve }) }
  const first = memo.shared("f", run)
  const second = memo.shared("f", run)
  assert.equal(runs, 1)
  assert.equal(memo.inflightCount(), 1)
  release(7)
  assert.deepEqual(await Promise.all([first, second]), [7, 7])
  assert.equal(memo.inflightCount(), 0)
  const third = memo.shared("f", run)
  assert.equal(runs, 2)
  release(8)
  assert.equal(await third, 8)
  // A rejected run is not cached either.
  await assert.rejects(memo.shared("g", () => Promise.reject(new Error("boom"))), /boom/)
  assert.equal(memo.inflightCount(), 0)
})
