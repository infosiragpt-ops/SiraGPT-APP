"use client"

/**
 * Chat computer panel — compact Grok-Bot-style surface.
 *
 * Default view: a light panel with the live screen as a thumbnail card
 * («Pantalla de Siragpt»), gear + collapse controls on top, and the
 * Rutinas block underneath. Clicking the thumbnail or the gear expands
 * to the full OS window (AgentComputerShell) — same session, same
 * isolation per conversation.
 *
 * Login handoff: when a login/2FA/captcha/payment wall is detected the
 * panel auto-expands so the USER types on this desktop. SiraGPT never
 * sees those keystrokes. On a phone the expanded view is full-screen.
 */

import * as React from "react"
import { CalendarClock, ChevronsRight, Settings, ArrowLeft } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { AgentComputerShell } from "@/components/code/agent-computer-shell"
import { DepartmentComputerPane } from "@/components/code/department-computer-pane"
import { ComputerLoginHandoffBanner } from "@/components/chat/computer-login-handoff-banner"
import { coworkApi, type ScheduledCoworkTask } from "@/lib/cowork-api"
import { formatScheduleEsPE } from "@/lib/format-schedule-es-pe"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import {
  LOGIN_HANDOFF_WINDOW_EVENT,
  overlayLayoutContract,
  type LoginHandoffDetail,
} from "@/lib/computer-login-handoff"

export type ChatAgentComputerPanelProps = {
  conversationId: string
  onClose: () => void
  loginHandoff?: boolean
  loginHandoffSite?: string | null
}

type LiveStatus = "starting" | "live" | "error" | "idle"

const HEADER_BTN =
  "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"

