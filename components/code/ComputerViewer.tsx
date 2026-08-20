"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { isAgentComputerEnabled } from "@/lib/agent-computer-flag"

export type ComputerViewerStatus = "idle" | "connecting" | "connected" | "disconnected" | "error"

export type ComputerViewerProps = {
  url: string
  password?: string
  viewOnly?: boolean
  className?: string
  onStatusChange?: (status: ComputerViewerStatus) => void
}

type RfbLike = {
  scaleViewport: boolean
  resizeSession: boolean
  viewOnly: boolean
  addEventListener: (type: string, handler: (ev: Event) => void) => void
  removeEventListener: (type: string, handler: (ev: Event) => void) => void
  disconnect: () => void
}

/**
 * noVNC RFB viewer. Import only behind isAgentComputerEnabled() — this file
 * is the new path and does not replace the Selkies/PNG department pane.
 */
export function ComputerViewer({
  url,
  password,
  viewOnly = false,
  className,
  onStatusChange,
}: ComputerViewerProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const rfbRef = React.useRef<RfbLike | null>(null)
  const [status, setStatus] = React.useState<ComputerViewerStatus>("idle")
  const reconnectAttempt = React.useRef(0)

  const updateStatus = React.useCallback((next: ComputerViewerStatus) => {
    setStatus(next)
    onStatusChange?.(next)
  }, [onStatusChange])

  React.useEffect(() => {
    if (!url || !hostRef.current) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = async () => {
      updateStatus("connecting")
      const host = hostRef.current
      if (!host) return
      host.replaceChildren()
      try {
        const mod = await import("@novnc/novnc/lib/rfb.js")
        const RFB = mod.default
        if (cancelled || !hostRef.current) return
        const rfb: RfbLike = new RFB(hostRef.current, url, {
          credentials: password ? { password } : undefined,
        })
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.viewOnly = viewOnly
        rfb.addEventListener("connect", () => {
          reconnectAttempt.current = 0
          updateStatus("connected")
        })
        rfb.addEventListener("disconnect", () => {
          updateStatus("disconnected")
          if (cancelled) return
          const delay = Math.min(8000, 500 * 2 ** reconnectAttempt.current)
          reconnectAttempt.current += 1
          timer = setTimeout(() => {
            if (!cancelled) void connect()
          }, delay)
        })
        rfb.addEventListener("securityfailure", () => {
          updateStatus("error")
        })
        rfbRef.current = rfb
      } catch {
        updateStatus("error")
      }
    }

    void connect()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      try { rfbRef.current?.disconnect() } catch { /* ignore */ }
      rfbRef.current = null
    }
  }, [url, password, viewOnly, updateStatus])

  const statusLabel: Record<ComputerViewerStatus, string> = {
    idle: "Idle",
    connecting: "Connecting",
    connected: "Live",
    disconnected: "Reconnecting",
    error: "Error",
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-zinc-950", className)} data-testid="agent-computer-viewer">
      <div
        className={cn(
          "pointer-events-none absolute right-2 top-2 z-10 rounded-full px-2 py-0.5 text-[10px] font-medium",
          status === "connected" && "bg-emerald-500/20 text-emerald-300",
          status === "connecting" && "bg-amber-500/20 text-amber-200",
          status === "disconnected" && "bg-sky-500/20 text-sky-200",
          status === "error" && "bg-rose-500/20 text-rose-300",
          status === "idle" && "bg-zinc-700/60 text-zinc-300",
        )}
        data-status={status}
      >
        {statusLabel[status]}
      </div>
      <div ref={hostRef} className="absolute inset-0 [&>canvas]:h-full [&>canvas]:w-full" />
    </div>
  )
}

export function AgentComputerGate({ children }: { children: React.ReactNode }) {
  if (!isAgentComputerEnabled()) return null
  return <>{children}</>
}
