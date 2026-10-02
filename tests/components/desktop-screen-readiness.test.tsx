import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"

type ControlledRfb = EventTarget & {
  disconnect: ReturnType<typeof vi.fn>
  viewOnly: boolean
  background: string
  resizeSession: boolean
}
const sessions = vi.hoisted(() => [] as ControlledRfb[])

// The installed noVNC RFB emits `connect` after its handshake. It does not
// emit `framebufferupdate`; the fixture deliberately implements only real
// public connection events, including a late disconnect during cleanup.
vi.mock("@/components/desktop/desktop-rfb-client", () => ({
  default: class extends EventTarget {
    background = "rgb(40, 40, 40)"
    viewOnly = false
    scaleViewport = false
    clipViewport = true
    resizeSession = false
    showDotCursor = false
    disconnect = vi.fn(() => this.dispatchEvent(new Event("disconnect")))
    constructor(target: HTMLElement) {
      super()
      const canvas = document.createElement("canvas")
      canvas.width = 1920
      canvas.height = 1080
      target.appendChild(canvas)
      sessions.push(this)
    }
  },
}))

import {
  DesktopScreen,
  DESKTOP_RFB_MAX_RETRIES,
  DESKTOP_RFB_RETRY_DELAYS_MS,
} from "@/components/desktop/DesktopScreen"

const sessionProps = { sessionId: "desktop-test-1", wsUrl: "/ws/desktop/desktop-test-1" }

beforeEach(() => { sessions.length = 0 })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function connectedTransport() {
  await waitFor(() => expect(sessions.length).toBeGreaterThan(0))
  return sessions[sessions.length - 1]
}

describe("desktop viewer readiness", () => {
  it("uses neutral margins only for the browser opt-in without changing F7 transport defaults", async () => {
    const view = render(<DesktopScreen {...sessionProps} />)
    const rfb = await connectedTransport()
    expect(rfb.background).toBe("rgb(40, 40, 40)")
    expect(rfb.resizeSession).toBe(false)
    view.rerender(<DesktopScreen {...sessionProps} neutralBackground />)
    expect(rfb.background).toBe("#ffffff")
    expect(rfb.resizeSession).toBe(false)
    expect(sessions).toHaveLength(1)
    view.rerender(<DesktopScreen {...sessionProps} />)
    expect(rfb.background).toBe("rgb(40, 40, 40)")
    expect(rfb.disconnect).not.toHaveBeenCalled()
  })

  it("reveals the canvas on noVNC connect without waiting for a nonexistent frame event", async () => {
    const onConnected = vi.fn()
    render(<DesktopScreen {...sessionProps} onConnected={onConnected} />)
    const rfb = await connectedTransport()
    expect(screen.getByTestId("desktop-screen-black")).toBeInTheDocument()
    expect(screen.getByTestId("desktop-screen-canvas-host").querySelector("canvas")?.width).toBe(1920)

    act(() => { rfb.dispatchEvent(new Event("connect")) })

    expect(screen.queryByTestId("desktop-screen-black")).not.toBeInTheDocument()
    expect(screen.getByTestId("desktop-screen")).toHaveAttribute("data-desktop-viewer-status", "live")
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it("keeps the active connection across fresh parent callbacks and invokes the latest callbacks", async () => {
    const firstConnected = vi.fn()
    const firstError = vi.fn()
    const latestConnected = vi.fn()
    const latestError = vi.fn()
    const { rerender } = render(<DesktopScreen {...sessionProps}
      onConnected={() => firstConnected()} onConnectionError={() => firstError()} />)
    const rfb = await connectedTransport()

    rerender(<DesktopScreen {...sessionProps}
      onConnected={() => latestConnected()} onConnectionError={() => latestError()} />)
    await act(async () => { await vi.dynamicImportSettled() })

    expect(sessions).toHaveLength(1)
    expect(rfb.disconnect).not.toHaveBeenCalled()
    act(() => { rfb.dispatchEvent(new Event("connect")) })
    expect(latestConnected).toHaveBeenCalledTimes(1)
    expect(firstConnected).not.toHaveBeenCalled()
    act(() => { rfb.dispatchEvent(new Event("disconnect")) })
    expect(latestError).toHaveBeenCalledTimes(1)
    expect(firstError).not.toHaveBeenCalled()
    expect(screen.getByTestId("desktop-screen")).toHaveAttribute("data-desktop-viewer-status", "error")
  })

  it("replaces a changed session and ignores late events from the old transport", async () => {
    const onConnectionError = vi.fn()
    const { rerender, unmount } = render(<DesktopScreen {...sessionProps} onConnectionError={onConnectionError} />)
    const oldRfb = await connectedTransport()
    act(() => { oldRfb.dispatchEvent(new Event("connect")) })
    rerender(<DesktopScreen sessionId="desktop-test-2" wsUrl="/ws/desktop/desktop-test-2" onConnectionError={onConnectionError} />)
    await waitFor(() => expect(sessions).toHaveLength(2))
    expect(oldRfb.disconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("desktop-screen-black")).toBeInTheDocument()

    act(() => { oldRfb.dispatchEvent(new Event("connect")); oldRfb.dispatchEvent(new Event("disconnect")) })
    expect(screen.getByTestId("desktop-screen-black")).toBeInTheDocument()
    expect(onConnectionError).not.toHaveBeenCalled()
    act(() => { sessions[1].dispatchEvent(new Event("connect")) })
    expect(screen.queryByTestId("desktop-screen-black")).not.toBeInTheDocument()

    unmount()
    expect(sessions[1].disconnect).toHaveBeenCalledTimes(1)
    expect(onConnectionError).not.toHaveBeenCalled()
  })

  it("reports a terminal channel failure after the existing bounded retry budget", async () => {
    vi.useFakeTimers()
    const onConnectionError = vi.fn()
    render(<DesktopScreen {...sessionProps} onConnectionError={onConnectionError} />)
    await act(async () => { await vi.dynamicImportSettled() })
    expect(sessions).toHaveLength(1)

    for (let attempt = 0; attempt < DESKTOP_RFB_MAX_RETRIES; attempt += 1) {
      act(() => { sessions[attempt].dispatchEvent(new Event("disconnect")) })
      expect(onConnectionError).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DESKTOP_RFB_RETRY_DELAYS_MS[attempt])
        await vi.dynamicImportSettled()
      })
      expect(sessions).toHaveLength(attempt + 2)
    }
    act(() => { sessions[sessions.length - 1].dispatchEvent(new Event("disconnect")) })
    expect(onConnectionError).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("desktop-screen")).toHaveAttribute("data-desktop-viewer-status", "error")
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(sessions).toHaveLength(DESKTOP_RFB_MAX_RETRIES + 1)
  })
})
