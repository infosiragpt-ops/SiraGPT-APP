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
  Bot,
  Circle,
  Code2,
  Eraser,
  ExternalLink,
  FolderOpen,
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

type LiveRun = { phase: "idle" | "starting" | "ready" | "error"; devUrl: string; note: string }
type RunnerStatus = { ready?: boolean; error?: string | null; framework?: string | null; tail?: string[]; devUrl?: string }

type LogEntry = { level: string; text: string; id: number }
type Device = "responsive" | "phone"

const KIND_LABEL: Record<PreviewKind, string> = {
  html: "web",
  react: "react",
  markdown: "markdown",
  svg: "svg",
  unsupported: "—",
  empty: "—",
}

export function PreviewPane({ onClose }: { onClose?: () => void }) {
  const { files, activePath, openLocalFolderWorkspace } = useCodeWorkspace()

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

  const hasNodeProject = React.useMemo(
    () => Object.keys(files || {}).some((p) => /(^|\/)package\.json$/.test(p)),
    [files],
  )

  const clearPoll = React.useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const stopApp = React.useCallback(() => {
    clearPoll()
    setLiveRun({ phase: "idle", devUrl: "", note: "" })
    if (runIdRef.current) void hostRunnerService.stop(runIdRef.current)
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
          setLiveRun({ phase: "error", devUrl: "", note: st.error || "El dev server no arrancó a tiempo." })
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
    // Workspace files are CodeFile objects; the runner wants path -> content.
    const fileMap: Record<string, string> = {}
    for (const [p, f] of Object.entries(files)) fileMap[p] = f?.content ?? ""
    // No-Docker host runner: install deps + boot a real vite dev server, then
    // iframe it through the same-origin reverse proxy (started.devUrl).
    const started = await hostRunnerService.start(fileMap, runIdRef.current)
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
      setLiveRun({ phase: "error", devUrl: "", note: started.error })
      return
    }
    pollUntilReady(() => hostRunnerService.status(runIdRef.current), started.devUrl || "")
  }, [files, pollUntilReady])

  // Mirror the latest values into refs so the auto-run listener (registered
  // once) and the post-commit auto-run effect always read FRESH state without
  // having to re-subscribe on every keystroke.
  const filesRef = React.useRef(files)
  filesRef.current = files
  const runAppRef = React.useRef(runApp)
  runAppRef.current = runApp
  const phaseRef = React.useRef(liveRun.phase)
  phaseRef.current = liveRun.phase
  // A build that finishes while a previous boot is still installing can't restart
  // mid-install; we queue it here and fire once the in-flight run settles so the
  // preview always lands on the newest code.
  const pendingAutoRunRef = React.useRef(false)

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
    const onRun = (e: Event) => {
      const auto = ((e as CustomEvent).detail as { auto?: boolean } | undefined)?.auto ?? false
      if (auto) {
        setAutoRunSignal((s) => s + 1)
        return
      }
      if (Object.keys(filesRef.current || {}).some((p) => /(^|\/)package\.json$/.test(p))) {
        void runAppRef.current()
      }
    }
    window.addEventListener("siragpt:code-run-app", onRun)
    return () => window.removeEventListener("siragpt:code-run-app", onRun)
  }, [])

  // Post-commit auto-run: runs once per build signal, AFTER React has committed
  // the new files (the signal bump batches with the applyBlock setState). Boot
  // the heavy dev server only for a real Vite/Next project the srcdoc preview
  // can't render; the deterministic Builder's self-contained index.html is
  // skipped so it never triggers an npm install.
  React.useEffect(() => {
    if (autoRunSignal === 0) return
    if (!projectNeedsDevServer(filesRef.current)) return
    // Don't interrupt an install already in flight — queue a retry instead so
    // the newest code still shows once it settles.
    if (phaseRef.current === "starting") {
      pendingAutoRunRef.current = true
      return
    }
    void runAppRef.current({ auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunSignal])

  // Drain a queued auto-run once the in-flight boot settles (ready/error/idle).
  React.useEffect(() => {
    if (liveRun.phase === "starting") return
    if (!pendingAutoRunRef.current) return
    pendingAutoRunRef.current = false
    if (!projectNeedsDevServer(filesRef.current)) return
    void runAppRef.current({ auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRun.phase])

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
      {/* URL / control bar — liquid glass */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/40 bg-background/55 px-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/40">
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

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border/40 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground shadow-inner backdrop-blur">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/80" />
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

          {/* Phase B — run a real Node/Vite/Next app (npm install + dev server). */}
          {hasNodeProject ? (
            <>
              <span className="mx-0.5 h-4 w-px bg-border/50" />
              {liveRun.phase === "ready" || liveRun.phase === "starting" ? (
                <button
                  type="button"
                  onClick={stopApp}
                  title="Detener el dev server"
                  className="flex h-6 items-center gap-1 rounded-md bg-rose-500/15 px-2 text-[11px] font-medium text-rose-500 transition-colors hover:bg-rose-500/25"
                >
                  {liveRun.phase === "starting" ? <ThinkingIndicator size="xs" /> : <Square className="h-3 w-3" />}
                  <span>{liveRun.phase === "starting" ? "Arrancando…" : "Detener"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runApp()}
                  title="Instalar dependencias y correr el app (npm)"
                  className="flex h-6 items-center gap-1 rounded-md bg-[hsl(var(--accent-violet)/0.16)] px-2 text-[11px] font-medium text-[hsl(var(--accent-violet))] transition-colors hover:bg-[hsl(var(--accent-violet)/0.28)]"
                >
                  <Play className="h-3 w-3" />
                  <span>Ejecutar</span>
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
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-100/60 p-0 dark:bg-zinc-900/40">
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
            <p className="text-sm font-medium text-rose-500">No se pudo correr el app</p>
            <p className="mx-auto max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">{liveRun.note}</p>
            <button
              type="button"
              onClick={() => void runApp()}
              className="rounded-md bg-[hsl(var(--accent-violet)/0.16)] px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--accent-violet)/0.28)]"
            >
              Reintentar
            </button>
          </div>
        ) : result.kind === "empty" || result.kind === "unsupported" ? (
          <PreviewLaunchpad
            kind={result.kind}
            note={result.note}
            hasNodeProject={hasNodeProject}
            onRunApp={runApp}
            onOpenLocalFolder={() => void openLocalFolderWorkspace()}
          />
        ) : (
          <div
            className={cn(
              "mx-auto h-full bg-white transition-all dark:bg-zinc-900",
              device === "phone" && "my-3 h-[calc(100%-1.5rem)] max-w-[390px] overflow-hidden rounded-[28px] border-[6px] border-zinc-800 shadow-2xl",
            )}
          >
            <iframe
              key={tick}
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

function PreviewLaunchpad({
  kind,
  note,
  hasNodeProject,
  onRunApp,
  onOpenLocalFolder,
}: {
  kind: PreviewKind
  note?: string
  hasNodeProject?: boolean
  onRunApp?: () => void
  onOpenLocalFolder?: () => void
}) {
  const openAgent = React.useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("siragpt:code-agent-prompt", {
        detail: {
          mode: "app",
          prompt: "Quiero construir una app web completa. Ayúdame como ingeniero: hazme las preguntas necesarias y luego genera el proyecto con preview.",
        },
      }),
    )
  }, [])

  const openFiles = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent("siragpt:code-open-tool", { detail: { toolId: "files" } }))
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {kind === "empty" ? "Tu app aparecerá aquí" : "Este archivo no es una pantalla web"}
        </p>
        <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
          {note || "Empieza desde una plantilla o pídele algo al agente — lo verás aquí al instante."}
        </p>
      </div>
      <div className="grid w-full max-w-sm gap-2">
        <button
          type="button"
          onClick={openAgent}
          className="flex items-center gap-3 rounded-xl border border-[hsl(var(--accent-violet)/0.28)] bg-[hsl(var(--accent-violet)/0.10)] px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--accent-violet)/0.16)]"
        >
          <Bot className="h-4 w-4 shrink-0 text-[hsl(var(--accent-violet))]" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground">Construir con Agent</span>
            <span className="block text-[11px] text-muted-foreground">Describe una idea y el agente crea archivos, preview y siguientes pasos.</span>
          </span>
        </button>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={onOpenLocalFolder}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground"
          >
            <FolderOpen className="h-4 w-4" />
            Carpeta local
          </button>
          <button
            type="button"
            onClick={openFiles}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground"
          >
            <Code2 className="h-4 w-4" />
            Archivos
          </button>
          <button
            type="button"
            onClick={onRunApp}
            disabled={!hasNodeProject}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Play className="h-4 w-4" />
            Ejecutar
          </button>
        </div>
        {CODE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("siragpt:code-load-template", { detail: { id: t.id } }))
            }
            className="flex flex-col items-start rounded-xl border border-border/50 bg-background/60 px-4 py-3 text-left backdrop-blur transition-colors hover:border-border hover:bg-muted/40"
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
        active && "bg-foreground/[0.07] text-foreground ring-1 ring-border/40",
      )}
    >
      {children}
    </button>
  )
}
