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

  it("defaults to «Info y superior» so fast successful reads (debug) stay out of the way", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    expect(s.calls[0].filter.level).toBe("info")
  })

  // Luis (2026-09-27): a checkbox before the time to pick lines (warnings
  // included) and copy just those, in the same text the export produces.
  it("checkboxes select lines without opening the detail; «Copiar seleccionadas» copies only those, in log order", async () => {
    const s = fakeStream()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "hello", data: { now: Date.now() } })
    s.emit({ event: "lines", data: [
      mk("1-0", { msg: "ok line" }),
      mk("2-0", { level: "warn", msg: "[config-validator] 3 warning(s) for env=production" }),
      mk("3-0", { level: "error", msg: "boom failure" }),
    ] })
    await screen.findByText("boom failure")
    expect(screen.queryByTestId("live-logs-selection")).toBeNull()
    const boxes = screen.getAllByTestId("live-log-select")
    expect(boxes).toHaveLength(3)
    fireEvent.click(boxes[2])
    fireEvent.click(boxes[1])
    expect(screen.queryByTestId("live-log-detail")).toBeNull()
    expect(screen.getByTestId("live-logs-selection").textContent).toMatch(/2 líneas seleccionadas/)
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId("live-logs-copy-selected"))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0][0] as string
    expect(text).toMatch(/WARN {2}\[backend\] - \[config-validator\] 3 warning\(s\) for env=production\n.*ERROR \[backend\] - boom failure$/)
    expect(text).not.toMatch(/ok line/)
    fireEvent.click(screen.getByTestId("live-logs-clear-selection"))
    expect(screen.queryByTestId("live-logs-selection")).toBeNull()
  })

  it("Shift+click selects a range and the header box selects or clears everything loaded", async () => {
    const s = fakeStream()
    render(<LiveLogsPanel openStream={s.openStream as any} />)
    await waitFor(() => expect(s.openStream).toHaveBeenCalled())
    s.emit({ event: "lines", data: [mk("1-0"), mk("2-0"), mk("3-0"), mk("4-0")] })
    await screen.findByText("line 4-0")
    const boxes = screen.getAllByTestId("live-log-select")
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[3], { shiftKey: true })
    expect(screen.getByTestId("live-logs-selection").textContent).toMatch(/4 líneas seleccionadas/)
    const all = screen.getByTestId("live-logs-select-all") as HTMLInputElement
    expect(all.checked).toBe(true)
    fireEvent.click(all)
    expect(screen.queryByTestId("live-logs-selection")).toBeNull()
    fireEvent.click(all)
    expect(screen.getByTestId("live-logs-selection").textContent).toMatch(/4 líneas seleccionadas/)
    // Space on a focused row toggles it; Enter still opens the detail.
    const row = screen.getByText("line 2-0").closest("[data-testid='live-log-row']") as HTMLElement
    fireEvent.keyDown(row, { key: " " })
    expect(screen.getByTestId("live-logs-selection").textContent).toMatch(/3 líneas seleccionadas/)
    expect(all.indeterminate).toBe(true)
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
