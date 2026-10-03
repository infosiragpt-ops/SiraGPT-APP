"use client"

/**
 * Frames the existing /agentes computer panel. Browser controls operate on
 * confirmed tabs in the conversation's live browser; desktop apps retain
 * their existing dock. The viewport is the same interactive desktop session.
 */

import * as React from "react"
import { toast } from "sonner"
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
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { actComputerBrowser, readComputerBrowser, postComputerNavigate, type ComputerBrowserState, type ComputerBrowserAction } from "@/lib/computer-navigate-client"
import { sanitizeNavigateUrl } from "@/lib/computer-navigate"
import { PensandoBars } from "@/components/pensando-bars"
import { imagePoint, type ImageViewerStroke } from "@/lib/image-viewer"
import { IntegratedBrowserBar } from "@/components/chat/integrated-browser-bar"
import {
  CODE_PREVIEW_STATE_EVENT,
  type CodePreviewState,
  getActiveDepartmentSelection,
  CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT,
} from "@/lib/code-workspace-context"

function computerApiBase() {
  return getSameOriginApiBaseUrl().replace(/\/+$/, "")
}

type DockApp = "desktop" | "browser" | "files" | "terminal"

function isPresentationRepair(action: ComputerBrowserAction | null): boolean {
  return action?.type === "browser_present" || action?.type === "browser_resize"
}

/** Phases that mean the agent computer is still coming up / working. */
const IN_PROGRESS_PHASES = new Set(["starting", "loading", "building", "booting", "running"])

export type AgentComputerLiveStatus = "starting" | "live" | "error" | "idle"

export type AgentComputerShellProps = {
  /** The workspace main area (live preview + overlays) framed as one window. */
  children: React.ReactNode
  /** Chat/conversation id so dock focus hits that chat's desktop, not another. */
  conversationId?: string | null
  /** Overlay hides fake routines and uses session liveStatus instead of /code preview events. */
  variant?: "workspace" | "overlay"
  onClose?: () => void
  liveStatus?: AgentComputerLiveStatus
  /** Open focused on the live browser so the agent can search the web. */
  initialDock?: DockApp
  navigateUrl?: string
  autoNavigate?: boolean
  onAutoNavigationAttempt?: () => void
  cleanBrowser?: boolean
  browserSessionId?: string | null
  onBrowserModeChange?: (active: boolean) => void
  maximized?: boolean
  onToggleMaximize?: () => void
}

