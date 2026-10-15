import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({
  authenticatedFetch: (...args: unknown[]) => transport.fetch(...args),
}))

import {
  resetFileProcessingStatusMemo,
  useFileProcessingStatus,
} from "@/hooks/use-file-processing-status"
import {
  LONG_JOB_MAX_POLL_MS,
  STATUS_FILE_GONE,
  isLongProcessingJob,
  processingPollCeilingReached,
  processingPollDelayMs,
  resolveProcessingPollGiveUp,
} from "@/lib/file-processing-status-client"

function statusResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const transcribing = (fileId: string, extra: Record<string, unknown> = {}) => statusResponse({
  fileId, name: "clase-5h.mp4", mimeType: "video/mp4", stage: "extracting", error: null, stageAt: null, isTerminal: false, ...extra,
})
const indexingPdf = (fileId: string) => statusResponse({
  fileId, name: "informe.pdf", mimeType: "application/pdf", stage: "indexing", error: null, stageAt: null, isTerminal: false,
})

const MINUTE = 60_000

/**
 * A 5 h lecture transcribes for hours. The status hook used to give up after
 * 900 polls (30 min) and resolve any running stage to `ready`, so the chip
 * said «Listo para analizar» while the transcription was half-way. Media
 * (and anything reporting progress) is a long job: 15 s polling after the
 * first two minutes, no 30-min ceiling, and never `ready` without the server.
 */
