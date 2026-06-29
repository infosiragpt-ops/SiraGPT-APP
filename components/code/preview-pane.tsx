"use client"

/**
 * PreviewPane — embedded live browser for the /code workspace.
 *
 * Renders whatever is being built (HTML site, React/JSX app, Markdown, SVG)
 * inside a sandboxed iframe and refreshes as files change. A postMessage
 * bridge surfaces the previewed document's console + runtime errors so the
 * developer sees output without leaving the workspace.
 */

import * as React from "react"
import {
  Circle,
  Eraser,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  Smartphone,
  Square,
  TerminalSquare,
  X,
  Zap,
  ZapOff,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { buildPreviewDocument, projectNeedsDevServer, type PreviewKind } from "@/lib/code-preview-build"
import { CODE_TEMPLATES } from "@/lib/code-templates"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"
import { githubService } from "@/lib/github-service"
import { CODE_GIT_BINDING_CHANGED_EVENT, getGitBinding } from "@/lib/code-git-mirror"
import { buildRuntimeEnv } from "@/lib/code-secrets"

type LiveRun = { phase: "idle" | "starting" | "ready" | "error"; devUrl: string; note: string }
type RunnerStatus = { ready?: boolean; error?: string | null; framework?: string | null; tail?: string[]; devUrl?: string }

// Cap how many times a single failing run can auto-hand its logs to the chat
// agent for repair, so a fix that keeps failing can't spin an infinite loop.
const AUTO_FIX_MAX = 3

type LogEntry = { level: string; text: string; id: number }
type Device = "responsive" | "phone"

const CODE_RUN_PREVIEW_EVENT = "siragpt:code-run-preview"

const KIND_LABEL: Record<PreviewKind, string> = {
  html: "web",
  react: "react",
  markdown: "markdown",
  svg: "svg",
  unsupported: "—",
  empty: "—",
}

export function PreviewPane({ onClose }: { onClose?: () => void }) {
  const { files, activePath, activeFolder } = useCodeWorkspace()

  const [auto, setAuto] = React.useState(true)
  const [device, setDevice] = React.useState<Device>(() =>
    typeof window !== "undefined" && window.localStorage.getItem("code-workspace:preview-device") === "phone"
      ? "phone"
      : "responsive",
  )
  React.useEffect(() => {
    try {
      window.localStorage.setItem("code-workspace:preview-device", device)
    } catch {
      /* storage disabled — fail soft */
    }
  }, [device])
  const [tick, setTick] = React.useState(0)
  const [building, setBuilding] = React.useState(false)
  const [consoleOpen, setConsoleOpen] = React.useState(false)
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const logSeq = React.useRef(0)

  // Phase B — run a real Vite app and iframe it live via the no-Docker host
  // runner. The dev server stays private on the server; the browser reaches it
  // through the same-origin reverse proxy (/api/code-runner/<id>/app/).
  const [liveRun, setLiveRun] = React.useState<LiveRun>({ phase: "idle", devUrl: "", note: "" })
  const pollRef = React.useRef<number | null>(null)
  const runIdRef = React.useRef<string>("")
  const modeRef = React.useRef<"host" | "github">("host")
  const [gitBinding, setGitBinding] = React.useState<string | null>(() =>
    typeof window === "undefined" ? null : getGitBinding(activeFolder?.id ?? null),
  )

  const hasNodeProject = React.useMemo(
    () => Object.keys(files || {}).some((p) => /(^|\/)package\.json$/.test(p)),
    [files],
  )
  const canRunProject = hasNodeProject || Boolean(gitBinding)
  const projectSignature = React.useMemo(() => {
    if (!canRunProject) return ""
    // Fingerprint EVERY file by path + content length (not a fixed list of key
    // files), so an edit to any source file changes the signature. This is only
    // the dedupe fallback for non-forced auto triggers; agent results carry an
    // explicit force flag and bypass it entirely.
    const names = Object.keys(files || {}).sort()
    const fingerprint = names
      .map((path) => `${path}:${files[path]?.content?.length ?? 0}`)
      .join("|")
    return `${activeFolder?.id || "local"}:${gitBinding || "workspace"}:${fingerprint}`
  }, [activeFolder?.id, canRunProject, files, gitBinding])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const refreshBinding = () => setGitBinding(getGitBinding(activeFolder?.id ?? null))
    refreshBinding()
    window.addEventListener(CODE_GIT_BINDING_CHANGED_EVENT, refreshBinding)
    window.addEventListener("storage", refreshBinding)
    return () => {
      window.removeEventListener(CODE_GIT_BINDING_CHANGED_EVENT, refreshBinding)
      window.removeEventListener("storage", refreshBinding)
    }
  }, [activeFolder?.id])

  const clearPoll = React.useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const stopApp = React.useCallback(() => {
    clearPoll()
    setLiveRun({ phase: "idle", devUrl: "", note: "" })
    if (modeRef.current === "github" && runIdRef.current) void githubService.stop(runIdRef.current)
    else if (runIdRef.current) void hostRunnerService.stop(runIdRef.current)
  }, [clearPoll])

  // Poll a runner's status until the dev server is ready (or fails / times out).
  const pollUntilReady = React.useCallback(
    (statusFn: () => Promise<RunnerStatus>, fallbackUrl: string) => {
      clearPoll()
      let tries = 0
      pollRef.current = window.setInterval(async () => {
        tries += 1
        const st = await statusFn()
        if (st.ready) {
          clearPoll()
          setLiveRun({ phase: "ready", devUrl: st.devUrl || fallbackUrl, note: st.framework || "app" })
        } else if (st.error || tries > 80) {
          // ~3.3 min budget: a cold npm install of vite + tailwind v4 +
          // framer-motion + lucide plus dev-server boot can be slow.
          clearPoll()
          const note = st.error || "El dev server no arrancó a tiempo."
          // Keep the full tail so the auto-repair effect hands the agent real
          // build/runtime output, not just the one-line summary.
          lastErrorLogRef.current = [st.error, ...(st.tail || [])].filter(Boolean).join("\n") || note
          setLiveRun({ phase: "error", devUrl: "", note })
        } else {
          setLiveRun((p) => ({ ...p, note: (st.tail && st.tail[st.tail.length - 1]) || p.note }))
        }
      }, 2500)
    },
    [clearPoll],
  )

  const runApp = React.useCallback(async (opts?: { auto?: boolean }) => {
    const auto = opts?.auto ?? false
    setLiveRun({ phase: "starting", devUrl: "", note: "Instalando dependencias y arrancando el dev server…" })
    if (!runIdRef.current) {
      try {
        runIdRef.current = crypto.randomUUID()
      } catch {
        runIdRef.current = `run-${Math.random().toString(36).slice(2)}`
      }
    }
    const boundRepo = getGitBinding(activeFolder?.id ?? null)
    if (boundRepo) {
      modeRef.current = "github"
      runIdRef.current = boundRepo
      const runtimeEnv = buildRuntimeEnv(activeFolder?.id ?? null, files)
      const started = await githubService.run(boundRepo, runtimeEnv).catch((err) => ({ error: err instanceof Error ? err.message : "runner unreachable" }))
      if ("error" in started && started.error) {
        lastErrorLogRef.current = started.error
        setLiveRun({ phase: "error", devUrl: "", note: started.error })
        return
      }
      pollUntilReady(
        async () => {
          const st = await githubService.runStatus(boundRepo)
          return {
            ready: Boolean(st.ready || st.status === "ready"),
            error: st.error || null,
            framework: st.framework || st.kind || null,
            tail: st.tail,
            devUrl: st.previewUrl,
          }
        },
        "previewUrl" in started ? started.previewUrl || "" : "",
      )
      return
    }
    // Workspace files are CodeFile objects; the runner wants path -> content.
    const fileMap: Record<string, string> = {}
    for (const [p, f] of Object.entries(files)) fileMap[p] = f?.content ?? ""
    modeRef.current = "host"
    // No-Docker host runner: install deps + boot a real vite dev server, then
    // iframe it through the same-origin reverse proxy (started.devUrl).
    const runtimeEnv = buildRuntimeEnv(activeFolder?.id ?? null, files)
    const started = await hostRunnerService.start(fileMap, runIdRef.current, runtimeEnv)
    // An AUTO run (the agent just finished building) must degrade SILENTLY when
    // the runner can't even start — a disabled environment, or a user who isn't
    // on the allowlist (403 → started.error). Falling back to the static preview
    // is friendlier than slapping a red "no se pudo correr" over a preview the
    // user never asked to run. A manual ▶ Ejecutar still surfaces the reason.
    if (started.disabled) {
      if (auto) {
        setLiveRun({ phase: "idle", devUrl: "", note: "" })
        return
      }
      setLiveRun({
        phase: "error",
        devUrl: "",
        note: "El motor de ejecución está desactivado en este entorno. Para correr apps aquí hay que activar CODE_HOST_RUNNER.",
      })
      return
    }
    if (started.error) {
      if (auto) {
        setLiveRun({ phase: "idle", devUrl: "", note: "" })
        return
      }
      lastErrorLogRef.current = started.error
      setLiveRun({ phase: "error", devUrl: "", note: started.error })
      return
    }
    pollUntilReady(() => hostRunnerService.status(runIdRef.current), started.devUrl || "")
  }, [activeFolder?.id, files, pollUntilReady])

  // Mirror the latest values into refs so the auto-run listener (registered
  // once) and the post-commit auto-run effect always read FRESH state without
  // having to re-subscribe on every keystroke.
  const filesRef = React.useRef(files)
  filesRef.current = files
  const runAppRef = React.useRef(runApp)
  runAppRef.current = runApp
  const phaseRef = React.useRef(liveRun.phase)
  phaseRef.current = liveRun.phase
  const activeFolderIdRef = React.useRef<string | null>(activeFolder?.id ?? null)
  activeFolderIdRef.current = activeFolder?.id ?? null
  // A build that finishes while a previous boot is still installing can't restart
  // mid-install; we queue it here and fire once the in-flight run settles so the
  // preview always lands on the newest code.
  const pendingAutoRunRef = React.useRef(false)
  const lastAutoRunSignatureRef = React.useRef("")
  // An agent result carries force:true so the rerun fires even when the cheap
  // length-based signature didn't change (e.g. a same-length edit). Set by the
  // run-app listener, consumed (and cleared) by the auto-run effects below.
  const forceAutoRunRef = React.useRef(false)
  // Auto-repair bookkeeping: hand a failing run's logs to the chat agent so it
  // fixes the code itself. lastErrorLogRef holds the richest error text we have;
  // lastAutoFixedNoteRef de-dupes per distinct error; autoFixCountRef caps it.
  const autoFixCountRef = React.useRef(0)
  const lastAutoFixedNoteRef = React.useRef("")
  const lastErrorLogRef = React.useRef("")

  // The chat panel dispatches "siragpt:code-run-app" in the SAME tick as the
  // applyBlock() setState that writes the new files — so at event time the
  // workspace has not committed yet and reading `files` here would be stale.
  // For an AUTO run we therefore only bump a signal; the post-commit effect
  // below evaluates the gate against the freshly-committed workspace. A manual
  // trigger (▶ Ejecutar elsewhere / dev-server workflow) is not concurrent with
  // a build, so its files are already stable and it can run immediately.
  const [autoRunSignal, setAutoRunSignal] = React.useState(0)
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const queueAutoRun = () => setAutoRunSignal((s) => s + 1)
    const onRun = (e: Event) => {
      const detail = (e as CustomEvent).detail as { auto?: boolean; force?: boolean } | undefined
      const auto = detail?.auto ?? false
      if (auto) {
        if (detail?.force) forceAutoRunRef.current = true
        queueAutoRun()
        return
      }
      const hasRunnableProject =
        Object.keys(filesRef.current || {}).some((p) => /(^|\/)package\.json$/.test(p)) ||
        Boolean(getGitBinding(activeFolderIdRef.current))
      if (hasRunnableProject) {
        void runAppRef.current()
      }
    }
    window.addEventListener("siragpt:code-run-app", onRun)
    window.addEventListener(CODE_RUN_PREVIEW_EVENT, queueAutoRun)
    return () => {
      window.removeEventListener("siragpt:code-run-app", onRun)
      window.removeEventListener(CODE_RUN_PREVIEW_EVENT, queueAutoRun)
    }
  }, [])

  // Post-commit auto-run: runs once per build signal, AFTER React has committed
  // the new files (the signal bump batches with the applyBlock setState). Boot
  // the heavy dev server only for a real Vite/Next project the srcdoc preview
  // can't render; the deterministic Builder's self-contained index.html is
  // skipped so it never triggers an npm install.
  React.useEffect(() => {
    // Run on initial mount too (autoRunSignal === 0): a freshly cloned/opened
    // runnable project must auto-start its dev server WITHOUT a manual click.
    // The signature dedupe and the "starting" queue below prevent duplicate runs.
    const needsDevServer = projectNeedsDevServer(filesRef.current) || Boolean(getGitBinding(activeFolderIdRef.current))
    if (!canRunProject || !projectSignature || !needsDevServer) {
      // Workspace isn't runnable (e.g. static-only index.html) — drop any stale
      // force flag so it can't surprise a later run once it becomes runnable.
      forceAutoRunRef.current = false
      return
    }
    const forced = forceAutoRunRef.current
    if (!forced && lastAutoRunSignatureRef.current === projectSignature && phaseRef.current !== "error") return
    // Don't interrupt an install already in flight — queue a retry instead so
    // the newest code still shows once it settles (the force flag is preserved
    // and drained by the effect below).
    if (phaseRef.current === "starting") {
      pendingAutoRunRef.current = true
      return
    }
    forceAutoRunRef.current = false
    lastAutoRunSignatureRef.current = projectSignature
    void runAppRef.current({ auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunSignal, canRunProject, projectSignature])

  // Drain a queued auto-run once the in-flight boot settles (ready/error/idle).
  React.useEffect(() => {
    if (liveRun.phase === "starting") return
    if (!pendingAutoRunRef.current) return
    pendingAutoRunRef.current = false
    const needsDevServer = projectNeedsDevServer(filesRef.current) || Boolean(getGitBinding(activeFolderIdRef.current))
    if (!canRunProject || !projectSignature || !needsDevServer) {
      // Workspace isn't runnable (e.g. static-only index.html) — drop any stale
      // force flag so it can't surprise a later run once it becomes runnable.
      forceAutoRunRef.current = false
      return
    }
    const forced = forceAutoRunRef.current
    if (!forced && lastAutoRunSignatureRef.current === projectSignature && phaseRef.current !== "error") return
    forceAutoRunRef.current = false
    lastAutoRunSignatureRef.current = projectSignature
    void runAppRef.current({ auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRun.phase, canRunProject, projectSignature])

  // Auto-repair: when a run fails, hand the logs to the chat agent so it fixes
  // the code on its own (no manual "Reparar" click). Capped + de-duped so a fix
  // that keeps producing the same error can't spin an infinite agent loop. A
  // fresh successful run refills the budget for a later, unrelated failure.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (liveRun.phase === "ready") {
      autoFixCountRef.current = 0
      lastAutoFixedNoteRef.current = ""
      return
    }
    if (liveRun.phase !== "error") return
    const log = (lastErrorLogRef.current || liveRun.note || "").trim()
    if (!log || log === lastAutoFixedNoteRef.current) return
    if (autoFixCountRef.current >= AUTO_FIX_MAX) return
    lastAutoFixedNoteRef.current = log
    autoFixCountRef.current += 1
    window.dispatchEvent(new CustomEvent("siragpt:code-fix-error", { detail: { text: log } }))
  }, [liveRun.phase, liveRun.note])

  React.useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    },
    [],
  )

  // Debounce rebuilds so typing stays smooth; manual refresh bypasses it.
  const [snapshot, setSnapshot] = React.useState({ files, activePath })
  React.useEffect(() => {
    if (!auto) return
    setBuilding(true)
    const t = setTimeout(() => {
      setSnapshot({ files, activePath })
      setBuilding(false)
    }, 400)
    return () => clearTimeout(t)
  }, [files, activePath, auto])

  const result = React.useMemo(
    () => buildPreviewDocument(snapshot.files, snapshot.activePath),
    [snapshot],
  )
  const staticPreviewKey = React.useMemo(() => {
    let hash = 0
    for (let i = 0; i < result.html.length; i += 1) {
      hash = (hash * 31 + result.html.charCodeAt(i)) | 0
    }
    return `${tick}:${result.kind}:${result.entry ?? "none"}:${result.html.length}:${hash}`
  }, [result.entry, result.html, result.kind, tick])

  // Fresh document → clear the captured console.
  React.useEffect(() => {
    setLogs([])
  }, [result, tick])

  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (!m || m.type !== "sgpt-preview-console") return
      logSeq.current += 1
      const entry: LogEntry = { level: String(m.level || "log"), text: String(m.text ?? ""), id: logSeq.current }
      setLogs((prev) => (prev.length > 250 ? [...prev.slice(-250), entry] : [...prev, entry]))
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  const refresh = React.useCallback(() => {
    setSnapshot({ files, activePath })
    setTick((t) => t + 1)
  }, [files, activePath])

  const openInNewTab = React.useCallback(() => {
    if (typeof window === "undefined") return
    // NUNCA abrir el runner en vivo en una pestaña top-level: ahí no hay sandbox
    // y el código generado NO confiable correría con el origen real de SiraGPT
    // (acceso a localStorage/cookies/APIs). La app en vivo solo se ve dentro del
    // iframe aislado. Para la preview estática (HTML) sí abrimos un blob.
    if (liveRun.phase === "ready") return
    const blob = new Blob([result.html], { type: "text/html" })
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }, [liveRun.phase, result.html])

  const errorCount = logs.filter((l) => l.level === "error").length
  const entryLabel = result.entry ? result.entry.split("/").pop() : "preview"

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background/85 px-2 shadow-[0_1px_0_rgba(15,23,42,0.03)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
        <div className="flex items-center gap-1 pl-0.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        </div>

        <button
          type="button"
          onClick={refresh}
          className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Recargar preview"
          title="Recargar"
        >
          {building ? <ThinkingIndicator size="xs" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/50 bg-muted/25 px-3 py-1 text-[11px] text-muted-foreground shadow-inner">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#FF0000]" />
          <span className="truncate font-mono">localhost / {entryLabel}</span>
          <span className="ml-auto shrink-0 rounded bg-background/70 px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground/80">
            {KIND_LABEL[result.kind]}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <GlassToggle
            active={device === "responsive"}
            onClick={() => setDevice("responsive")}
            label="Escritorio"
          >
            <Monitor className="h-3.5 w-3.5" />
          </GlassToggle>
          <GlassToggle active={device === "phone"} onClick={() => setDevice("phone")} label="Móvil">
            <Smartphone className="h-3.5 w-3.5" />
          </GlassToggle>

          {/* Phase B — auto-run stays primary; manual run is available when idle/error. */}
          {canRunProject ? (
            <>
              <span className="mx-0.5 h-4 w-px bg-border/50" />
              {liveRun.phase === "ready" || liveRun.phase === "starting" ? (
                <button
                  type="button"
                  onClick={stopApp}
                  title="Detener el dev server"
                  className="flex h-6 items-center gap-1 rounded-md bg-[#FF0000]/[0.08] px-2 text-[11px] font-medium text-[#C80000] transition-colors hover:bg-[#FF0000]/[0.14] dark:text-[#FF6B6B]"
                >
                  {liveRun.phase === "starting" ? <ThinkingIndicator size="xs" /> : <Square className="h-3 w-3" />}
                  <span>{liveRun.phase === "starting" ? "Arrancando…" : "Detener"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runApp()}
                  title="Instalar dependencias y correr el app (npm)"
                  className="flex h-6 items-center gap-1 rounded-md bg-[#FF0000]/[0.08] px-2 text-[11px] font-medium text-[#C80000] transition-colors hover:bg-[#FF0000]/[0.14] dark:text-[#FF6B6B]"
                >
                  <Play className="h-3 w-3" />
                  <span>{gitBinding ? "Ejecutar repo" : "Ejecutar"}</span>
                </button>
              )}
            </>
          ) : null}

          <span className="mx-0.5 h-4 w-px bg-border/50" />

          <GlassToggle
            active={auto}
            onClick={() => setAuto((v) => !v)}
            label={auto ? "Auto-refresh activado" : "Auto-refresh desactivado"}
          >
            {auto ? <Zap className="h-3.5 w-3.5" /> : <ZapOff className="h-3.5 w-3.5" />}
          </GlassToggle>
          <GlassToggle
            active={consoleOpen}
            onClick={() => setConsoleOpen((v) => !v)}
            label="Consola"
          >
            <span className="relative flex items-center justify-center">
              <TerminalSquare className="h-3.5 w-3.5" />
              {errorCount > 0 ? (
                <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[8px] font-semibold text-white">
                  {errorCount > 9 ? "9+" : errorCount}
                </span>
              ) : null}
            </span>
          </GlassToggle>
          <button
            type="button"
            onClick={openInNewTab}
            disabled={liveRun.phase === "ready"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Abrir en pestaña nueva"
            title={liveRun.phase === "ready" ? "La app en vivo solo se ve aquí (aislada por seguridad)" : "Abrir en pestaña nueva"}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label="Cerrar preview"
              title="Cerrar preview"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Viewport */}
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-100 p-0 dark:bg-zinc-900/55">
        {liveRun.phase === "ready" ? (
          // Real running app from the cloud runner (npm dev server).
          <div
            className={cn(
              "mx-auto h-full bg-white transition-all dark:bg-zinc-900",
              device === "phone" && "my-3 h-[calc(100%-1.5rem)] max-w-[390px] overflow-hidden rounded-[28px] border-[6px] border-zinc-800 shadow-2xl",
            )}
          >
            <iframe
              src={liveRun.devUrl}
              title="App en vivo (dev server)"
              // El dev server se sirve same-origin (vía proxy /api/code-runner)
              // pero ejecuta CÓDIGO GENERADO NO CONFIABLE: el sandbox SIN
              // allow-same-origin lo aísla en un origen opaco para que no pueda
              // leer el localStorage/cookies de SiraGPT ni llamar a sus APIs.
              // allow="clipboard-write" mantiene navigator.clipboard.writeText
              // (p.ej. el botón Copiar del componente «Invitar al proyecto»).
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
              allow="clipboard-write"
              className="h-full w-full border-0 bg-white dark:bg-zinc-900"
            />
          </div>
        ) : liveRun.phase === "starting" ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <ThinkingIndicator size="sm" />
            <div>
              <p className="text-sm font-medium text-foreground">Compilando tu app…</p>
              <p className="mx-auto mt-1 max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">{liveRun.note}</p>
            </div>
          </div>
        ) : liveRun.phase === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-sm font-medium text-rose-500">Detecté un error — el asistente lo está revisando</p>
            <p className="mx-auto max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">{liveRun.note}</p>
            <button
              type="button"
              onClick={() => void runApp()}
              className="rounded-md bg-[#FF0000]/[0.08] px-3 py-1.5 text-[12px] font-medium text-[#C80000] hover:bg-[#FF0000]/[0.14] dark:text-[#FF6B6B]"
            >
              Reintentar manualmente
            </button>
          </div>
        ) : result.kind === "empty" || result.kind === "unsupported" ? (
          <PreviewLaunchpad kind={result.kind} note={result.note} />
        ) : (
          <div
            className={cn(
              "mx-auto h-full bg-white transition-all dark:bg-zinc-900",
              device === "phone" && "my-3 h-[calc(100%-1.5rem)] max-w-[390px] overflow-hidden rounded-[28px] border-[6px] border-zinc-800 shadow-2xl",
            )}
          >
            <iframe
              key={staticPreviewKey}
              srcDoc={result.html}
              title="Preview en vivo"
              className="h-full w-full border-0 bg-white dark:bg-zinc-900"
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
            />
          </div>
        )}
      </div>

      {/* Live console */}
      {consoleOpen ? (
        <div className="flex h-40 shrink-0 flex-col border-t border-border/40 bg-background/70 backdrop-blur-xl">
          <div className="flex h-7 shrink-0 items-center justify-between px-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <TerminalSquare className="h-3 w-3" /> Consola
              {errorCount > 0 ? <span className="text-rose-500">· {errorCount} error(es)</span> : null}
            </span>
            <button
              type="button"
              onClick={() => setLogs([])}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted/60 hover:text-foreground"
              title="Limpiar consola"
            >
              <Eraser className="h-3 w-3" /> Limpiar
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <p className="py-3 text-center text-muted-foreground/60">Sin salida todavía.</p>
            ) : (
              logs.map((l) => (
                <div
                  key={l.id}
                  className={cn(
                    "flex items-start gap-1.5 border-b border-border/20 py-0.5",
                    l.level === "error" && "text-rose-500",
                    l.level === "warn" && "text-amber-500",
                    (l.level === "log" || l.level === "info" || l.level === "debug") && "text-foreground/80",
                  )}
                >
                  <Circle className="mt-[5px] h-1.5 w-1.5 shrink-0 fill-current" />
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{l.text}</span>
                  {l.level === "error" ? (
                    <button
                      type="button"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("siragpt:code-fix-error", { detail: { text: l.text } }),
                        )
                      }
                      className="ml-auto shrink-0 rounded bg-rose-500/15 px-1.5 py-px text-[10px] font-medium text-rose-500 transition-colors hover:bg-rose-500/25"
                      title="Enviar este error al agente para que lo arregle"
                    >
                      Arreglar con IA
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PreviewLaunchpad({ kind, note }: { kind: PreviewKind; note?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {kind === "empty" ? "Tu preview en vivo" : "Este archivo no se previsualiza"}
        </p>
        <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
          {note || "Empieza desde una plantilla o pídele algo al agente — lo verás aquí al instante."}
        </p>
      </div>
      <div className="grid w-full max-w-xs gap-2">
        {CODE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("siragpt:code-load-template", { detail: { id: t.id } }))
            }
            className="flex flex-col items-start rounded-lg border border-border/60 bg-background px-4 py-3 text-left shadow-sm transition-colors hover:border-[#FF0000]/25 hover:bg-[#FF0000]/[0.04]"
          >
            <span className="text-[13px] font-medium text-foreground">{t.name}</span>
            <span className="text-[11px] text-muted-foreground">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function GlassToggle({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        active && "bg-[#FF0000]/[0.07] text-[#C80000] ring-1 ring-[#FF0000]/20 dark:text-[#FF6B6B]",
      )}
    >
      {children}
    </button>
  )
}