export function AgentComputerShell({
  children,
  conversationId,
  variant = "workspace",
  onClose,
  liveStatus,
  initialDock = "browser",
  navigateUrl = "",
  autoNavigate = true,
  onAutoNavigationAttempt,
  cleanBrowser = false,
  browserSessionId,
  onBrowserModeChange,
  maximized = false,
  onToggleMaximize,
}: AgentComputerShellProps) {
  const t = useTranslations("codex.panel.agentComputer")
  const [preview, setPreview] = React.useState<CodePreviewState | null>(null)
  const [routinesOpen, setRoutinesOpen] = React.useState(true)
  const [activeApp, setActiveApp] = React.useState<DockApp>(initialDock)
  const [focusNote, setFocusNote] = React.useState<string | null>(null)
  const [deptName, setDeptName] = React.useState<string>("")
  const browserVisible = cleanBrowser && activeApp === "browser"
  const [annotationMode, setAnnotationMode] = React.useState<"interact" | "draw">("interact")
  const [annotationStrokes, setAnnotationStrokes] = React.useState<ImageViewerStroke[]>([])
  const annotationSurface = React.useRef<SVGSVGElement | null>(null)
  const annotationPointer = React.useRef<{ id: number; index: number; count: number } | null>(null)
  const stopAnnotationStroke = React.useCallback(() => {
    const pointer = annotationPointer.current
    annotationPointer.current = null
    if (pointer && annotationSurface.current?.hasPointerCapture?.(pointer.id)) annotationSurface.current.releasePointerCapture(pointer.id)
  }, [])
  const clearAnnotations = React.useCallback(() => {
    stopAnnotationStroke()
    setAnnotationStrokes([])
  }, [stopAnnotationStroke])
  const resetAnnotations = React.useCallback(() => {
    clearAnnotations()
    setAnnotationMode("interact")
  }, [clearAnnotations])
  const [browserState, setBrowserState] = React.useState<ComputerBrowserState | null>(null)
  const [browserBusy, setBrowserBusy] = React.useState(false)
  const [viewportGeneration, setViewportGeneration] = React.useState(0)
  const [browserError, setBrowserError] = React.useState<string | null>(null)
  const browserBusyRef = React.useRef(false)
  const browserBackgroundResize = React.useRef(false)
  const browserEpoch = React.useRef(0)
  const browserMutation = React.useRef(0)
  const browserReadAbort = React.useRef<AbortController | null>(null)
  const retryBrowserAction = React.useRef<ComputerBrowserAction | null>(null)
  const confirmedViewport = React.useRef(browserState?.viewport)
  confirmedViewport.current = browserState?.viewport
  const browserOperations = React.useRef<Promise<unknown>>(Promise.resolve())
  const restoreBrowser = React.useRef<(() => Promise<boolean>) | null>(null)
  const desktopFocusRequest = React.useRef(0)
  React.useEffect(() => () => { desktopFocusRequest.current++ }, [conversationId, browserSessionId])
  const browserViewport = React.useRef<HTMLDivElement | null>(null)
  const viewportCallback = React.useRef(onBrowserModeChange)
  viewportCallback.current = onBrowserModeChange
  React.useEffect(() => { viewportCallback.current?.(browserVisible) }, [browserVisible])
  React.useEffect(() => { setActiveApp(initialDock) }, [conversationId, initialDock])

  // Presentation and restoration share a queue with user actions. In particular,
  // leaving during presentation restores only after the pending command settles.
  const queueBrowser = React.useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = browserOperations.current.then(operation, operation)
    browserOperations.current = pending.catch(() => undefined)
    return pending
  }, [])
  React.useEffect(() => {
    const epoch = ++browserEpoch.current
    setBrowserState(null)
    setBrowserError(null)
    retryBrowserAction.current = null
    setBrowserBusy(false)
    browserBusyRef.current = false
    browserBackgroundResize.current = false
    const chatId = conversationId?.trim() || ""
    if (!browserVisible || !browserSessionId) return
    let stopped = false
    let restoration: Promise<boolean> | null = null
    const restore = () => {
      if (!restoration) restoration = queueBrowser(() => actComputerBrowser(chatId, browserSessionId, { type: "browser_restore" }))
        .then(() => true)
        .catch(() => {
          // Static diagnostics only: never expose a URL, session, or server body.
          console.warn("[AgentComputerShell] browser_restore_failed")
          toast.error("No se pudo restaurar el escritorio. Abre el navegador e inténtalo de nuevo.")
          return false
        })
        .finally(() => { if (restoreBrowser.current === restore) restoreBrowser.current = null })
      return restoration
    }
    restoreBrowser.current = restore
    browserBusyRef.current = true
    setBrowserBusy(true)
    void queueBrowser(() => actComputerBrowser(chatId, browserSessionId, { type: "browser_present" }))
      .then((state) => {
        if (!stopped && browserEpoch.current === epoch) setBrowserState(state)
      })
      .catch(() => {
        if (!stopped && browserEpoch.current === epoch) {
          retryBrowserAction.current = { type: "browser_present" }
          setBrowserError("No se pudo conectar con el navegador. Inténtalo de nuevo.")
        }
      })
      .finally(() => {
        if (!stopped && browserEpoch.current === epoch) { browserBusyRef.current = false; setBrowserBusy(false) }
      })
    return () => {
      stopped = true
      if (browserEpoch.current === epoch) browserEpoch.current++
      browserBusyRef.current = false
      browserBackgroundResize.current = false
      // Keep the shared wait reachable by rapid dock changes until it settles.
      void restore()
    }
  }, [browserVisible, browserSessionId, conversationId, queueBrowser])

  const hasBrowserState = browserState !== null
  React.useEffect(() => {
    const chatId = conversationId?.trim() || ""
    if (!browserVisible || !hasBrowserState || !browserSessionId) return
    const epoch = browserEpoch.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const pull = async () => {
      if (stopped) return
      const mutation = browserMutation.current
      try {
        if (document.visibilityState !== "hidden" && !browserBusyRef.current) {
          const controller = new AbortController()
          browserReadAbort.current = controller
          const state = await readComputerBrowser(chatId, browserSessionId, controller.signal)
          if (!stopped && browserEpoch.current === epoch && browserMutation.current === mutation && !browserBusyRef.current) {
            setBrowserState(state)
            if (state.presentation === "desktop") {
              retryBrowserAction.current = { type: "browser_present" }
              setBrowserError("La vista del navegador necesita reconectarse. Pulsa Reintentar.")
            } else {
              setBrowserError((previous) => previous === "No se pudo actualizar el navegador. Inténtalo de nuevo." ? null : previous)
            }
          }
        }
      } catch {
        if (!stopped && browserEpoch.current === epoch && browserMutation.current === mutation) {
          retryBrowserAction.current ||= { type: "browser_present" }
          setBrowserError((previous) => previous || "No se pudo actualizar el navegador. Inténtalo de nuevo.")
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void pull(), 4000)
      }
    }
    timer = setTimeout(() => void pull(), 4000)
    return () => { stopped = true; clearTimeout(timer); browserReadAbort.current?.abort() }
  }, [browserVisible, hasBrowserState, conversationId, browserSessionId])

  const browserAction = React.useCallback(async (action: ComputerBrowserAction, recoverPresentation = false, backgroundResize = false) => {
    const chatId = conversationId?.trim() || ""
    if (!browserSessionId || (browserBusyRef.current && !browserBackgroundResize.current)) return null
    if (["browser_tab_create", "browser_tab_select", "browser_tab_close", "browser_back", "browser_forward", "browser_reload", "browser_restore"].includes(action.type)) resetAnnotations()
    const epoch = browserEpoch.current
    const mutation = ++browserMutation.current
    browserReadAbort.current?.abort()
    // A pending presentation repair must survive later commands that the
    // server refuses until the viewport is usable again.
    let pendingRepair = isPresentationRepair(retryBrowserAction.current) ? retryBrowserAction.current : null
    retryBrowserAction.current = pendingRepair
    browserBusyRef.current = true
    // Automatic sizing must not discard a URL entered between its start and end.
    // The first foreground command joins this queue and owns the busy state.
    browserBackgroundResize.current = backgroundResize && action.type === "browser_resize"
    setBrowserBusy(!browserBackgroundResize.current)
    if (!pendingRepair) setBrowserError(null)
    try {
      const state = await queueBrowser(async () => {
        if (browserEpoch.current !== epoch) throw new Error("La vista del navegador cambió")
        if (isPresentationRepair(retryBrowserAction.current)) pendingRepair = retryBrowserAction.current
        // An explicit retry can recover a partially restored framebuffer. Keep
        // both steps in this operation so no navigation can run between them.
        if (recoverPresentation && action.type === "browser_present") {
          await actComputerBrowser(chatId, browserSessionId, { type: "browser_restore" })
          if (browserEpoch.current !== epoch) throw new Error("La vista del navegador cambió")
        }
        return actComputerBrowser(chatId, browserSessionId, action)
      })
      if (action.type === "browser_resize" && (state.viewport?.width !== action.width || state.viewport?.height !== action.height)) {
        throw new Error("No se confirmó el tamaño del navegador")
      }
      if (browserEpoch.current === epoch) {
        setBrowserState(state)
        // Restore removes the old remote size. Measure again even if the local
        // panel has not moved since the last successful resize.
        if (recoverPresentation && action.type === "browser_present") setViewportGeneration((current) => current + 1)
        if (!pendingRepair || isPresentationRepair(action) || action.type === "browser_restore") {
          retryBrowserAction.current = null
          setBrowserError(null)
        }
        return state
      }
      return null
    } catch {
      if (browserEpoch.current === epoch) {
        retryBrowserAction.current = isPresentationRepair(action) ? action : pendingRepair || action
        setBrowserError("No se pudo completar la acción del navegador. Inténtalo de nuevo.")
      }
      return null
    } finally {
      if (browserEpoch.current === epoch && browserMutation.current === mutation) {
        browserBusyRef.current = false
        browserBackgroundResize.current = false
        setBrowserBusy(false)
      }
    }
  }, [conversationId, browserSessionId, queueBrowser, resetAnnotations])
  const browserNavigate = async (url: string) => {
    if (!browserSessionId || (browserBusyRef.current && !browserBackgroundResize.current)) throw new Error("Navegador ocupado")
    resetAnnotations()
    const epoch = browserEpoch.current
    const mutation = ++browserMutation.current
    browserReadAbort.current?.abort()
    // A pending presentation repair must survive later commands that the
    // server refuses until the viewport is usable again.
    const pendingRepair = isPresentationRepair(retryBrowserAction.current) ? retryBrowserAction.current : null
    retryBrowserAction.current = pendingRepair
    browserBusyRef.current = true
    browserBackgroundResize.current = false
    setBrowserBusy(true)
    if (!pendingRepair) setBrowserError(null)
    try {
      const result = await queueBrowser(async () => {
        if (browserEpoch.current !== epoch) throw new Error("La vista del navegador cambió")
        const actual = await postComputerNavigate(conversationId, url, browserState?.activeTabId || undefined, browserSessionId)
        const state = await readComputerBrowser(conversationId?.trim() || "", browserSessionId)
        return { actual, state }
      })
      if (browserEpoch.current !== epoch) throw new Error("La conversación cambió")
      setBrowserState(result.state)
      return result.actual
    } catch {
      if (browserEpoch.current === epoch) setBrowserError("No se pudo abrir la página. Revisa la dirección e inténtalo de nuevo.")
      throw new Error("No se pudo abrir la página")
    } finally {
      if (browserEpoch.current === epoch && browserMutation.current === mutation) {
        browserBusyRef.current = false
        browserBackgroundResize.current = false
        setBrowserBusy(false)
      }
    }
  }
  const navigateCallback = React.useRef(browserNavigate)
  navigateCallback.current = browserNavigate
  const lastAutoNavigation = React.useRef("")
  const autoAttemptCallback = React.useRef(onAutoNavigationAttempt)
  autoAttemptCallback.current = onAutoNavigationAttempt
  React.useEffect(() => {
    const parsed = sanitizeNavigateUrl(navigateUrl)
    const stamp = `${conversationId}::${navigateUrl}`
    if (!browserVisible || !hasBrowserState || browserBusy || !autoNavigate || !parsed.ok || lastAutoNavigation.current === stamp) return
    lastAutoNavigation.current = stamp
    autoAttemptCallback.current?.()
    void navigateCallback.current(parsed.url).catch(() => undefined) // browserNavigate exposes the failure above.
  }, [browserVisible, hasBrowserState, browserBusy, autoNavigate, navigateUrl, conversationId])

  // Resize the actual remote viewport, not a CSS crop. One request runs at a
  // time; resizing the panel replaces the pending size instead of building a queue.
  React.useEffect(() => {
    const host = browserViewport.current
    if (!browserVisible || !hasBrowserState || !host || typeof ResizeObserver === "undefined") return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let pending: { width: number; height: number } | null = null
    let applied = ""
    let failed = ""
    const flush = async () => {
      if (stopped || !pending) return
      if (browserBusyRef.current || document.visibilityState === "hidden") {
        timer = setTimeout(() => void flush(), 250)
        return
      }
      const size = pending
      pending = null
      const stamp = `${size.width}x${size.height}`
      if (stamp === applied || stamp === failed || (confirmedViewport.current?.width === size.width && confirmedViewport.current?.height === size.height)) return
      const state = await browserAction({ type: "browser_resize", ...size }, false, true)
      if (state?.viewport?.width === size.width && state.viewport.height === size.height) applied = stamp
      else failed = stamp
      if (!stopped && pending) timer = setTimeout(() => void flush(), 250)
    }
    const measure = () => {
      const rect = host.getBoundingClientRect()
      if (rect.width < 32 || rect.height < 32) return
      const scale = Math.min(1, 1920 / rect.width, 1080 / rect.height)
      pending = { width: Math.max(32, Math.floor(rect.width * scale)), height: Math.max(32, Math.floor(rect.height * scale)) }
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), 250)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    measure()
    return () => { stopped = true; clearTimeout(timer); observer.disconnect() }
  }, [browserVisible, hasBrowserState, browserAction, viewportGeneration])
  const activeBrowserTab = browserState?.tabs.find((tab) => tab.id === browserState.activeTabId)
  const emptyBrowser = browserVisible && browserState && (!activeBrowserTab || /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?|)$/.test(activeBrowserTab.url))

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

  const useSessionStatus = variant === "overlay" && liveStatus != null
  const isLive = useSessionStatus ? liveStatus === "live" : preview?.phase === "ready"
  const isInProgress = useSessionStatus
    ? liveStatus === "starting"
    : IN_PROGRESS_PHASES.has(preview?.phase ?? "")
  const isStarting = isInProgress
  const isError = useSessionStatus ? liveStatus === "error" : preview?.phase === "error"
  const statusPhase = useSessionStatus ? liveStatus : (preview?.phase ?? "idle")

  const annotationAvailable = Boolean(browserVisible && browserState && !emptyBrowser && isLive && !browserBusy && !browserError)
  React.useEffect(() => {
    resetAnnotations()
  }, [browserVisible, browserSessionId, conversationId, activeBrowserTab?.id, activeBrowserTab?.url, resetAnnotations])
  React.useEffect(() => {
    if (!annotationAvailable) { stopAnnotationStroke(); setAnnotationMode("interact"); return }
    if (annotationMode !== "draw") return
    annotationSurface.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
      stopAnnotationStroke()
      setAnnotationMode("interact")
    }
    window.addEventListener("keydown", escape, true)
    return () => { window.removeEventListener("keydown", escape, true); stopAnnotationStroke() }
  }, [annotationAvailable, annotationMode, stopAnnotationStroke])
  const beginAnnotation = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!annotationAvailable || annotationMode !== "draw" || event.button !== 0 || annotationPointer.current || annotationStrokes.length >= 64) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    event.preventDefault()
    const point = imagePoint(event.clientX, event.clientY, rect)
    annotationPointer.current = { id: event.pointerId, index: annotationStrokes.length, count: 1 }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setAnnotationStrokes((strokes) => [...strokes, { points: [point], color: "hsl(var(--celeste))", width: 2.5 }])
  }
  const continueAnnotation = (event: React.PointerEvent<SVGSVGElement>) => {
    const pointer = annotationPointer.current
    if (!pointer || pointer.id !== event.pointerId || pointer.count >= 256 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    event.preventDefault()
    const point = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
    pointer.count++
    setAnnotationStrokes((strokes) => strokes.map((stroke, index) => index === pointer.index ? { ...stroke, points: [...stroke.points, point] } : stroke))
  }

  const statusLabel = isLive
    ? t("status.live")
    : isInProgress
      ? t("status.starting")
      : isError
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
      const request = ++desktopFocusRequest.current
      const restore = restoreBrowser.current
      setActiveApp(app)
      if (cleanBrowser && app === "browser") return
      setFocusNote(null)
      try {
        const restored = !restore || await restore()
        if (request !== desktopFocusRequest.current) return
        if (!restored) { setFocusNote(t("dock.unavailable")); return }
        const response = await authenticatedFetch(`${computerApiBase()}/agent-computer/action`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            focus: app,
            ...(conversationId ? { conversationId } : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const result = await response.json().catch(() => null) as { ok?: unknown } | null
        if (request !== desktopFocusRequest.current) return
        if (!response.ok || result?.ok !== true) {
          setFocusNote(t("dock.unavailable"))
          return
        }
        setFocusNote(app === "browser" ? t("dock.focusedBrowser") : t("dock.focusedOther", { app }))
      } catch {
        if (request === desktopFocusRequest.current) setFocusNote(t("dock.unavailable"))
      }
    },
    [conversationId, t, cleanBrowser],
  )

  React.useEffect(() => {
    if (cleanBrowser && initialDock === "browser") return
    const willNavigate = initialDock === "browser" && autoNavigate && Boolean(conversationId?.trim())
      && sanitizeNavigateUrl(navigateUrl).ok
    if (!willNavigate && initialDock && initialDock !== "desktop") void focusApp(initialDock)
  }, [conversationId, initialDock, focusApp, autoNavigate, navigateUrl, cleanBrowser])

  return (
    <section
      className={cn("flex h-full min-h-0 min-w-0 flex-col", browserVisible ? "sira-browser-window bg-white dark:bg-zinc-950" : "bg-[#e8e8ea] dark:bg-[#101012]")}
      data-testid="agent-computer-shell"
      data-agent-computer-shell="1"
      data-conversation-id={conversationId || undefined}
      aria-label={t("title")}
    >
      {/* The browser uses real session controls; other desktop apps keep their existing chrome. */}
      {browserVisible ? <IntegratedBrowserBar browserControls={{
        state: browserState, busy: browserBusy || !browserSessionId, error: browserError || (liveStatus === "error" ? "La computadora no está disponible. Usa el botón Reintentar de la pantalla." : null),
        onAction: browserAction,
        onRetry: retryBrowserAction.current ? () => browserAction(retryBrowserAction.current!, retryBrowserAction.current?.type === "browser_present") : undefined,
        onNavigate: browserNavigate, onClose, onToggleMaximize, maximized,
        annotationMode, annotationAvailable, hasAnnotations: annotationStrokes.length > 0,
        onAnnotationModeChange: (mode) => { stopAnnotationStroke(); setAnnotationMode(mode === "draw" && annotationAvailable ? "draw" : "interact") },
        onClearAnnotations: clearAnnotations,
        onOpenDesktopApp: (app) => { resetAnnotations(); void focusApp(app) },
      }} /> : <div
        className="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-gradient-to-b from-white to-zinc-100 px-3 dark:border-white/10 dark:from-[#2a2a2c] dark:to-[#1b1b1d]"
        data-testid="agent-computer-chrome"
      >
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#c0c0c0]" />
          <span className="h-3 w-3 rounded-full bg-[#9c9c9c]" />
        </span>
        <span className="ml-1 hidden items-center gap-1 sm:flex" aria-hidden>
          <RefreshCw className={cn("h-3.5 w-3.5 text-zinc-400", isStarting && "animate-spin")} />
          <Square className="h-3 w-3 text-zinc-400" />
        </span>
        <div className="mx-auto flex h-7 min-w-0 max-w-xl flex-1 items-center justify-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          <IntegratedBrowserBar
            conversationId={conversationId}
            initialUrl={navigateUrl}
            autoNavigate={autoNavigate}
            onNavigated={() => {
              setActiveApp("browser")
              setFocusNote(t("dock.focusedBrowser"))
            }}
          />
          <span
            className={cn(
              "ml-1 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-semibold tracking-wide",
              isLive && "bg-emerald-500/15 uppercase text-emerald-600 dark:text-emerald-300",
              isInProgress && "bg-sky-500/15 text-sky-700 dark:text-sky-200",
              !isLive && !isInProgress && "uppercase bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
            )}
            data-testid="agent-computer-live-status"
            data-phase={statusPhase}
          >
            {isInProgress ? (
              <>
                <PensandoBars size={14} className="shrink-0" />
                <span data-testid="agent-computer-pensando-label">{statusLabel}</span>
              </>
            ) : (
              statusLabel
            )}
          </span>
        </div>
        <span className="hidden truncate text-[10px] text-zinc-400 md:block">
          {variant === "overlay" ? t("title") : deptName ? `${deptName} · ${t("title")}` : t("title")}
        </span>
        {onClose ? (
          <button
            type="button"
            className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/10 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            aria-label="Cerrar computadora"
            title="Cerrar computadora"
            data-testid={variant === "overlay" ? "chat-agent-computer-close" : "agent-computer-close"}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>}

      {/* Live viewport — the existing preview canvas, framed */}
      <div ref={browserViewport} data-testid="browser-viewport" className="relative min-h-0 min-w-0 flex-1">
        {children}
        {annotationAvailable || (browserVisible && annotationStrokes.length > 0) ? <svg
          ref={annotationSurface} viewBox="0 0 100 100" preserveAspectRatio="none" tabIndex={-1}
          aria-label="Anotaciones temporales de la página" data-testid="browser-annotations"
          className={cn("absolute inset-0 z-20 h-full w-full outline-none", annotationAvailable && annotationMode === "draw" ? "cursor-crosshair touch-none" : "pointer-events-none")}
          onPointerDown={beginAnnotation} onPointerMove={continueAnnotation}
          onPointerUp={(event) => { if (annotationPointer.current?.id === event.pointerId) stopAnnotationStroke() }}
          onPointerCancel={stopAnnotationStroke} onLostPointerCapture={() => { annotationPointer.current = null }}
        >{annotationStrokes.map((stroke, index) => <polyline key={index}
          points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={stroke.color}
          strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pointerEvents="none"
        />)}</svg> : null}
        {emptyBrowser ? <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-zinc-950" data-testid="browser-empty-state">
          <Globe className="h-7 w-7 text-zinc-400" aria-hidden />
          <h2 className="text-lg font-medium">Navega con SiraGPT</h2>
          <p className="max-w-sm text-sm leading-6 text-muted-foreground">Escribe una URL o pídele a SiraGPT que abra un sitio. Puedes navegar desde aquí.</p>
        </div> : null}
        {browserVisible && !browserState && !browserError && liveStatus !== "error" ? <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white text-sm text-muted-foreground dark:bg-zinc-950" role="status"><PensandoBars size={20} />Preparando navegador…</div> : null}
        {isInProgress && !browserVisible ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/50 dark:bg-black/40"
            data-testid="agent-computer-pensando"
            aria-live="polite"
          >
            <div className="flex flex-col items-center gap-2">
              <PensandoBars size={28} />
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                {statusLabel}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Rutinas — visible recurring work under the screen (workspace only) */}
      {variant === "overlay" ? null : (
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
      )}

      {/* OS-style dock */}
      {!browserVisible ? <nav
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
      </nav> : null}
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
