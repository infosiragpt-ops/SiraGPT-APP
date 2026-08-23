"use client"

/**
 * AgentComputerShell — the founder's visual target for /code (capture
 * 2026-08-22 19:17): the right-hand panel IS the agent's live computer.
 *
 * It wraps the existing workspace main area in a Chrome-style OS window:
 * traffic lights + live title bar fed by CODE_PREVIEW_STATE_EVENT, a dock of
 * real machine apps (focus goes through /api/agent-computer/action → xdotool),
 * and a collapsible "Rutinas" strip for scheduled recurring jobs.
 *
 * The live browser viewport itself remains PreviewPane's sandboxed iframe —
 * this shell frames it, it does not duplicate any runner.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import {
  CalendarClock,
  ChevronDown,
  Folder,
  Globe,
  Monitor,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import {
  CODE_PREVIEW_STATE_EVENT,
  type CodePreviewState,
  getActiveDepartmentSelection,
  CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT,
} from "@/lib/code-workspace-context"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")

type DockApp = "desktop" | "browser" | "files" | "terminal"

export type AgentComputerShellProps = {
  /** The workspace main area (live preview + overlays) framed as one window. */
  children: React.ReactNode
}

export function AgentComputerShell({ children }: AgentComputerShellProps) {
  const t = useTranslations("codex.panel.agentComputer")
  const [preview, setPreview] = React.useState<CodePreviewState | null>(null)
  const [routinesOpen, setRoutinesOpen] = React.useState(true)
  const [activeApp, setActiveApp] = React.useState<DockApp>("browser")
  const [focusNote, setFocusNote] = React.useState<string | null>(null)
  const [deptName, setDeptName] = React.useState<string>("")

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onPreviewState = (event: Event) => {
      setPreview((event as CustomEvent<CodePreviewState>).detail ?? null)
    }
    window.addEventListener(CODE_PREVIEW_STATE_EVENT, onPreviewState)
    const onDeptSelection = () => {
      setDeptName(getActiveDepartmentSelection()?.name ?? "")
    }
    onDeptSelection()
    window.addEventListener(CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT, onDeptSelection)
    return () => {
      window.removeEventListener(CODE_PREVIEW_STATE_EVENT, onPreviewState)
      window.removeEventListener(CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT, onDeptSelection)
    }
  }, [])

  const isLive = preview?.phase === "ready"
  const isStarting = preview?.phase === "starting"

  const statusLabel = isLive
    ? t("status.live")
    : isStarting
      ? t("status.starting")
      : preview?.phase === "error"
        ? t("status.error")
        : t("status.idle")

  const dockApps: { app: DockApp; label: string; icon: React.ReactNode }[] = [
    { app: "browser", label: t("dock.browser"), icon: <Globe className="h-5 w-5" /> },
    { app: "files", label: t("dock.files"), icon: <Folder className="h-5 w-5" /> },
    { app: "terminal", label: t("dock.terminal"), icon: <TerminalSquare className="h-5 w-5" /> },
    { app: "desktop", label: t("dock.desktop"), icon: <Monitor className="h-5 w-5" /> },
  ]

  const focusApp = React.useCallback(
    async (app: DockApp) => {
      setActiveApp(app)
      if (app === "desktop") return
      setFocusNote(null)
      try {
        await authenticatedFetch(`${API_BASE}/agent-computer/action`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ focus: app }),
          signal: AbortSignal.timeout(20_000),
        })
        setFocusNote(app === "browser" ? t("dock.focusedBrowser") : t("dock.focusedOther", { app }))
      } catch {
        setFocusNote(t("dock.unavailable"))
      }
    },
    [t],
  )

  const addressPath = isLive && typeof window !== "undefined" && preview?.src
    ? safePathOf(preview.src)
    : "/"

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-[#e8e8ea] dark:bg-[#101012]"
      data-testid="agent-computer-shell"
      data-agent-computer-shell="1"
      aria-label={t("title")}
    >
      {/* Browser-style window chrome */}
      <div
        className="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-gradient-to-b from-white to-zinc-100 px-3 dark:border-white/10 dark:from-[#2a2a2c] dark:to-[#1b1b1d]"
        data-testid="agent-computer-chrome"
      >
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </span>
        <span className="ml-1 hidden items-center gap-1 sm:flex" aria-hidden>
          <RefreshCw className={cn("h-3.5 w-3.5 text-zinc-400", isStarting && "animate-spin")} />
          <Square className="h-3 w-3 text-zinc-400" />
        </span>
        <div className="mx-auto flex h-7 min-w-0 max-w-md flex-1 items-center justify-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 text-[11px] text-zinc-600 shadow-inner dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-300">
          <Globe className="h-3 w-3 shrink-0 opacity-60" />
          <span className="truncate font-mono">{addressPath}</span>
          <span
            className={cn(
              "ml-1 shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
              isLive && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
              isStarting && "bg-amber-500/15 text-amber-600 dark:text-amber-200",
              !isLive && !isStarting && "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
            )}
            data-testid="agent-computer-live-status"
            data-phase={preview?.phase ?? "idle"}
          >
            {statusLabel}
          </span>
        </div>
        <span className="hidden truncate text-[10px] text-zinc-400 md:block">
          {deptName ? `${deptName} · ${t("title")}` : t("title")}
        </span>
      </div>

      {/* Live viewport — the existing preview canvas, framed */}
      <div className="relative min-h-0 min-w-0 flex-1">{children}</div>

      {/* Rutinas — visible recurring work under the screen */}
      <div className="shrink-0 border-t border-black/10 bg-zinc-50 dark:border-white/10 dark:bg-[#161618]">
        <button
          type="button"
          onClick={() => setRoutinesOpen((v) => !v)}
          aria-expanded={routinesOpen}
          className="flex h-8 w-full items-center gap-1.5 px-3 text-[11px] font-semibold text-zinc-600 hover:bg-black/[0.03] dark:text-zinc-300 dark:hover:bg-white/[0.04]"
          data-testid="agent-computer-routines-toggle"
        >
          <CalendarClock className="h-3.5 w-3.5" />
          {t("routines.toggle")}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", routinesOpen && "rotate-180")} />
        </button>
        {routinesOpen ? (
          <ul className="space-y-1 px-3 pb-2" data-testid="agent-computer-routines">
            {(
              [
                {
                  id: "mejora-constante",
                  name: t("routines.mejoraConstanteName"),
                  schedule: t("routines.mejoraConstanteSchedule"),
                  next: t("routines.mejoraConstanteNext"),
                },
                {
                  id: "avisar-tiendas",
                  name: t("routines.avisarTiendasName"),
                  schedule: t("routines.avisarTiendasSchedule"),
                  next: t("routines.avisarTiendasNext"),
                },
              ] as const
            ).map((routine) => (
              <li key={routine.id}>
                <button
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("siragpt:code-open-routine-chat", { detail: { routineId: routine.id } }),
                    )
                  }
                  className="flex w-full items-center gap-2 rounded-lg border border-black/[0.06] bg-white px-2.5 py-1.5 text-left transition-colors hover:border-black/15 dark:border-white/[0.07] dark:bg-white/[0.04] dark:hover:border-white/20"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500 dark:text-violet-300" aria-hidden>
                    <CalendarClock className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium leading-tight text-zinc-700 dark:text-zinc-100">
                      {routine.name}
                    </span>
                    <span className="block truncate text-[10px] leading-tight text-zinc-400">
                      {routine.schedule} · {routine.next}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                    {t("routines.active")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* OS-style dock */}
      <nav
        className="flex h-14 shrink-0 items-end justify-center gap-2 border-t border-black/10 bg-zinc-100/95 px-3 pb-1.5 backdrop-blur dark:border-white/10 dark:bg-[#0c0c0d]/95"
        aria-label={t("title")}
        data-testid="agent-computer-dock-os"
      >
        {dockApps.map(({ app, label, icon }) => (
          <DockIcon key={app} active={activeApp === app} label={label} onClick={() => void focusApp(app)}>
            {icon}
          </DockIcon>
        ))}
        <span className="mb-1 ml-1 hidden max-w-40 truncate text-[9px] text-zinc-400 md:block" data-testid="agent-computer-focus-note">
          {focusNote ?? ""}
        </span>
      </nav>
    </section>
  )
}

function DockIcon({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all hover:-translate-y-1",
        active
          ? "bg-white text-zinc-900 shadow-md dark:bg-white/90"
          : "bg-black/[0.05] text-zinc-500 hover:bg-black/[0.09] dark:bg-white/[0.07] dark:text-zinc-300 dark:hover:bg-white/[0.12]",
      )}
    >
      {children}
      {active ? (
        <span className="absolute -bottom-1 h-1 w-1 rounded-full bg-zinc-500 dark:bg-zinc-300" aria-hidden />
      ) : null}
      <span className="pointer-events-none absolute -top-7 whitespace-nowrap rounded-md bg-zinc-900 px-1.5 py-0.5 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-zinc-800">
        {label}
      </span>
    </button>
  )
}

function safePathOf(src: string): string {
  try {
    const url = new URL(src, "http://placeholder.local")
    return url.pathname + url.search || "/"
  } catch {
    return "/"
  }
}
