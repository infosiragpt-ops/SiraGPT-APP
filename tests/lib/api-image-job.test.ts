import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiClient as api } from "@/lib/api"
vi.mock("@/lib/client-logs", () => ({ reportClientLog: vi.fn() }))
const data = { prompt: "diagram", model: "gpt-image-2", provider: "OpenAI", chatId: "image-chat" }

describe("image API async contract", () => {
  beforeEach(() => { vi.useFakeTimers(); api.setToken("fixture-session") })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); api.setToken(null) })
  it("sends a stable paid identity, consumes 202 and returns the legacy terminal DTO", async () => {
    const dto = { imageUrl: "/uploads/image.png", messageId: "assistant1" }
    const request = vi.spyOn(api as any, "request").mockImplementation(async (path: string) => path === "/ai/generate-image" ? { jobId: "job1", status: "queued" } : { jobId: "job1", status: "completed", result: dto })
    expect(await api.generateImage(data, { idempotencyKey: "stable-paid-turn" })).toBe(dto)
    expect(request.mock.calls[0]).toMatchObject(["/ai/generate-image", { headers: { "Idempotency-Key": "stable-paid-turn" }, maxRetries: 1 }])
    expect(request.mock.calls[1][0]).toBe("/images/jobs/job1")
    expect(api.cancelPendingImageGeneration("image-chat")).toBeNull()
  })
  it("Stop during admission waits for a job id and its durable cancellation acknowledgement", async () => {
    let accept!: (value: any) => void, acknowledge!: (value: any) => void
    const admission = new Promise(resolve => { accept = resolve })
    const cancellation = new Promise(resolve => { acknowledge = resolve })
    const request = vi.spyOn(api as any, "request").mockImplementation(async (path: string) => {
      if (path === "/ai/generate-image") return admission
      if (path.endsWith("/cancel")) return cancellation
      return { jobId: "job2", status: "running" }
    })
    const controller = new AbortController()
    const generation = api.generateImage(data, { signal: controller.signal }).catch(error => error)
    let stopped = false
    const stop = api.cancelPendingImageGeneration("image-chat")!.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    accept({ jobId: "job2", status: "queued" })
    await vi.advanceTimersByTimeAsync(0)
    expect(request.mock.calls.some(([path]) => path === "/images/jobs/job2/cancel")).toBe(true)
    expect(stopped).toBe(false)
    acknowledge({ jobId: "job2", status: "running", phase: "Cancelando" })
    await stop
    controller.abort()
    await vi.advanceTimersByTimeAsync(1500)
    expect(await generation).toMatchObject({ name: "AbortError" })
    expect(request.mock.calls.filter(([path]) => path === "/ai/generate-image")).toHaveLength(1)
  })
})
