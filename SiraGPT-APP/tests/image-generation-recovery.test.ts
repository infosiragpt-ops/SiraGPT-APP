import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldRecoverImageGenerationViaPolling } from "../lib/image-generation-recovery"

describe("shouldRecoverImageGenerationViaPolling", () => {
  const startedAtMs = 1_000_000

  it("recovers status-less network cuts even when the browser attaches ECONNRESET", () => {
    const err: any = new TypeError("fetch failed: socket hang up")
    err.code = "ECONNRESET"

    assert.equal(
      shouldRecoverImageGenerationViaPolling(err, startedAtMs, { nowMs: startedAtMs + 30_000 }),
      true,
    )
  })

  it("recovers 5xx proxy failures after the long image edge timeout", () => {
    const err: any = new Error("Internal Server Error")
    err.status = 500

    assert.equal(
      shouldRecoverImageGenerationViaPolling(err, startedAtMs, { nowMs: startedAtMs + 30_000 }),
      true,
    )
  })

  it("does not recover immediate functional backend failures", () => {
    const err: any = new Error("El modelo no esta activo")
    err.status = 403
    err.code = "image_model_inactive"

    assert.equal(
      shouldRecoverImageGenerationViaPolling(err, startedAtMs, { nowMs: startedAtMs + 1_000 }),
      false,
    )
  })

  it("does not recover explicit user aborts", () => {
    const err: any = new DOMException("The operation was aborted", "AbortError")

    assert.equal(
      shouldRecoverImageGenerationViaPolling(err, startedAtMs, {
        nowMs: startedAtMs + 30_000,
        userAborted: true,
      }),
      false,
    )
  })
})