const SCHEDULE_PRESETS: Array<{ id: string; label: string; cron: string }> = [
  { id: "daily", label: "Cada día · 9:00", cron: "0 9 * * *" },
  { id: "weekly", label: "Lunes · 9:00", cron: "0 9 * * 1" },
  { id: "hourly", label: "Cada hora", cron: "0 * * * *" },
]

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export default function ChatAgentComputerPanel({
  conversationId,
  onClose,
  loginHandoff = false,
  loginHandoffSite = null,
}: ChatAgentComputerPanelProps) {
  const chatId = String(conversationId || "").trim()
  const [liveStatus, setLiveStatus] = React.useState<LiveStatus>("starting")
  const [expanded, setExpanded] = React.useState(false)
  const [handoffActive, setHandoffActive] = React.useState(Boolean(loginHandoff))
  const [handoffSite, setHandoffSite] = React.useState<string>(String(loginHandoffSite || ""))
  const [viewportWidth, setViewportWidth] = React.useState(
    typeof window !== "undefined" ? window.innerWidth : 1024,
  )

  // Rutinas — the chat's cowork workspace owns the scheduled tasks.
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null)
  const [tasks, setTasks] = React.useState<ScheduledCoworkTask[]>([])
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [prompt, setPrompt] = React.useState("")
  const [preset, setPreset] = React.useState(SCHEDULE_PRESETS[0])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => setViewportWidth(window.innerWidth)
    onResize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  React.useEffect(() => {
    setHandoffActive(Boolean(loginHandoff))
    if (loginHandoffSite) setHandoffSite(String(loginHandoffSite))
    if (loginHandoff) setExpanded(true)
  }, [loginHandoff, loginHandoffSite])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onHandoff = (event: Event) => {
      const detail = (event as CustomEvent<LoginHandoffDetail>).detail
      if (!detail) return
      const id = String(detail.conversationId || "").trim()
      if (id && chatId && id !== chatId) return
      setHandoffActive(Boolean(detail.active))
      if (detail.active) setExpanded(true)
      if (detail.site) setHandoffSite(String(detail.site))
    }
    window.addEventListener(LOGIN_HANDOFF_WINDOW_EVENT, onHandoff)
    return () => window.removeEventListener(LOGIN_HANDOFF_WINDOW_EVENT, onHandoff)
  }, [chatId])

  React.useEffect(() => {
    if (!chatId) return
    let cancelled = false
    void coworkApi
      .ensureWorkspace(chatId)
      .then(async (ensured) => {
        if (cancelled) return
        const id = ensured.workspace.id
        setWorkspaceId(id)
        const result = await coworkApi.listScheduledTasks(id)
        if (cancelled) return
        setTasks(Array.isArray(result?.tasks) ? result.tasks : [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [chatId])

  React.useEffect(() => {
    if (!chatId) return
    let cancelled = false
    const pull = async () => {
      try {
        const res = await authenticatedFetch(
          `${API_BASE}/agent-computer/login-handoff?conversationId=${encodeURIComponent(chatId)}`,
          { credentials: "include", headers: authHeaders(), signal: AbortSignal.timeout(15_000) },
        )
        const body = await res.json().catch(() => ({}))
        if (cancelled || !res.ok) return
        if (body && body.active) {
          setHandoffActive(true)
          setExpanded(true)
          if (body.site) setHandoffSite(String(body.site))
        }
      } catch {
        /* overlay stays usable without the banner */
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [chatId])

  const handBack = React.useCallback(async () => {
    setHandoffActive(false)
    if (!chatId) return
    try {
      await authenticatedFetch(`${API_BASE}/agent-computer/login-handoff`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ conversationId: chatId, action: "ready" }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      /* local chrome already closed */
    }
  }, [chatId])

  const createRoutine = async () => {
    if (!workspaceId || !prompt.trim() || busy) return
    setBusy(true)
    try {
      await coworkApi.createScheduledTask({
        workspaceId,
        prompt: prompt.trim(),
        cronExpr: preset.cron,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Lima",
        deliver: "chat",
        maxSteps: 40,
        maxCostUsd: 2,
      })
      toast.success("Rutina creada")
      setPrompt("")
      setCreating(false)
      const result = await coworkApi.listScheduledTasks(workspaceId)
      setTasks(Array.isArray(result?.tasks) ? result.tasks : [])
    } catch (error: any) {
      toast.error(error?.message || "No se pudo crear la rutina")
    } finally {
      setBusy(false)
    }
  }

  const pane = (
    <DepartmentComputerPane
      departmentName="Computadora"
      departmentId={chatId ? `chat:${chatId}` : "chat"}
      computerRunId={chatId ? `chat-${chatId}` : "chat"}
      conversationId={chatId}
      embedded
      onClose={onClose}
      onStatusChange={setLiveStatus}
    />
  )

  const layout = overlayLayoutContract(viewportWidth)
  const showExpanded = expanded || handoffActive
  const mobileFullScreen = Boolean(layout.fullScreen && handoffActive)

  if (showExpanded) {
    return (
      <section
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-border/40 bg-[#e8e8ea] dark:bg-[#101012]",
          mobileFullScreen && "fixed inset-0 z-50 border-l-0",
        )}
        data-testid="chat-agent-computer-panel"
        data-chat-computer-conversation={chatId || undefined}
        data-chat-computer-view="expanded"
        data-login-handoff={handoffActive ? "1" : "0"}
        data-full-screen={mobileFullScreen ? "1" : "0"}
        aria-label="Computadora"
      >
        <ComputerLoginHandoffBanner
          active={handoffActive}
          site={handoffSite}
          onReady={() => void handBack()}
          viewportWidth={viewportWidth}
        />
        {handoffActive ? null : (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Volver al panel"
            className="flex h-8 shrink-0 items-center gap-1.5 border-b border-black/10 bg-zinc-50 px-3 text-[11px] font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:border-white/10 dark:bg-[#161618] dark:text-zinc-300 dark:hover:text-white"
            data-testid="chat-computer-collapse"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Panel
          </button>
        )}
        <div className="relative min-h-0 min-w-0 flex-1">
          <AgentComputerShell
            conversationId={chatId}
            variant="overlay"
            onClose={onClose}
            liveStatus={liveStatus}
          >
            {pane}
          </AgentComputerShell>
        </div>
      </section>
    )
  }

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-border/40 bg-background"
      data-testid="chat-agent-computer-panel"
      data-chat-computer-conversation={chatId || undefined}
      data-chat-computer-view="compact"
      data-login-handoff="0"
      data-full-screen="0"
      aria-label="Computadora"
    >
      {/* Chrome strip — gear expands, chevrons collapse the panel. */}
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 pt-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Vista completa de la computadora"
          title="Vista completa"
          className={HEADER_BTN}
          data-testid="chat-computer-expand"
        >
          <Settings className="h-4 w-4" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Ocultar panel de la computadora"
          title="Ocultar panel"
          className={HEADER_BTN}
          data-testid="chat-computer-hide"
        >
          <ChevronsRight className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      {/* Live screen thumbnail — click opens the full window. */}
      <div className="shrink-0 px-4 pt-1">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Abrir la pantalla en vivo"
          className="group relative block w-full overflow-hidden rounded-xl border border-border/50 bg-muted/30 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="chat-computer-thumbnail"
        >
          <div className="pointer-events-none aspect-[16/10] w-full">
            {pane}
          </div>
        </button>
        <p className="mt-2 text-center text-[13px] text-muted-foreground">
          Pantalla de Siragpt
        </p>
      </div>

      {/* Rutinas — recurring tasks this computer runs on a schedule. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-4">
        {tasks.length > 0 ? (
          <div className="w-full space-y-1.5" data-testid="chat-computer-routines">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-background px-2.5 py-2"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden>
                  <CalendarClock className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-tight text-foreground">
                    {String(task.prompt || "Rutina").trim() || "Rutina"}
                  </span>
                  <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">
                    {formatScheduleEsPE(task.cronExpr)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : creating ? null : (
          <p className="max-w-[260px] text-center text-[13px] leading-5 text-muted-foreground">
            Las rutinas son tareas recurrentes que este Bot ejecuta según una programación.
          </p>
        )}

        {creating ? (
          <div className="w-full space-y-2" data-testid="chat-computer-routine-form">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="¿Qué debe hacer esta rutina?"
              rows={3}
              className="w-full resize-none text-[13px]"
            />
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPreset(option)}
                  aria-pressed={preset.id === option.id}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    preset.id === option.id
                      ? "border-foreground/60 bg-foreground text-background"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!prompt.trim() || !workspaceId || busy}
                onClick={() => void createRoutine()}
                className="h-8 flex-1 rounded-lg text-[12px]"
              >
                Guardar rutina
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCreating(false)}
                className="h-8 rounded-lg text-[12px]"
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCreating(true)}
            className="h-8 rounded-lg px-4 text-[12px] font-medium"
            data-testid="chat-computer-create-routine"
          >
            Crear rutina
          </Button>
        )}
      </div>
    </section>
  )
}
