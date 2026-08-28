"use client"

/**
 * Right-hand department / chat computer. Persistent Linux desktop.
 * Bind the session to conversationId when provided so chat A does
 * not reuse chat B's cached desktop. Human viewer is the live
 * same-origin desktop (real mouse). PNG is agent-only.
 */

import * as React from "react"
import { Folder, Globe, Monitor, TerminalSquare, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { ComputerViewer } from "@/components/code/ComputerViewer"
import { PensandoBars } from "@/components/pensando-bars"
import { emitLoginHandoff } from "@/lib/computer-login-handoff"

export type DepartmentComputerDock = "screen" | "files" | "terminal" | "browser"

export type DepartmentComputerPaneProps = {
  departmentName: string
  departmentId: string
  projectId?: string | null
  computerRunId: string
  onClose: () => void
  browser?: React.ReactNode
  /** Open chat/conversation id — keys the live desktop session per chat. */
  conversationId?: string | null
  /** Hide this pane's own chrome when framed by AgentComputerShell. */
  embedded?: boolean
  onStatusChange?: (status: "starting" | "live" | "error" | "idle") => void
}

function computerApiBase() {
  return getSameOriginApiBaseUrl().replace(/\/+$/, "")
}

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
  conversationId?: string | null
  conversationBound?: boolean
  sessionKey?: string
}

const sessionCache = new Map<string, AgentSession>()

const GENERIC_DESKTOP_UNAVAILABLE =
  "No se pudo abrir la computadora. El escritorio no está disponible."
const PREPARING_DESKTOP_ES = "Preparando escritorio…"

function cacheKey(conversationId?: string | null) {
  const id = String(conversationId || "").trim()
  return id ? `chat:${id}` : "member"
}

type DesktopPoolHint = { poolWarm: number; enabled: boolean; starting: boolean }

function userFacingComputerError(
  message?: string,
  hint: DesktopPoolHint = { poolWarm: 0, enabled: false, starting: false },
): string {
  if (hint.poolWarm > 0 || hint.starting) {
    const msg = String(message || "").trim()
    if (!msg || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|AbortError|timed out|orchestrator|ORCH_|network|El escritorio no está disponible/i.test(msg)) {
      return PREPARING_DESKTOP_ES
    }
    if (/sk-[A-Za-z0-9_-]{8,}/i.test(msg) || /deepseek|model[_-]?id/i.test(msg)) {
      return PREPARING_DESKTOP_ES
    }
    return msg
  }
  const msg = String(message || "").trim()
  if (!msg) return GENERIC_DESKTOP_UNAVAILABLE
  if (/sk-[A-Za-z0-9_-]{8,}/i.test(msg)) return "No se pudo abrir la computadora."
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|AbortError|timed out|orchestrator|ORCH_|network/i.test(msg)) {
    return GENERIC_DESKTOP_UNAVAILABLE
  }
  if (/deepseek|model[_-]?id/i.test(msg)) return "No se pudo abrir la computadora."
  if (/^[a-z0-9_]+$/i.test(msg)) return GENERIC_DESKTOP_UNAVAILABLE
  return msg
}

type DesktopLease = {
  sessionId: string
  wsUrl?: string
  provider?: string
  expiresAt?: string
  status?: string
  fromPool?: boolean
}

async function getDesktopStatus(): Promise<{ enabled: boolean; poolWarm: number } | null> {
  try {
    const res = await authenticatedFetch(`${computerApiBase()}/desktop/status`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders(),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => ({})) as { enabled?: boolean; poolWarm?: number }
    return {
      enabled: Boolean(body.enabled),
      poolWarm: Number(body.poolWarm) || 0,
    }
  } catch {
    return null
  }
}

async function acquireDesktopLease(chatId: string): Promise<DesktopLease> {
  const res = await authenticatedFetch(`${computerApiBase()}/desktop/sessions`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify(chatId ? { conversationId: chatId } : {}),
    signal: AbortSignal.timeout(25_000),
  })
  const body = await res.json().catch(() => ({})) as DesktopLease & { message?: string; error?: string; poolWarm?: number }
  if (!res.ok) {
    throw Object.assign(
      new Error(body.message || body.error || PREPARING_DESKTOP_ES),
      { status: res.status, body, poolWarm: Number(body.poolWarm) || 0 },
    )
  }
  return body
}

function embedFrom(session: AgentSession): string {
  const raw = String(session.embedUrl || session.novncUrl || "").trim()
  if (raw && !/computer\.(siragpt|chatagic)\.com/i.test(raw)) return raw
  const id = session.sessionId
  if (!id) return ""
  return `/sessions/${id}/novnc/vnc.html?autoconnect=1&resize=scale&scale_cursor=true&path=sessions/${id}/novnc/websockify`
}

