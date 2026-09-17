"use client"

/**
 * Same-origin SiraComputer viewer (F7.2).
 *
 * RFB canvas via the scoped /ws/desktop/:sessionId proxy.
 * First framebuffer update ends the black panel.
 * viewOnly=true while the agent owns input.
 * Screen pixels are DATA, never credentials or model ids.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

export type DesktopScreenProps = {
  sessionId: string
  wsUrl?: string | null
  viewerToken?: string | null
  viewOnly?: boolean
  className?: string
  onFirstFrame?: () => void
  /** Called when the RFB channel dies and local retries are exhausted (or a
      live channel drops). The owner should rebuild the session (re-POST) or
      surface an honest error — never leave "Preparando…" spinning. */
  onConnectionError?: () => void
}

/** Bounded reconnect budget: a dead channel retries a few times with backoff
    (transient blips, slow boot), then gives up loudly via onConnectionError. */
export const DESKTOP_RFB_MAX_RETRIES = 4
export const DESKTOP_RFB_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

type RfbHandle = {
  viewOnly: boolean
  scaleViewport: boolean
  clipViewport: boolean
  resizeSession?: boolean
  showDotCursor?: boolean
  addEventListener: (type: string, cb: (ev: Event) => void) => void
  removeEventListener: (type: string, cb: (ev: Event) => void) => void
  disconnect: () => void
}

function sameOriginDesktopWsUrl(wsUrl?: string | null, viewerToken?: string | null): string {
  const token = String(viewerToken || "").trim()
  const raw = String(wsUrl || "").trim()
  if (typeof window === "undefined") return ""
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  let path = raw
  if (!path) return ""
  if (/^wss?:\/\//i.test(path)) {
    try {
      const parsed = new URL(path)
      if (/api\.siragpt\.com/i.test(parsed.host)) return ""
      if (token && !parsed.searchParams.get("token")) {
        parsed.searchParams.set("token", token)
      }
      return parsed.toString()
    } catch {
      return ""
    }
  }
  if (!path.startsWith("/")) path = `/${path}`
  if (/api\.siragpt\.com/i.test(path)) return ""
  const url = new URL(`${proto}//${window.location.host}${path}`)
  if (token && !url.searchParams.get("token")) url.searchParams.set("token", token)
  return url.toString()
}

export function DesktopScreen({
  sessionId,
  wsUrl,
  viewerToken,
  viewOnly = true,
  className,
  onFirstFrame,
  onConnectionError,
}: DesktopScreenProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [firstFrame, setFirstFrame] = React.useState(false)
  const [status, setStatus] = React.useState<"connecting" | "live" | "error">("connecting")
  const [retryNonce, setRetryNonce] = React.useState(0)
  const firstFrameRef = React.useRef(false)
  const attemptsRef = React.useRef(0)
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewerUrl = sameOriginDesktopWsUrl(wsUrl, viewerToken)

  // A new session (or new URL) gets a fresh retry budget.
  React.useEffect(() => {
    attemptsRef.current = 0
  }, [sessionId, viewerUrl])

  React.useEffect(() => {
    setFirstFrame(false)
    firstFrameRef.current = false
    setStatus("connecting")
    const host = hostRef.current
    if (!host || !viewerUrl || !sessionId) return

    let cancelled = false
    let rfb: RfbHandle | null = null
    let resizeObserver: ResizeObserver | null = null
    const markFrame = () => {
      if (cancelled) return
      firstFrameRef.current = true
      setFirstFrame(true)
      setStatus("live")
      onFirstFrame?.()
    }
    const failChannel = () => {
      if (cancelled) return
      setStatus("error")
      onConnectionError?.()
    }
    const scheduleRetry = () => {
      if (cancelled) return
      if (attemptsRef.current >= DESKTOP_RFB_MAX_RETRIES) {
        failChannel()
        return
      }
      const delay = DESKTOP_RFB_RETRY_DELAYS_MS[
        Math.min(attemptsRef.current, DESKTOP_RFB_RETRY_DELAYS_MS.length - 1)
      ]
      attemptsRef.current += 1
      retryTimerRef.current = setTimeout(() => {
        if (!cancelled) setRetryNonce((nonce) => nonce + 1)
      }, delay)
    }

    void (async () => {
      try {
        const mod = await import("./desktop-rfb-client")
        if (cancelled || !hostRef.current) return
        const RFB = (mod as { default?: unknown }).default || mod
        const Ctor = RFB as new (target: HTMLElement, url: string, opts?: Record<string, unknown>) => RfbHandle
        rfb = new Ctor(hostRef.current, viewerUrl, { shared: true })
        rfb.viewOnly = Boolean(viewOnly)
        // Scale the full 1920x1080 desktop into the host. clipViewport=true
        // was leaving a black unused half when the overlay aspect ≠ 16:9.
        rfb.scaleViewport = true
        rfb.clipViewport = false
        rfb.resizeSession = false
        rfb.showDotCursor = false
        rfb.addEventListener("connect", () => {
          if (!cancelled) setStatus("live")
        })
        rfb.addEventListener("framebufferupdate", markFrame as (ev: Event) => void)
        rfb.addEventListener("disconnect", () => {
          if (cancelled) return
          // A drop after the first frame also rebuilds through the owner:
          // a frozen canvas with no error is worse than a visible retry.
          if (firstFrameRef.current) {
            setStatus("error")
            onConnectionError?.()
            return
          }
          scheduleRetry()
        })
        if (typeof ResizeObserver === "function" && hostRef.current) {
          resizeObserver = new ResizeObserver(() => {
            try { window.dispatchEvent(new Event("resize")) } catch { /* ignore */ }
          })
          resizeObserver.observe(hostRef.current)
        }
      } catch {
        if (cancelled) return
        // Import/constructor failure behaves like a dead channel.
        if (firstFrameRef.current || attemptsRef.current >= DESKTOP_RFB_MAX_RETRIES) {
          failChannel()
        } else {
          scheduleRetry()
        }
      }
    })()

    return () => {
      cancelled = true
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      try { resizeObserver?.disconnect() } catch { /* already gone */ }
      try { rfb?.disconnect() } catch { /* already gone */ }
    }
  }, [sessionId, viewerUrl, viewOnly, onFirstFrame, onConnectionError, retryNonce])

  return (
    <div
      className={cn("relative h-full w-full min-h-0 overflow-hidden bg-[#1b1b1d]", className)}
      data-testid="desktop-screen"
      data-desktop-session={sessionId}
      data-desktop-view-only={viewOnly ? "1" : "0"}
      data-desktop-first-frame={firstFrame ? "1" : "0"}
      data-desktop-viewer-status={status}
    >
      {!firstFrame ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-[#1b1b1d]"
          data-testid="desktop-screen-black"
          aria-hidden={firstFrame}
        >
          <p className="text-sm text-zinc-400">Preparando escritorio…</p>
        </div>
      ) : null}
      <div
        ref={hostRef}
        className="absolute inset-0 flex h-full w-full items-center justify-center [&_canvas]:max-h-full [&_canvas]:max-w-full"
        data-testid="desktop-screen-canvas-host"
        data-novnc-chrome="hidden"
        role="img"
        aria-label="Pantalla de SiraGPT"
      />
    </div>
  )
}

export { sameOriginDesktopWsUrl }
