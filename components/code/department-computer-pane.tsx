"use client"

/**
 * Right-hand department computer. One persistent Linux desktop per member
 * (Xvfb + x11vnc + noVNC). Every department shares that same machine.
 * Human viewer is same-origin noVNC (real mouse). PNG is agent-only.
 */

import * as React from "react"
import { Folder, Globe, Monitor, TerminalSquare, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { ComputerViewer } from "@/components/code/ComputerViewer"

export type DepartmentComputerDock = "screen" | "files" | "terminal" | "browser"

export type DepartmentComputerPaneProps = {
  departmentName: string
  departmentId: string
  projectId?: string | null
  computerRunId: string
  onClose: () => void
  browser?: React.ReactNode
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

type AgentSession = {
  sessionId: string
  userId?: string
  kind?: string
  embedUrl?: string
  novncUrl?: string
  novncWsUrl?: string
  agentUrl?: string
  reused?: boolean
}

let cachedAgentSession: AgentSession | null = null

function embedFrom(session: AgentSession): string {
  if (session.embedUrl) return session.embedUrl
  const id = session.sessionId
  if (!id) return ""
  return `/agent-computer/sessions/${id}/novnc/vnc.html?autoconnect=1&resize=scale&scale_cursor=true&path=agent-computer/sessions/${id}/novnc/websockify`
}

async function ensureMemberDesktop(): Promise<AgentSession> {
  const res = await authenticatedFetch(`${API_BASE}/agent-computer/sessions`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(
      new Error((body as any)?.message || (body as any)?.error || "No se pudo abrir la computadora persistente."),
      { status: res.status, body },
    )
  }
  cachedAgentSession = body as AgentSession
  return body as AgentSession
}

export function prewarmDepartmentDesktop(_departmentId = "ceo-office") {
  if (typeof window === "undefined") return
  void ensureMemberDesktop().catch(() => undefined)
}

async function focusDesktopApp(app: string) {
  const res = await authenticatedFetch(`${API_BASE}/agent-computer/action`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({ focus: app }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(
      new Error((body as any)?.message || (body as any)?.error || "No se pudo enfocar la aplicación."),
      { status: res.status, body },
    )
  }
  return body
}

export function DepartmentComputerPane({
  departmentName,
  departmentId,
  computerRunId,
  onClose,
}: DepartmentComputerPaneProps) {
  const [session, setSession] = React.useState<AgentSession | null>(cachedAgentSession)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(!cachedAgentSession)
  const [dock, setDock] = React.useState<DepartmentComputerDock>("screen")
  const [statusLine, setStatusLine] = React.useState("Encendiendo…")
  const dept = String(departmentId || "").trim() || "ceo-office"
  const resolvedName = departmentName || (dept === "ceo-office" ? "CEO Office" : dept)
  const embedUrl = session ? embedFrom(session) : ""

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    if (!cachedAgentSession) setLoading(true)
    void ensureMemberDesktop()
      .then((row) => {
        if (cancelled) return
        setSession(row)
        setStatusLine(row.reused ? "Escritorio persistente · reanudado" : "Escritorio persistente · en vivo")
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || "No se pudo encender la computadora.")
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [computerRunId])

  const chooseDock = React.useCallback((next: DepartmentComputerDock) => {
    setDock(next)
    const app = next === "browser" ? "chrome" : next === "files" ? "thunar" : next === "terminal" ? "terminal" : "desktop"
    void focusDesktopApp(app)
      .then(() => setStatusLine(`Enfocado · ${app}`))
      .catch(() => undefined)
  }, [])

  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col bg-[#1b1b1d] text-zinc-50 outline-none"
      data-testid="department-computer-pane"
      data-dept-real-computer="1"
      data-agent-computer-novnc="1"
      data-novnc-embed="vnc.html"
      data-computer-run-id={computerRunId}
      data-department-id={dept}
      aria-label={`Pantalla de ${resolvedName}`}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-[#2a2a2c] px-3">
        <DesktopMonitorGlyph className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold leading-tight">
            {resolvedName} · Computadora
          </h2>
          <p className="truncate text-[10px] text-zinc-400" data-testid="department-computer-status">
            {statusLine || (loading ? "Encendiendo…" : "Lista")}
            {" · "}una máquina por miembro · noVNC
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-50 active:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Cerrar computadora"
          title="Cerrar computadora"
          data-testid="department-computer-close"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#1b1b1d] text-zinc-50" data-novnc-fit="cover">
        {embedUrl ? (
          <ComputerViewer url={embedUrl} className="absolute inset-0 h-full w-full min-h-0" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center" role="status" aria-live="polite">
            <div>
              <p className="text-sm text-zinc-300">
                {error || (loading ? `Abriendo la computadora de ${resolvedName}…` : `Pantalla de ${resolvedName}`)}
              </p>
              {loading && !session ? (
                <p className="mt-3 text-[11px] text-zinc-500">noVNC · XFCE · Chrome · Terminal · Archivos</p>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <nav
        className="flex h-12 shrink-0 items-center justify-center gap-1 border-t border-white/10 bg-[#161618] px-2"
        aria-label="Aplicaciones de la computadora"
        data-testid="department-computer-dock"
        data-department-computer-dock="1"
      >
        <DockButton active={dock === "screen"} onClick={() => chooseDock("screen")} label="Pantalla" icon={Monitor} />
        <DockButton active={dock === "browser"} onClick={() => chooseDock("browser")} label="Navegador" icon={Globe} />
        <DockButton active={dock === "files"} onClick={() => chooseDock("files")} label="Archivos" icon={Folder} />
        <DockButton active={dock === "terminal"} onClick={() => chooseDock("terminal")} label="Terminal" icon={TerminalSquare} />
      </nav>
    </section>
  )
}

function DockButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        "disabled:pointer-events-none disabled:opacity-40",
        active
          ? "bg-white/15 text-white active:bg-white/25"
          : "text-zinc-400 hover:bg-white/10 hover:text-zinc-100 active:bg-white/20",
      )}
      aria-pressed={active}
      aria-label={label}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  )
}

export function DesktopMonitorGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3.25" y="3.25" width="17.5" height="12" rx="1.6" />
      <path d="M12 15.25v3.1" />
      <path d="M8 20.5h8" />
    </svg>
  )
}
