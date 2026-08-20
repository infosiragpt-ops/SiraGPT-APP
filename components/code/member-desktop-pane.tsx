"use client"

import * as React from "react"
import { Folder, Globe, Monitor, TerminalSquare } from "lucide-react"

import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { cn } from "@/lib/utils"

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

type DesktopTab = "screen" | "browser" | "files" | "terminal"

type SessionResponse = {
  ok?: boolean
  resumed?: boolean
  vncPath?: string
  label?: string
  error?: string
  message?: string
}

const TABS: Array<{ id: DesktopTab; label: string; icon: React.ElementType }> = [
  { id: "screen", label: "Pantalla", icon: Monitor },
  { id: "browser", label: "Navegador", icon: Globe },
  { id: "files", label: "Archivos", icon: Folder },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
]

export function MemberDesktopPane({
  title = "Computadora",
}: {
  title?: string
}) {
  const [tab, setTab] = React.useState<DesktopTab>("screen")
  const [session, setSession] = React.useState<SessionResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const loadSession = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authenticatedFetch(`${API_BASE}/member-desktop/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const body = (await res.json().catch(() => ({}))) as SessionResponse
      if (!res.ok || !body.ok || !body.vncPath) {
        setError(body.message || "No se pudo abrir la máquina Linux de este miembro.")
        setSession(body)
        return
      }
      setSession(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar con el escritorio.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadSession()
  }, [loadSession])

  const hint =
    tab === "browser"
      ? "Usa Chromium dentro del escritorio Xfce."
      : tab === "files"
        ? "Thunar abre /workspace (inspect y ship por tarea)."
        : tab === "terminal"
          ? "xfce4-terminal corre como usuario sin root."
          : "Escritorio Xfce persistente transmitido por noVNC."

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1a] text-zinc-100" data-testid="member-desktop-pane">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-[#111] px-3 py-1.5">
        <Monitor className="h-3.5 w-3.5 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold">{title}</div>
          <div className="truncate text-[10px] text-zinc-500">
            {session?.label || "Escritorio persistente · una máquina por miembro · noVNC"}
          </div>
        </div>
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          En vivo
        </span>
      </div>

      <div className="relative min-h-0 flex-1 bg-black">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            Arrancando el escritorio Linux…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-md text-sm text-rose-300">{error}</p>
            <button
              type="button"
              onClick={() => void loadSession()}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900"
            >
              Reintentar
            </button>
          </div>
        ) : session?.vncPath ? (
          <iframe
            title={title}
            src={session.vncPath}
            className="h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write"
          />
        ) : null}
        <p className="pointer-events-none absolute bottom-12 left-3 rounded bg-black/55 px-2 py-1 text-[10px] text-zinc-300">
          {hint}
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-white/10 bg-[#151515] px-2 py-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium",
              tab === id ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
