import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComputerBrowserState } from "@/lib/computer-navigate-client"
const { action, read, navigate, notify, focus } = vi.hoisted(() => ({ action: vi.fn(), read: vi.fn(), navigate: vi.fn(), notify: vi.fn(), focus: vi.fn() }))
vi.mock("@/lib/computer-navigate-client", () => ({ actComputerBrowser: action, readComputerBrowser: read, postComputerNavigate: navigate }))
vi.mock("sonner", () => ({ toast: { error: notify } }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: focus }))
vi.mock("next-intl", () => { const t = (key: string) => key; return { useTranslations: () => t } })
vi.mock("@/lib/code-workspace-context", () => ({ CODE_PREVIEW_STATE_EVENT: "preview-test", CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT: "department-test", getActiveDepartmentSelection: () => null }))
import { AgentComputerShell } from "@/components/code/agent-computer-shell"
const browser: ComputerBrowserState = { tabs: [{ id: "a", title: "A", url: "https://example.com/a" }, { id: "b", title: "B", url: "https://example.com/b" }], activeTabId: "a", canGoBack: false, canGoForward: false, presentation: "embedded", viewport: { width: 800, height: 600 } }
const props = { cleanBrowser: true, browserSessionId: "owned", conversationId: "qa", variant: "overlay" as const }
const flush = async () => { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
beforeEach(() => { vi.useFakeTimers(); action.mockReset().mockResolvedValue(browser); read.mockReset().mockResolvedValue(browser); navigate.mockReset().mockResolvedValue("https://example.com/final"); notify.mockReset(); focus.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) })
afterEach(async () => { cleanup(); await flush(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe("browser session lifecycle", () => {
  it("does not reconnect when parent callbacks change and does not poll a hidden document", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    const view = render(<AgentComputerShell {...props} onClose={() => {}}><div /></AgentComputerShell>)
    await flush()
    view.rerender(<AgentComputerShell {...props} onClose={() => {}}><div /></AgentComputerShell>)
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(action).toHaveBeenCalledTimes(1)
    expect(action.mock.calls[0][2]).toEqual({ type: "browser_present" })
    expect(read).not.toHaveBeenCalled()
  })
  it("ignores and aborts stale inventory when a confirmed tab action starts", async () => {
    const pending = deferred<ComputerBrowserState>()
    read.mockReturnValueOnce(pending.promise)
    action.mockImplementation(async (_chat, _session, command) => command.type === "browser_tab_select" ? { ...browser, activeTabId: "b" } : browser)
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    const signal = read.mock.calls[0][2] as AbortSignal
    fireEvent.click(screen.getByRole("tab", { name: "B" }))
    await flush()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(browser))
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/b")
  })
  it("clears only the recovered polling error", async () => {
    read.mockRejectedValueOnce(Error("Bearer SECRET"))
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo actualizar")
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole("alert")).toBeNull()
    action.mockRejectedValueOnce(Error("Bearer SECRET"))
    fireEvent.click(screen.getByRole("button", { name: "Recargar página" }))
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo completar")
    expect(document.body.textContent).not.toContain("SECRET")
  })
  it("restores after a pending presentation and reports restoration failure safely", async () => {
    const pending = deferred<ComputerBrowserState>()
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    action.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(Error("Bearer SECRET"))
    const view = render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    view.unmount()
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(browser))
    await flush()
    expect(action.mock.calls[1][2]).toEqual({ type: "browser_restore" })
    expect(notify).toHaveBeenCalledWith("No se pudo restaurar el escritorio. Abre el navegador e inténtalo de nuevo.")
    expect(warning).toHaveBeenCalledWith("[AgentComputerShell] browser_restore_failed")
  })
  it("repairs a failed cleanup only on explicit retry and keeps restore then present serialized", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const restored = deferred<ComputerBrowserState>()
    const presented = deferred<ComputerBrowserState>()
    let pendingViewport = false
    let restoreCount = 0
    action.mockImplementation(async (_chat, _session, command) => {
      if (command.type === "browser_restore") {
        if (++restoreCount === 1) { pendingViewport = true; throw Error("Bearer SECRET") }
        const state = await restored.promise
        pendingViewport = false
        return state
      }
      if (pendingViewport) throw Error("viewport pending")
      return restoreCount > 1 ? presented.promise : browser
    })
    const first = render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    first.unmount()
    await flush()
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo conectar")
    const beforeRetry = action.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(action).toHaveBeenCalledTimes(beforeRetry)
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(action.mock.calls.at(-1)?.[2]).toEqual({ type: "browser_restore" })
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull()
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeDisabled()
    await act(async () => restored.resolve({ ...browser, presentation: "desktop" }))
    await flush()
    expect(action.mock.calls.slice(beforeRetry).map((call) => call[2].type)).toEqual(["browser_restore", "browser_present"])
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeDisabled()
    await act(async () => presented.resolve(browser))
    await flush()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeEnabled()
    expect(navigate).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("SECRET")
  })
  it("keeps a failed explicit presentation recovery visible without presenting or retrying again", async () => {
    action.mockRejectedValue(Error("Bearer SECRET"))
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_restore"])
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo completar")
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(action).toHaveBeenCalledTimes(2)
    expect(navigate).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("SECRET")
  })
  it.each(["close", "files"])("does not present after %s cancels an explicit recovery while restore is pending", async (leave) => {
    const restored = deferred<ComputerBrowserState>()
    let restoreCount = 0
    action.mockImplementation(async (_chat, _session, command) => {
      if (command.type === "browser_restore" && ++restoreCount === 1) return restored.promise
      return { ...browser, presentation: "desktop" }
    }).mockRejectedValueOnce(Error("viewport pending"))
    const view = render(<AgentComputerShell {...props} onClose={() => view.unmount()}><div /></AgentComputerShell>)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_restore"])
    if (leave === "close") fireEvent.click(screen.getByRole("button", { name: "Cerrar navegador" }))
    else {
      fireEvent.click(screen.getByRole("button", { name: "dock.files" }))
      await flush()
      expect(focus).toHaveBeenCalledTimes(1)
      expect(JSON.parse(focus.mock.calls[0][1].body)).toMatchObject({ focus: "files", conversationId: "qa" })
      expect(screen.getByRole("button", { name: "dock.files" })).toHaveAttribute("aria-pressed", "true")
    }
    await act(async () => restored.resolve({ ...browser, presentation: "desktop" }))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_restore", "browser_restore"])
    expect(navigate).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("presents home without inventing a chat and navigates only its acquired session", async () => {
    render(<AgentComputerShell {...props} conversationId="" navigateUrl="https://example.com/final"><div /></AgentComputerShell>)
    await flush()
    expect(action.mock.calls[0].slice(0, 3)).toEqual(["", "owned", { type: "browser_present" }])
    expect(navigate).toHaveBeenCalledWith("", "https://example.com/final", "a", "owned")
    expect(navigate).toHaveBeenCalledTimes(1)
  })
  it("waits for presentation before requested navigation and never replays an agent-owned URL", async () => {
    const pending = deferred<ComputerBrowserState>()
    action.mockReturnValueOnce(pending.promise)
    const attempted = vi.fn()
    const view = render(<AgentComputerShell {...props} navigateUrl="https://example.com/final" onAutoNavigationAttempt={attempted}><div /></AgentComputerShell>)
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => pending.resolve(browser))
    await flush()
    expect(attempted).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    view.rerender(<AgentComputerShell {...props} navigateUrl="https://example.com/agent" autoNavigate={false}><div /></AgentComputerShell>)
    await flush()
    expect(navigate).toHaveBeenCalledTimes(1)
  })
  it.each(["success", "failure"])("queues an entered URL behind resize and preserves the draft through navigation %s", async (outcome) => {
    vi.stubGlobal("ResizeObserver", class { constructor(_callback: () => void) {} observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390, height: 600, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 600, toJSON() {} })
    const resized = deferred<ComputerBrowserState>()
    const navigated = deferred<string>()
    action.mockImplementation(async (_chat, _session, command) => command.type === "browser_resize" ? resized.promise : browser)
    navigate.mockImplementation(async () => {
      const result = await navigated.promise
      if (outcome === "failure") throw Error("Bearer SECRET")
      return result
    })
    read.mockResolvedValue({ ...browser, tabs: [{ ...browser.tabs[0], url: "https://example.com/next" }], viewport: { width: 390, height: 600 } })
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/next" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(action.mock.calls.at(-1)?.[2]).toEqual({ type: "browser_resize", width: 390, height: 600 })
    fireEvent.submit(screen.getByTestId("integrated-browser-bar"))
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/next")
    await act(async () => resized.resolve({ ...browser, viewport: { width: 390, height: 600 } }))
    await flush()
    expect(navigate).toHaveBeenCalledExactlyOnceWith("qa", "https://example.com/next", "a", "owned")
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/next")
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeDisabled()
    await act(async () => navigated.resolve("https://example.com/next"))
    await flush()
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/next")
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeEnabled()
    expect(action.mock.calls.filter((call) => call[2].type === "browser_resize")).toHaveLength(1)
    if (outcome === "failure") expect(screen.getByRole("alert")).toHaveTextContent("No se pudo abrir")
    else expect(screen.queryByRole("alert")).toBeNull()
    expect(document.body.textContent).not.toContain("SECRET")
  })
  it("preserves the resize remedy when a queued tab action is refused after an unconfirmed resize", async () => {
    vi.stubGlobal("ResizeObserver", class { constructor(_callback: () => void) {} observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390, height: 600, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 600, toJSON() {} })
    const resized = deferred<ComputerBrowserState>()
    let sizes = 0
    action.mockImplementation(async (_chat, _session, command) => {
      if (command.type === "browser_resize") return ++sizes === 1 ? resized.promise : { ...browser, viewport: { width: 390, height: 600 } }
      if (command.type === "browser_tab_select") throw Error("viewport pending")
      return browser
    })
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    fireEvent.click(screen.getByRole("tab", { name: "B" }))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_resize"])
    await act(async () => resized.resolve(browser))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_resize", "browser_tab_select"])
    expect(screen.getByRole("alert")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(action.mock.calls.at(-1)?.[2]).toEqual({ type: "browser_resize", width: 390, height: 600 })
    expect(action.mock.calls.filter((call) => call[2].type === "browser_tab_select")).toHaveLength(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it.each(["close", "files"])("cancels a queued URL on %s while resize is pending and restores in order", async (leave) => {
    vi.stubGlobal("ResizeObserver", class { constructor(_callback: () => void) {} observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390, height: 600, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 600, toJSON() {} })
    const resized = deferred<ComputerBrowserState>()
    action.mockImplementation(async (_chat, _session, command) => command.type === "browser_resize" ? resized.promise : browser)
    const view = render(<AgentComputerShell {...props} onClose={() => view.unmount()}><div /></AgentComputerShell>)
    await flush()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/next" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly")
    fireEvent.submit(screen.getByTestId("integrated-browser-bar"))
    await flush()
    expect(screen.getByRole("button", { name: "Nueva pestaña" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: leave === "close" ? "Cerrar navegador" : "dock.files" }))
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_resize"])
    await act(async () => resized.resolve({ ...browser, viewport: { width: 390, height: 600 } }))
    await flush()
    expect(action.mock.calls.map((call) => call[2].type)).toEqual(["browser_present", "browser_resize", "browser_restore"])
    expect(navigate).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    if (leave === "files") expect(JSON.parse(focus.mock.calls[0][1].body)).toMatchObject({ focus: "files", conversationId: "qa" })
  })

  it("requires an explicit retry after resize failure and coalesces new dimensions", async () => {
    let resize!: () => void
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
    let width = 390
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON() {} }))
    let failed = false
    action.mockImplementation(async (_chat, _session, command) => {
      if (command.type === "browser_resize") {
        if (!failed) { failed = true; throw Error("503 internal") }
        return { ...browser, viewport: { width: command.width, height: command.height } }
      }
      return browser
    })
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByRole("alert")).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(action.mock.calls.filter((call) => call[2].type === "browser_resize")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(screen.queryByRole("alert")).toBeNull()
    width = 450; act(() => resize()); width = 500; act(() => resize())
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(action.mock.calls.filter((call) => call[2].type === "browser_resize").map((call) => call[2].width)).toEqual([390, 390, 500])
  })

  it.each(["reload", "navigate"])("retains pending resize repair after %s fails until explicit retry succeeds", async (attempt) => {
    vi.stubGlobal("ResizeObserver", class { constructor(_callback: () => void) {} observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390, height: 600, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 600, toJSON() {} })
    let resizeCalls = 0
    let pendingViewport = false
    action.mockImplementation(async (_chat, _session, command) => {
      if (command.type === "browser_resize") {
        if (++resizeCalls === 1) { pendingViewport = true; throw Error("viewport pending") }
        pendingViewport = false
        return { ...browser, viewport: { width: command.width, height: command.height } }
      }
      if (pendingViewport && command.type !== "browser_restore") throw Error("viewport pending")
      return browser
    })
    navigate.mockRejectedValue(Error("viewport pending"))
    render(<AgentComputerShell {...props}><div /></AgentComputerShell>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByRole("alert")).toBeVisible()
    if (attempt === "reload") fireEvent.click(screen.getByRole("button", { name: "Recargar página" }))
    else {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/next" } })
      fireEvent.submit(screen.getByTestId("integrated-browser-bar"))
    }
    await flush()
    expect(resizeCalls).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await flush()
    expect(action.mock.calls.at(-1)?.[2]).toEqual({ type: "browser_resize", width: 390, height: 600 })
    expect(resizeCalls).toBe(2)
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
