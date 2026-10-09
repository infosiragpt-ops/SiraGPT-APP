import { describe, expect, it, vi } from "vitest"
import { waitForDurableImageJob } from "@/lib/chat/image-job-client"

describe("durable paid image observation", () => {
  it("retries only GET after a transient disconnect and returns the original DTO", async () => {
    const dto = { imageUrl: "/uploads/image.png", messageId: "image-message", usage: 42 }
    const get = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ jobId: "job1", status: "running" }).mockResolvedValueOnce({ jobId: "job1", status: "completed", result: dto })
    expect(await waitForDurableImageJob({ jobId: "job1", get, cancel: vi.fn(), delay: async () => {} })).toBe(dto)
    expect(get).toHaveBeenCalledTimes(3)
  })
  it("waits for durable cancellation acknowledgement before settling an aborted observer", async () => {
    const controller = new AbortController(); controller.abort()
    let acknowledge!: () => void
    let settled = false
    const cancel = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const pending = waitForDurableImageJob({ jobId: "job1", get: vi.fn(), cancel, signal: controller.signal, delay: async () => {} }).catch(error => { settled = true; return error })
    await Promise.resolve()
    expect(settled).toBe(false)
    acknowledge()
    expect(await pending).toMatchObject({ name: "AbortError" })
  })
  it("does not turn a failed or unknown paid job into another generation", async () => {
    const get = vi.fn(async () => ({ jobId: "job1", status: "failed", error: "Proveedor no disponible", code: "provider_failed" }))
    await expect(waitForDurableImageJob({ jobId: "job1", get, cancel: vi.fn(), delay: async () => {} })).rejects.toMatchObject({ code: "provider_failed" })
    expect(get).toHaveBeenCalledTimes(1)
  })
})
