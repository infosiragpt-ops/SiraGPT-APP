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
}

type RfbHandle = {
  viewOnly: boolean
  scaleViewport: boolean
  clipViewport: boolean
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
}: DesktopScreenProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [firstFrame, setFirstFrame] = React.useState(false)
  const [status, setStatus] = React.useState<"connecting" | "live" | "error">("connecting")
  const viewerUrl = sameOriginDesktopWsUrl(wsUrl, viewerToken)

  React.useEffect(() => {
    setFirstFrame(false)
    setStatus("connecting")
    const host = hostRef.current
    if (!host || !viewerUrl || !sessionId) return

    let cancelled = false
    let rfb: RfbHandle | null = null
    const markFrame = () => {
      if (cancelled) return
      setFirstFrame(true)
      setStatus("live")
      onFirstFrame?.()
    }

    void (async () => {
      try {
        const mod = await import("./desktop-rfb-client")
        if (cancelled || !hostRef.current) return
        const RFB = (mod as { default?: unknown }).default || mod
        const Ctor = RFB as new (target: HTMLElement, url: string, opts?: Record<string, unknown>) => RfbHandle
        rfb = new Ctor(hostRef.current, viewerUrl, { shared: true })
        rfb.viewOnly = Boolean(viewOnly)
        rfb.scaleViewport = true
        rfb.clipViewport = true
        rfb.addEventListener("connect", () => {
          if (!cancelled) setStatus("live")
        })
        rfb.addEventListener("framebufferupdate", markFrame as (ev: Event) => void)
        rfb.addEventListener("disconnect", () => {
          if (!cancelled) setStatus("error")
        })
      } catch {
        if (!cancelled) setStatus("error")
      }
    })()

    return () => {
      cancelled = true
      try { rfb?.disconnect() } catch { /* already gone */ }
    }
  }, [sessionId, viewerUrl, viewOnly, onFirstFrame])

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
        className="absolute inset-0 h-full w-full"
        data-testid="desktop-screen-canvas-host"
        role="img"
        aria-label="Pantalla de SiraGPT"
      />
    </div>
  )
}

export { sameOriginDesktopWsUrl }
