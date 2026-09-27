import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ apiClient: { getAdminTurnFailuresRecent: vi.fn() } }))

import {
  ERROR_SOUND_STORAGE_KEY,
  SEEN_AT_STORAGE_KEY,
  TurnFailureAlertsProvider,
  isUserFacingLiveErrorLine,
  useTurnFailureAlerts,
} from "@/lib/admin/turn-failure-alerts"
import type { AdminTurnFailureRecent } from "@/lib/admin/turn-failures-types"

function Probe() {
  const alerts = useTurnFailureAlerts()
  return (
    <div>
      <span data-testid="unseen">{alerts?.unseen ?? -1}</span>
      <span data-testid="sound">{alerts?.soundOn ? "on" : "off"}</span>
      <button type="button" onClick={() => alerts?.markSeen()}>visto</button>
    </div>
  )
}

function instrumentedAudio() {
  const started: number[] = []
  const factory = vi.fn(() => ({
    currentTime: 0,
    state: "running",
    destination: {},
    resume: vi.fn(async () => undefined),
    createOscillator: () => ({
      type: "",
      frequency: { setValueAtTime: (f: number) => { started.push(f) } },
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    }),
    createGain: () => ({ gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined }),
  }))
  return { factory, started }
}

const item = (id: string, category = "sin_respuesta") => ({
  id,
  createdAt: new Date().toISOString(),
  category: category as any,
  categoryLabel: "Sin respuesta",
  severity: "critical" as const,
  sound: "strong" as const,
  cause: "Respuesta vacía del modelo",
  userEmail: "luis@example.com",
  model: "Grok 4.7",
})

