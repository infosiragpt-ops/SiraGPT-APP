"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export type ComputerViewerStatus = "idle" | "connecting" | "connected" | "disconnected" | "error"

export type ComputerViewerProps = {
  url: string
  password?: string
  viewOnly?: boolean
  className?: string
  onStatusChange?: (status: ComputerViewerStatus) => void
}

/** Hide default vnc.html chrome when the iframe is same-origin. */
export const NOVNC_CHROME_HIDE_CSS = [
  "#noVNC_control_bar_anchor,",
  "#noVNC_control_bar,",
  "#noVNC_control_bar_handle,",
  "#noVNC_status,",
  "#noVNC_hint_anchor,",
  ".noVNC_control_bar { display: none !important; }",
  "#noVNC_container, #noVNC_container canvas { width: 100% !important; height: 100% !important; object-fit: contain; }",
  "html, body, #noVNC_container { background: #1b1b1d !important; margin: 0 !important; }",
].join(" ")

function hideNovncIframeChrome(frame: HTMLIFrameElement | null) {
  const doc = frame?.contentDocument
  if (!doc?.head) return
  if (doc.getElementById("sira-hide-novnc-chrome")) return
  const style = doc.createElement("style")
  style.id = "sira-hide-novnc-chrome"
  style.textContent = NOVNC_CHROME_HIDE_CSS
  doc.head.appendChild(style)
}

/**
 * Human viewer: same-origin noVNC (vnc.html). Real mouse/keyboard.
 * PNG screenshots stay in the agent control loop — they are not this UI.
 */
export function ComputerViewer({
  url,
  className,
  onStatusChange,
}: ComputerViewerProps) {
  const [status, setStatus] = React.useState<ComputerViewerStatus>(url ? "connecting" : "idle")

  const updateStatus = React.useCallback((next: ComputerViewerStatus) => {
    setStatus(next)
    onStatusChange?.(next)
  }, [onStatusChange])

  React.useEffect(() => {
    if (!url) {
      updateStatus("idle")
      return
    }
    updateStatus("connecting")
  }, [url, updateStatus])

  const statusLabel: Record<ComputerViewerStatus, string> = {
    idle: "Inactivo",
    connecting: "Conectando",
    connected: "En vivo",
    disconnected: "Reconectando",
    error: "Error",
  }

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden bg-[#1b1b1d]", className)}
      data-testid="agent-computer-viewer"
      data-novnc-embed="vnc.html"
      data-novnc-fit="cover"
    >
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
      {url ? (
        <iframe
          src={url}
          title="SiraGPT desktop"
          className="absolute inset-0 h-full w-full min-h-full min-w-full border-0 bg-[#1b1b1d] object-cover"
          style={{ pointerEvents: "auto", width: "100%", height: "100%", background: "#1b1b1d" }}
          allow="clipboard-read; clipboard-write; fullscreen; autoplay; pointer-lock"
          data-testid="agent-computer-novnc-frame"
          data-novnc-src="vnc.html"
          data-novnc-chrome="hidden"
          onLoad={(event) => {
            hideNovncIframeChrome(event.currentTarget)
            updateStatus("connected")
          }}
          onError={() => updateStatus("error")}
        />
      ) : null}
    </div>
  )
}

export function AgentComputerGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