async function postMemberDesktop(chatId: string, useQuery: boolean) {
  const qs = chatId && useQuery ? `?conversationId=${encodeURIComponent(chatId)}` : ""
  const res = await authenticatedFetch(`${computerApiBase()}/agent-computer/sessions${qs}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: chatId ? JSON.stringify({ conversationId: chatId }) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

async function ensureMemberDesktop(conversationId?: string | null): Promise<AgentSession> {
  const key = cacheKey(conversationId)
  const chatId = String(conversationId || "").trim()
  let { res, body } = await postMemberDesktop(chatId, Boolean(chatId))
  if (res.status === 409) {
    ({ res, body } = await postMemberDesktop(chatId, true))
  }
  if (!res.ok) {
    const isolation = res.status === 409 && (
      (body as { error?: string; message?: string }).error === "isolation_required"
      || /aislar/.test(String((body as { message?: string }).message || ""))
    )
    if (isolation && !chatId) {
      throw Object.assign(new Error("Pensando…"), {
        status: res.status,
        body,
        emptyChat: true,
      })
    }
    throw Object.assign(
      new Error((body as any)?.message || (body as any)?.error || "No se pudo abrir la computadora."),
      { status: res.status, body },
    )
  }
  const session = body as AgentSession
  if (chatId && session.conversationBound === false) {
    throw Object.assign(
      new Error("No se pudo aislar la computadora de esta conversación."),
      { status: 409, body, isolationRequired: true },
    )
  }
  sessionCache.set(key, session)
  return session
}

export function prewarmDepartmentDesktop(_departmentId = "ceo-office", conversationId?: string | null) {
  if (typeof window === "undefined") return
  void ensureMemberDesktop(conversationId).catch(() => undefined)
}

async function focusDesktopApp(app: string, conversationId?: string | null) {
  const chatId = String(conversationId || "").trim()
  const res = await authenticatedFetch(`${computerApiBase()}/agent-computer/action`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({
      focus: app,
      ...(chatId ? { conversationId: chatId } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (res.status === 409 && (body?.loginHandoff === true || body?.error === "login_handoff_required")) {
    emitLoginHandoff({
      active: true,
      conversationId: chatId || null,
      site: typeof (body as any)?.takeover?.site === "string" ? (body as any).takeover.site : undefined,
      kind: typeof (body as any)?.takeover?.kind === "string" ? (body as any).takeover.kind : undefined,
      reason: typeof (body as any)?.takeover?.reason === "string" ? (body as any).takeover.reason : undefined,
      title: typeof (body as any)?.takeover?.title === "string" ? (body as any).takeover.title : undefined,
    })
  }
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
  conversationId,
  embedded = false,
  onStatusChange,
}: DepartmentComputerPaneProps) {
  const chatId = String(conversationId || "").trim()
  const initial = sessionCache.get(cacheKey(chatId || null)) ?? null
  const [session, setSession] = React.useState<AgentSession | null>(initial)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(!initial)
  const [dock, setDock] = React.useState<DepartmentComputerDock>("screen")
  const [statusLine, setStatusLine] = React.useState(PREPARING_DESKTOP_ES)
  const [poolWarm, setPoolWarm] = React.useState(0)
  const [desktopLease, setDesktopLease] = React.useState<DesktopLease | null>(null)
  const [prepareProgress, setPrepareProgress] = React.useState(12)
  const dept = String(departmentId || "").trim() || "ceo-office"
  const resolvedName = departmentName || (dept === "ceo-office" ? "CEO Office" : dept)
  const embedUrl = session ? embedFrom(session) : ""
  const bound = Boolean(session?.conversationBound && chatId)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    setDesktopLease(null)
    const cached = sessionCache.get(cacheKey(chatId || null)) ?? null
    if (!cached) {
      setSession(null)
      setLoading(true)
      setStatusLine(PREPARING_DESKTOP_ES)
      setPrepareProgress(18)
    } else {
      setSession(cached)
      setLoading(false)
    }

    void (async () => {
      const desk = await getDesktopStatus()
      if (cancelled) return
      const warm = desk?.poolWarm ?? 0
      setPoolWarm(warm)
      setPrepareProgress(desk?.enabled ? 42 : 28)

      if (desk?.enabled) {
        try {
          const lease = await acquireDesktopLease(chatId)
          if (cancelled) return
          setDesktopLease(lease)
          setPoolWarm(Math.max(warm, lease.fromPool ? 1 : warm))
          setStatusLine("En vivo")
          setLoading(false)
          setError(null)
          return
        } catch (deskErr: any) {
          if (cancelled) return
          if (warm > 0) {
            setError(null)
            setStatusLine(userFacingComputerError(deskErr?.message, { poolWarm: warm, enabled: true, starting: true }))
            setLoading(true)
            return
          }
          setError(userFacingComputerError(deskErr?.message, { poolWarm: 0, enabled: true, starting: true }))
          setStatusLine(PREPARING_DESKTOP_ES)
          setLoading(true)
        }
      }

      try {
        const row = await ensureMemberDesktop(chatId || null)
        if (cancelled) return
        setSession(row)
        setStatusLine("En vivo")
        setLoading(false)
      } catch (err: any) {
        if (cancelled) return
        if (err?.emptyChat) {
          setError(null)
          setStatusLine(PREPARING_DESKTOP_ES)
          setLoading(true)
          return
        }
        const nextHint: DesktopPoolHint = {
          poolWarm: warm,
          enabled: Boolean(desk?.enabled),
          starting: !desk?.enabled && warm <= 0 ? false : warm > 0 || Boolean(desk?.enabled),
        }
        if (nextHint.poolWarm > 0 || nextHint.starting) {
          setError(null)
          setStatusLine(userFacingComputerError(err?.message, nextHint))
          setLoading(true)
          return
        }
        setError(userFacingComputerError(err?.message, nextHint))
        setStatusLine(userFacingComputerError(err?.message, nextHint))
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [computerRunId, chatId])

  const chooseDock = React.useCallback((next: DepartmentComputerDock) => {
    setDock(next)
    const app = next === "browser" ? "chrome" : next === "files" ? "thunar" : next === "terminal" ? "terminal" : "desktop"
    void focusDesktopApp(app, chatId || null)
      .then(() => setStatusLine("En vivo"))
      .catch(() => undefined)
  }, [chatId])

  const attachUrl = bound || !chatId ? embedUrl : ""

  React.useEffect(() => {
    if (!onStatusChange) return
    if (loading) onStatusChange("starting")
    else if (error && poolWarm <= 0) onStatusChange("error")
    else if ((session && attachUrl) || desktopLease) onStatusChange("live")
    else onStatusChange("idle")
  }, [loading, error, session, attachUrl, desktopLease, poolWarm, onStatusChange])

  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col bg-[#1b1b1d] text-zinc-50 outline-none"
      data-testid="department-computer-pane"
      data-dept-real-computer="1"
      data-agent-computer-novnc="1"
      data-novnc-embed="vnc.html"
      data-computer-run-id={computerRunId}
      data-department-id={dept}
      data-conversation-id={chatId || undefined}
      data-conversation-bound={bound ? "1" : "0"}
      aria-label={`Pantalla de ${resolvedName}`}
    >
      {embedded ? null : (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-[#2a2a2c] px-3">
          <DesktopMonitorGlyph className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[12px] font-semibold leading-tight">
              {resolvedName} · Computadora
            </h2>
            <p className="truncate text-[10px] text-zinc-400" data-testid="department-computer-status">
              {error
                ? userFacingComputerError(error, { poolWarm, enabled: poolWarm > 0, starting: loading })
                : statusLine || (loading ? PREPARING_DESKTOP_ES : "En vivo")}
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
      )}

      <span className="sr-only" data-testid="chat-computer-isolation-gap" />

      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-[#1b1b1d] text-zinc-50"
        data-novnc-fit="cover"
        data-desktop-pool-warm={poolWarm}
        data-desktop-preparing={loading && !attachUrl ? "1" : "0"}
        data-desktop-first-frame={desktopLease && !attachUrl ? "1" : "0"}
      >
        {attachUrl ? (
          <ComputerViewer key={chatId || session?.sessionId || "desktop"} url={attachUrl} className="absolute inset-0 h-full w-full min-h-0" />
        ) : desktopLease ? (
          <div
            className="absolute inset-0 flex items-center justify-center px-6 text-center"
            role="img"
            aria-label="Primera imagen del escritorio"
            data-testid="desktop-first-frame"
          >
            <div className="flex flex-col items-center gap-2">
              <DesktopMonitorGlyph className="h-10 w-10 text-zinc-500" />
              <p className="text-sm text-zinc-300">Escritorio listo</p>
              <p className="text-[11px] text-zinc-500">La vista en vivo llega en la siguiente fase.</p>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center" role="status" aria-live="polite">
            <div className="flex flex-col items-center gap-3">
              {!error ? <PensandoBars size={28} /> : null}
              <p className="text-sm text-zinc-300" data-testid="desktop-preparing-label">
                {error
                  ? userFacingComputerError(error, { poolWarm, enabled: poolWarm > 0, starting: loading })
                  : PREPARING_DESKTOP_ES}
              </p>
              {!error ? (
                <div
                  className="h-1 w-40 overflow-hidden rounded-full bg-zinc-700"
                  data-testid="desktop-prepare-progress"
                  aria-hidden
                >
                  <div
                    className="h-full bg-sky-400/80 transition-[width]"
                    style={{ width: `${Math.min(92, Math.max(12, prepareProgress))}%` }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {embedded ? null : (
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
      )}
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