describe("TurnFailureAlertsProvider (admin-wide listener)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    document.title = "Admin · SiraGPT"
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("seeds the unseen count from the backlog without sounding, then counts and chimes new failures", async () => {
    window.localStorage.setItem(ERROR_SOUND_STORAGE_KEY, "1")
    window.localStorage.setItem(SEEN_AT_STORAGE_KEY, new Date(Date.now() - 60_000).toISOString())
    const responses: AdminTurnFailureRecent[] = [
      { serverTime: new Date().toISOString(), count: 2, items: [item("a"), item("b")] },
      { serverTime: new Date().toISOString(), count: 1, items: [item("c", "colgado")] },
      { serverTime: new Date().toISOString(), count: 1, items: [item("d", "usuario_reporto")] },
    ]
    const fetchRecent = vi.fn(async () => responses.shift() || { serverTime: new Date().toISOString(), count: 0, items: [] })
    const audio = instrumentedAudio()
    render(
      <TurnFailureAlertsProvider pollMs={1000} fetchRecent={fetchRecent} audioFactory={audio.factory}>
        <Probe />
      </TurnFailureAlertsProvider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId("unseen").textContent).toBe("2")
    expect(screen.getByTestId("sound").textContent).toBe("on")
    expect(audio.started).toHaveLength(0)
    expect(document.title).toBe("(2) Admin · SiraGPT")

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByTestId("unseen").textContent).toBe("3")
    // Strong chime: three oscillators scheduled.
    expect(audio.started).toEqual([880, 698.46, 587.33])

    // A second batch 1 s later is throttled (≥5 s between chimes).
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByTestId("unseen").textContent).toBe("4")
    expect(audio.started).toHaveLength(3)

    await act(async () => { screen.getByText("visto").click() })
    expect(screen.getByTestId("unseen").textContent).toBe("0")
    expect(document.title).toBe("Admin · SiraGPT")
  })

  it("new system issues and regressions play the stronger «critical» tone and add to the badge", async () => {
    window.localStorage.setItem(ERROR_SOUND_STORAGE_KEY, "1")
    const empty = { serverTime: new Date().toISOString(), count: 0, items: [] }
    const fetchRecent = vi.fn(async () => empty)
    const issueResponses = [
      // seed: the backlog counts but never sounds
      { serverTime: new Date().toISOString(), count: 1, items: [{ id: "a1", issueId: "i1", createdAt: new Date().toISOString(), type: "nuevo" as const, title: "TypeError: x", culprit: null, kind: "backend", kindLabel: null, level: "error" }] },
      { serverTime: new Date().toISOString(), count: 1, items: [{ id: "a2", issueId: "i2", createdAt: new Date().toISOString(), type: "regresion" as const, title: "ReplyError: ERR rate-limited", culprit: null, kind: "redis", kindLabel: "Redis", level: "error" }] },
    ]
    const fetchIssueAlerts = vi.fn(async () => issueResponses.shift() || empty)
    const audio = instrumentedAudio()
    function IssueProbe() {
      const alerts = useTurnFailureAlerts()
      return (
        <div>
          <span data-testid="issues">{alerts?.unseenIssues ?? -1}</span>
          <span data-testid="total">{alerts?.totalUnseen ?? -1}</span>
        </div>
      )
    }
    render(
      <TurnFailureAlertsProvider pollMs={1000} fetchRecent={fetchRecent} fetchIssueAlerts={fetchIssueAlerts} audioFactory={audio.factory}>
        <IssueProbe />
      </TurnFailureAlertsProvider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId("issues").textContent).toBe("1")
    expect(audio.started).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByTestId("issues").textContent).toBe("2")
    expect(screen.getByTestId("total").textContent).toBe("2")
    expect(audio.started).toEqual([1046.5, 830.61, 1046.5, 830.61])
    expect(document.title).toBe("(2) Admin · SiraGPT")
  })

  it("«Registros en vivo» errors sound once per burst, only when a user hit them", async () => {
    window.localStorage.setItem(ERROR_SOUND_STORAGE_KEY, "1")
    const empty = { serverTime: new Date().toISOString(), count: 0, items: [] }
    const audio = instrumentedAudio()
    render(
      <TurnFailureAlertsProvider pollMs={60_000} fetchRecent={vi.fn(async () => empty)} fetchIssueAlerts={vi.fn(async () => empty)} audioFactory={audio.factory}>
        <Probe />
      </TurnFailureAlertsProvider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const emit = (lines: unknown[]) => window.dispatchEvent(new CustomEvent("sira:admin-live-log-errors", { detail: { count: lines.length, lines } }))
    // Worker / boot noise with no user attached: silent.
    await act(async () => { emit([{ level: "error", source: "worker:doc-engine", msg: "Missing lock" }]) })
    expect(audio.started).toHaveLength(0)
    // A user's request failed: strong chime.
    await act(async () => { emit([{ level: "error", userId: "u1", reqId: "r1", route: "/api/ai/generate", msg: "boom" }]) })
    expect(audio.started).toEqual([880, 698.46, 587.33])
    // Another one 1 s later is throttled (≥5 s between chimes).
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); emit([{ level: "fatal", chatId: "c1", msg: "boom" }]) })
    expect(audio.started).toHaveLength(3)
    expect(isUserFacingLiveErrorLine({ level: "warn", userId: "u1" })).toBe(false)
    expect(isUserFacingLiveErrorLine({ level: "error", reqId: "r1" })).toBe(false)
    expect(isUserFacingLiveErrorLine({ level: "error", reqId: "r1", route: "/api/files/upload" })).toBe(true)
  })

  it("stays silent while the sound toggle is off", async () => {
    const fetchRecent = vi
      .fn()
      .mockResolvedValueOnce({ serverTime: new Date().toISOString(), count: 0, items: [] })
      .mockResolvedValueOnce({ serverTime: new Date().toISOString(), count: 1, items: [item("x")] })
      .mockResolvedValue({ serverTime: new Date().toISOString(), count: 0, items: [] })
    const audio = instrumentedAudio()
    render(
      <TurnFailureAlertsProvider pollMs={1000} fetchRecent={fetchRecent} audioFactory={audio.factory}>
        <Probe />
      </TurnFailureAlertsProvider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByTestId("unseen").textContent).toBe("1")
    expect(audio.factory).not.toHaveBeenCalled()
  })
})
