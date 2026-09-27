import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LiveLogsPanel } from "@/components/admin/live-logs/live-logs-panel"
import type { LiveLogLine, LiveLogStreamEvent } from "@/lib/admin/live-logs-service"

const mk = (id: string, over: Partial<LiveLogLine> = {}): LiveLogLine => ({
  id, ts: 1790467141000 + Number(id.split("-")[0]), level: "info", source: "backend", msg: `line ${id}`, commit: "d7378dea", ...over,
})

function fakeStream() {
  let emit: ((e: LiveLogStreamEvent) => void) | null = null
  const calls: any[] = []
  const openStream = vi.fn(async (opts: any) => {
    calls.push(opts)
    emit = opts.onEvent
    await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve()))
  })
  return { openStream, calls, emit: (e: LiveLogStreamEvent) => act(() => { emit?.(e) }) }
}

afterEach(() => cleanup())

describe("LiveLogsPanel", () => {
  it("renders backfill + live lines, colours errors and reports only live errors", async () => {
    const s = fakeStream()
    const onNewErrors = vi.fn()
    render(<LiveLogsPanel openStream={s.openStream as any} onNewErrors={onNewErrors} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "hello", data: { now: Date.now() } })
    s.emit({ event: "backfill", data: [mk("1-0"), mk("2-0", { level: "error", msg: "old failure" })] })
    expect(await screen.findByText("line 1-0")).toBeTruthy()
    expect(onNewErrors).not.toHaveBeenCalled()
    s.emit({ event: "lines", data: [mk("3-0", { level: "error", msg: "[agent-task-worker] worker error: ERR boom", source: "worker:agent-task-worker", email: "luis@x.com" })] })
    const row = (await screen.findByText(/worker error: ERR boom/)).closest("[data-testid='live-log-row']") as HTMLElement
    expect(row.getAttribute("data-level")).toBe("error")
    expect(onNewErrors).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("live-logs-counts").textContent).toMatch(/3 líneas · 2 errores/)
    expect(screen.getByTestId("live-logs-status").textContent).toMatch(/En vivo/)
  })

  it("pause buffers new lines and resume flushes them", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "hello", data: { now: Date.now() } })
    fireEvent.click(screen.getByTestId("live-logs-pause"))
    s.emit({ event: "lines", data: [mk("5-0"), mk("6-0")] })
    expect(screen.getByTestId("live-logs-status").textContent).toMatch(/Pausado · 2 nuevas/)
    expect(screen.queryByText("line 5-0")).toBeNull()
    fireEvent.click(screen.getByTestId("live-logs-pause"))
    expect(await screen.findByText("line 5-0")).toBeTruthy()
  })

  it("repeat events update the collapsed counter", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "lines", data: [mk("7-0", { level: "error", msg: "ReplyError: ERR rate-limited" })] })
    s.emit({ event: "repeat", data: [{ id: "7-0", repeat: 12, lastTs: Date.now() }] })
    expect(await screen.findByText("×12")).toBeTruthy()
  })

  it("«Solo errores» reconnects with the error level filter", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId("live-logs-errors-only"))
    await waitFor(() => expect(s.openStream).toHaveBeenCalledTimes(2))
    expect(s.calls[1].filter.level).toBe("error")
  })

  it("clicking a line opens the detail with context and the request trail button", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "lines", data: [mk("9-0", { level: "error", msg: "Image file not found", reqId: "req-42", chatId: "chat-1", email: "luis@x.com", body: "Image file not found\n    at x (a.js:1:1)" })] })
    fireEvent.click(await screen.findByText("Image file not found"))
    const detail = await screen.findByTestId("live-log-detail")
    expect(within(detail).getByText("req-42")).toBeTruthy()
    expect(within(detail).getByTestId("live-log-request-trail")).toBeTruthy()
    expect(within(detail).getByText(/at x \(a\.js:1:1\)/)).toBeTruthy()
  })
})