describe("useFileProcessingStatus · long media jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFileProcessingStatusMemo()
    transport.fetch.mockReset()
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
  })
  afterEach(() => {
    vi.useRealTimers()
    resetFileProcessingStatusMemo()
  })

  it("never resolves a running transcription to ready after 30 min, and keeps polling", async () => {
    transport.fetch.mockImplementation(async () => transcribing("v1"))
    const { result, unmount } = renderHook(() => useFileProcessingStatus("v1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current).toMatchObject({ stage: "extracting", isTerminal: false, longJob: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(31 * MINUTE) })
    expect(result.current.stage).toBe("extracting")
    expect(result.current.isTerminal).toBe(false)
    expect(result.current.timedOut).toBeUndefined()

    const callsAt31 = transport.fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * MINUTE) })
    expect(transport.fetch.mock.calls.length).toBeGreaterThan(callsAt31)
    expect(result.current.stage).toBe("extracting")

    transport.fetch.mockImplementation(async () => statusResponse({ fileId: "v1", stage: "ready", error: null, stageAt: "2026-10-15T10:00:00Z", isTerminal: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current).toMatchObject({ stage: "ready", isTerminal: true })
    unmount()
  })

  it("backs off to one request every 15 s after the first two minutes", async () => {
    transport.fetch.mockImplementation(async () => transcribing("v2"))
    const { unmount } = renderHook(() => useFileProcessingStatus("v2"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * MINUTE) })
    // ~2 s cadence during the first two minutes.
    expect(transport.fetch.mock.calls.length).toBeGreaterThanOrEqual(55)
    const before = transport.fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * MINUTE) })
    const during = transport.fetch.mock.calls.length - before
    expect(during).toBeGreaterThanOrEqual(38)
    expect(during).toBeLessThanOrEqual(42)
    unmount()
  })

  it("a job that reports processingProgress is long even without a media MIME", async () => {
    transport.fetch.mockImplementation(async () => statusResponse({
      fileId: "p1", name: "grabacion", mimeType: "application/octet-stream", stage: "extracting", error: null, stageAt: null, isTerminal: false,
      processingProgress: { percent: 12 },
    }))
    const { result, unmount } = renderHook(() => useFileProcessingStatus("p1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(35 * MINUTE) })
    expect(result.current).toMatchObject({ stage: "extracting", isTerminal: false, longJob: true })
    unmount()
  })

  it("an auth stop mid-transcription keeps the running stage instead of claiming ready", async () => {
    let calls = 0
    transport.fetch.mockImplementation(async () => {
      calls += 1
      return calls === 1 ? transcribing("v3") : statusResponse({ error: "unauthorized" }, 401)
    })
    const { result, unmount } = renderHook(() => useFileProcessingStatus("v3"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(result.current.stage).toBe("extracting")
    expect(result.current.isTerminal).toBe(false)
    expect(result.current.loading).toBe(false)
    const after = transport.fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * MINUTE) })
    expect(transport.fetch.mock.calls.length).toBe(after) // the loop did stop
    unmount()
  })

  it("documents keep the 30-min ceiling that resolves a wedged index to a usable state", async () => {
    transport.fetch.mockImplementation(async () => indexingPdf("d1"))
    const { result, unmount } = renderHook(() => useFileProcessingStatus("d1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(31 * MINUTE) })
    expect(result.current).toMatchObject({ stage: "ready", isTerminal: true, timedOut: true })
    expect(result.current.longJob).toBeUndefined()
    unmount()
  })
})

describe("long-job polling rules (pure)", () => {
  it("classifies media and progress-reporting jobs as long", () => {
    expect(isLongProcessingJob({ mimeType: "audio/mpeg" })).toBe(true)
    expect(isLongProcessingJob({ mimeType: "video/mp4; codecs=avc1" })).toBe(true)
    expect(isLongProcessingJob({ mimeType: "application/octet-stream", name: "clase.m4a" })).toBe(true)
    expect(isLongProcessingJob({ mimeType: "", name: "clase.mkv" })).toBe(true)
    expect(isLongProcessingJob({ mimeType: "application/pdf", name: "x.pdf", processingProgress: { percent: 3 } })).toBe(true)
    expect(isLongProcessingJob({ mimeType: "application/pdf", name: "x.pdf" })).toBe(false)
    expect(isLongProcessingJob({ mimeType: "text/plain", name: "app.ts", size: 2048 })).toBe(false)
    expect(isLongProcessingJob(null)).toBe(false)
  })

  it("paces and bounds the loop per kind", () => {
    expect(processingPollDelayMs({ longJob: false, elapsedMs: 10 * MINUTE })).toBe(2_000)
    expect(processingPollDelayMs({ longJob: true, elapsedMs: MINUTE })).toBe(2_000)
    expect(processingPollDelayMs({ longJob: true, elapsedMs: 3 * MINUTE })).toBe(15_000)
    expect(processingPollCeilingReached({ longJob: false, polls: 900, elapsedMs: 0 })).toBe(true)
    expect(processingPollCeilingReached({ longJob: true, polls: 100_000, elapsedMs: 6 * 60 * MINUTE })).toBe(false)
    expect(processingPollCeilingReached({ longJob: true, polls: 1, elapsedMs: LONG_JOB_MAX_POLL_MS })).toBe(true)
  })

  it("a give-up never turns a running long job into ready", () => {
    expect(resolveProcessingPollGiveUp("extracting", { longJob: true })).toEqual({ stage: "extracting", error: null, terminal: false })
    expect(resolveProcessingPollGiveUp("uploaded", { longJob: true })).toEqual({ stage: "uploaded", error: null, terminal: false })
    expect(resolveProcessingPollGiveUp("ready", { longJob: true })).toEqual({ stage: "ready", error: null })
    expect(resolveProcessingPollGiveUp("failed", { longJob: true })).toEqual({ stage: "failed", error: null })
    expect(resolveProcessingPollGiveUp("extracting")).toEqual({ stage: "ready", error: null })
    expect(resolveProcessingPollGiveUp("extracting", { longJob: true, httpStatus: 401 })).toEqual({ stage: "extracting", error: null, terminal: false })
    // A deleted / purged file is gone, not "still transcribing".
    expect(resolveProcessingPollGiveUp("extracting", { longJob: true, httpStatus: 410 })).toEqual({ stage: "failed", error: STATUS_FILE_GONE })
    expect(resolveProcessingPollGiveUp("extracting", { longJob: true, httpStatus: 404 })).toEqual({ stage: "failed", error: STATUS_FILE_GONE })
  })
})
