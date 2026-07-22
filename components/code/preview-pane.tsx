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
  ChevronLeft,
  ChevronRight,
  Circle,
  Eraser,
  ExternalLink,
  LayoutGrid,
  Lock,
  Monitor,
  MonitorSmartphone,
  MousePointer2,
  Play,
  RefreshCw,
  RotateCw,
  Smartphone,
  Square,
  Tablet,
  TerminalSquare,
  Zap,
  ZapOff,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  CODE_OPEN_TOOL_EVENT,
  CODE_PREVIEW_STATE_EVENT,
  getActiveCodexProject,
  setActiveCodexProject,
  setActiveHostRunId,
  type CodePreviewState,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import { codexApi } from "@/lib/codex/codex-api"
import { ensureCodexPreviewOrigin } from "@/lib/codex/use-codex-health"
import { buildPreviewDocument, projectNeedsDevServer, type PreviewKind } from "@/lib/code-preview-build"
import { CODE_TEMPLATES } from "@/lib/code-templates"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"
import { githubService } from "@/lib/github-service"
import { CODE_GIT_BINDING_CHANGED_EVENT, getGitBinding } from "@/lib/code-git-mirror"
import { buildRuntimeEnv } from "@/lib/code-secrets"
import {
  CODE_SELECT_TARGET_EVENT,
  CODE_SELECTION_CANCEL_EVENT,
  CODE_SELECTION_CAPTURED_EVENT,
  type CodePreviewSelectionCancelDetail,
  type CodePreviewSelectionDetail,
} from "@/lib/code-preview-selection"

type LiveRun = { phase: "idle" | "starting" | "ready" | "error" | "stuck"; devUrl: string; note: string }
type RunnerStatus = { ready?: boolean; error?: string | null; framework?: string | null; tail?: string[]; devUrl?: string }

// Cap how many times a single failing run can auto-hand its logs to the chat
// agent for repair, so a fix that keeps failing can't spin an infinite loop.
// The runner/backend speaks raw snake_case error codes (project_not_found,
// not_ready, econnrefused…) — Replit never leaks those to the user. Map the
// known ones to a friendly Spanish line; for anything unrecognised, keep a
// real message but strip a bare snake_case token so the panel never shows a
// naked code. A dev-server log tail (multi-line / has spaces+punctuation) is
// passed through untouched — that IS the useful signal.
const PREVIEW_ERROR_LABELS: Record<string, string> = {
  project_not_found: "El proyecto ya no está en el servidor. Lo estoy recreando…",
  run_not_found: "La sesión de ejecución expiró. Reiniciando…",
  not_ready: "La app todavía se está preparando.",
  forbidden: "Este entorno no tiene permitido ejecutar apps aquí.",
  disabled: "El motor de ejecución está desactivado en este entorno.",
  runner_unreachable: "No pude contactar al motor de ejecución. Reintenta en un momento.",
  "runner unreachable": "No pude contactar al motor de ejecución. Reintenta en un momento.",
  timeout: "El dev server tardó demasiado en arrancar.",
}
function humanizePreviewError(raw?: string | null): string {
  const value = String(raw ?? "").trim()
  if (!value) return "Algo salió mal al arrancar la app. Reintenta."
  const key = value.toLowerCase()
  if (PREVIEW_ERROR_LABELS[key]) return PREVIEW_ERROR_LABELS[key]
  // A lone code token (single word, snake/kebab, no spaces) → generic message.
  if (/^[a-z0-9]+([_-][a-z0-9]+)+$/i.test(value)) {
    return "No pude arrancar la app (" + value.replace(/[_-]+/g, " ") + "). Reintenta."
  }
  return value
}
// A dead remote project/run: the codex mapping is stale (project wiped, or
// created in another session). Self-heal by dropping the mapping and re-running
// locally instead of showing a scary error.
// Infrastructure / provisioning failures (runner down, project gone, env
// disabled, forbidden) are NOT code bugs — handing them to the chat agent
// wastes a repair cycle (it can't edit its way out of a missing runner). The
// self-heal handles the recoverable ones; the rest are honest terminal states.
function isInfraError(raw?: string | null): boolean {
  return /project_not_found|run_not_found|not[_ ]?found|\b404\b|forbidden|disabled|runner[_ ]?unreachable|desactivado en este entorno|no pude contactar al motor/i.test(
    String(raw ?? ""),
  )
}
function isDeadCodexProject(raw?: string | null): boolean {
  return /project_not_found|run_not_found|not[_ ]?found|404/i.test(String(raw ?? ""))
}

const AUTO_FIX_MAX = 3

// Bump the runner's lastTouch (and catch a post-ready crash) while the app is
// live so the idle reaper never kills an app the user is actively viewing.
const READY_HEARTBEAT_MS = 60_000

// Codex previews are served from a SIBLING origin (a Caddy vhost that exposes
// ONLY the tokenized preview proxy; the backend advertises it via /health's
// previewOrigin — env CODEX_PREVIEW_ORIGIN). The generated app then runs with
// its own browser origin — full module loading and localStorage for the app,
// zero access to siragpt.com cookies/storage/APIs — which lets the live
// iframe drop the sandbox attribute (whose opaque origin broke Vite module
// fetches AND localStorage). Replit's isolation model. Empty string (origin
// unset / probe failed / same as ours) → same-origin URL, sandbox stays on.
// Await-based: runApp fires on mount and must not race the health probe.
async function codexPreviewOrigin(): Promise<string> {
  const origin = await ensureCodexPreviewOrigin()
  if (!origin) return ""
  if (typeof window !== "undefined" && origin === window.location.origin) return ""
  return origin
}

type LogEntry = { level: string; text: string; id: number }
type Device = "responsive" | "tablet" | "phone"
type Orientation = "portrait" | "landscape"

// Nominal device viewports (portrait); the rotate toggle swaps w/h. "responsive"
// stretches to the pane so it has no fixed readout dimensions.
const DEVICE_VIEWPORTS: Record<Exclude<Device, "responsive">, { w: number; h: number; label: string }> = {
  tablet: { w: 820, h: 1180, label: "Tablet" },
  phone: { w: 390, h: 844, label: "Móvil" },
}

// Collapse a noisy runner error to a stable signature so repeated failures that
// only differ by line numbers / paths / hashes de-dupe against each other and
// don't burn the auto-fix budget on what is really the same error.
function normalizeErrorSignature(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s:]+|[./][^\s:]+/g, "<path>") // file paths
    .replace(/:\d+(:\d+)?/g, ":<n>") // :line:col
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>") // hex addresses
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>") // sha-ish hashes
    .replace(/\b\d+\b/g, "<n>") // bare numbers
    .replace(/\s+/g, " ")
    .trim()
}

const CODE_RUN_PREVIEW_EVENT = "siragpt:code-run-preview"

const KIND_LABEL: Record<PreviewKind, string> = {
  html: "web",
  react: "react",
  markdown: "markdown",
  svg: "svg",
  unsupported: "—",
  empty: "—",
}

export function PreviewPane() {
  const { files, activePath, activeFolder } = useCodeWorkspace()

  const [auto, setAuto] = React.useState(true)
  // v2 key: the Replit-style layout defaults everyone back to the full-width
  // responsive viewport; the old key could pin stale phone/tablet choices.
  const [device, setDevice] = React.useState<Device>(() => {
    if (typeof window === "undefined") return "responsive"
    const saved = window.localStorage.getItem("code-workspace:preview-device.v2")
    return saved === "phone" || saved === "tablet" ? saved : "responsive"
  })
  const [orientation, setOrientation] = React.useState<Orientation>("portrait")
  const [deviceMenuOpen, setDeviceMenuOpen] = React.useState(false)
  // Editable address bar: a sub-route ("/", "/about"…) appended to the live dev
  // server URL. Enter re-points the iframe. Only meaningful while an app is live.
  const [navPath, setNavPath] = React.useState("/")
  const [pathDraft, setPathDraft] = React.useState("/")
  React.useEffect(() => {
    try {
      window.localStorage.setItem("code-workspace:preview-device.v2", device)
    } catch {
      /* storage disabled — fail soft */
    }
  }, [device])
  const [tick, setTick] = React.useState(0)
  const [building, setBuilding] = React.useState(false)
  const [consoleOpen, setConsoleOpen] = React.useState(false)
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const logSeq = React.useRef(0)
  const previewFrameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [selectionFallback, setSelectionFallback] = React.useState(false)
  const selectionReadyRef = React.useRef(false)
  const selectionTimersRef = React.useRef<number[]>([])
  const previewMetaRef = React.useRef<{
    activePath: string | null
    activeFolderId: string | null
    entry: string | null
    previewKind: string
    liveSrc: string
    isLive: boolean
  }>({
    activePath: null,
    activeFolderId: null,
    entry: null,
    previewKind: "empty",
    liveSrc: "",
    isLive: false,
  })

  // Phase B — run a real Vite app and iframe it live via the no-Docker host
  // runner. The dev server stays private on the server; the browser reaches it
  // through the same-origin reverse proxy (/api/code-runner/<id>/app/).
  const [liveRun, setLiveRun] = React.useState<LiveRun>({ phase: "idle", devUrl: "", note: "" })
  const pollRef = React.useRef<number | null>(null)
  const runIdRef = React.useRef<string>("")
  const modeRef = React.useRef<"host" | "github" | "codex">("host")
  // Guards the codex self-heal so a genuinely-gone project can't loop forever:
  // one transparent local re-run per manual/auto trigger, reset on success/idle.
  const codexSelfHealedRef = React.useRef(false)
  const [gitBinding, setGitBinding] = React.useState<string | null>(() =>
    typeof window === "undefined" ? null : getGitBinding(activeFolder?.id ?? null),
  )

  const clearSelectionTimers = React.useCallback(() => {
    for (const timer of selectionTimersRef.current) window.clearTimeout(timer)
    selectionTimersRef.current = []
  }, [])

  const hasNodeProject = React.useMemo(
    () => Object.keys(files || {}).some((p) => /(^|\/)package\.json$/.test(p)),
    [files],
  )
  // A codex-backed chat is runnable even when the local mirror is partial —
  // the real workspace (with its package.json) lives in the codex runner.
  const canRunProject = hasNodeProject || Boolean(gitBinding) || Boolean(getActiveCodexProject())
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
    if (modeRef.current === "codex") {
      const codexProjectId = getActiveCodexProject()
      if (codexProjectId) void codexApi.stopPreview(codexProjectId).catch(() => {})
    } else if (modeRef.current === "github" && runIdRef.current) void githubService.stop(runIdRef.current)
    else if (runIdRef.current) void hostRunnerService.stop(runIdRef.current)
    // The Shell tool loses its exec target when the run stops.
    setActiveHostRunId(null)
  }, [clearPoll])

  // While the app is live, keep polling status at a slow cadence (a) so the
  // runner's lastTouch keeps getting bumped and the idle reaper never kills an
  // app the user is actively viewing, and (b) so a crash that happens AFTER the
  // dev server first went ready surfaces as an error instead of a frozen iframe.
  const startReadyHeartbeat = React.useCallback(
    (statusFn: () => Promise<RunnerStatus>) => {
      clearPoll()
      pollRef.current = window.setInterval(async () => {
        const st = await statusFn()
        if (st.error) {
          clearPoll()
          const rawNote = st.error || "El dev server se cayó."
          lastErrorLogRef.current = [st.error, ...(st.tail || [])].filter(Boolean).join("\n") || rawNote
          setLiveRun({ phase: "error", devUrl: "", note: humanizePreviewError(rawNote) })
        }
        // A benign not-ready blip (HMR reload) is ignored — we only react to a
        // hard error; the mere status read already bumped lastTouch.
      }, READY_HEARTBEAT_MS)
    },
    [clearPoll],
  )

  // Poll a runner's status until the dev server is ready (or fails / times out).
  const pollUntilReady = React.useCallback(
    (statusFn: () => Promise<RunnerStatus>, fallbackUrl: string) => {
      clearPoll()
      let tries = 0
      pollRef.current = window.setInterval(async () => {
        tries += 1
        const st = await statusFn()
        if (st.ready) {
          codexSelfHealedRef.current = false
          setLiveRun({ phase: "ready", devUrl: st.devUrl || fallbackUrl, note: st.framework || "app" })
          startReadyHeartbeat(statusFn)
        } else if (st.error || tries > 80) {
          // ~3.3 min budget: a cold npm install of vite + tailwind v4 +
          // framer-motion + lucide plus dev-server boot can be slow.
          clearPoll()
          const rawNote = st.error || "El dev server no arrancó a tiempo."
          // Keep the full tail so the auto-repair effect hands the agent real
          // build/runtime output, not just the one-line summary.
          lastErrorLogRef.current = [st.error, ...(st.tail || [])].filter(Boolean).join("\n") || rawNote
          setLiveRun({ phase: "error", devUrl: "", note: humanizePreviewError(rawNote) })
        } else {
          setLiveRun((p) => ({ ...p, note: (st.tail && st.tail[st.tail.length - 1]) || p.note }))
        }
      }, 2500)
    },
    [clearPoll, startReadyHeartbeat],
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
        setLiveRun({ phase: "error", devUrl: "", note: humanizePreviewError(started.error) })
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
    // Codex-backed chat: the real workspace lives in the codex runner, so run
    // it THERE and iframe the tokenized proxy — from the SIBLING preview
    // origin when available (see codexPreviewOrigin), so the app runs
    // unsandboxed with its own origin/storage. Pushing the local virtual FS
    // to the host runner would boot a stale/partial copy (and the host runner
    // is owner-gated anyway — this path works for every user).
    const codexProjectId = getActiveCodexProject()
    if (codexProjectId) {
      modeRef.current = "codex"
      const previewOrigin = await codexPreviewOrigin()
      const toDevUrl = (basePath?: string | null) => (basePath ? `${previewOrigin}${basePath}` : "")
      const codexStatus = async (): Promise<RunnerStatus> => {
        const st: any = await codexApi.previewStatus(codexProjectId).catch(() => null)
        const p = st?.previewStatus || st || {}
        return {
          ready: Boolean(p.ready),
          error: p.error || null,
          framework: p.framework || null,
          tail: p.tail,
          devUrl: toDevUrl(p.basePath),
        }
      }
      const started: any = await codexApi.startPreview(codexProjectId).catch((err) => ({
        error: err instanceof Error ? err.message : "runner unreachable",
      }))
      if (started?.error) {
        // Self-heal: a stale codex mapping (project wiped / another session)
        // 404s here. Drop it and re-run locally ONCE so the preview just works
        // (Replit never shows a dead project) instead of a scary raw code.
        if (isDeadCodexProject(started.error) && !codexSelfHealedRef.current) {
          codexSelfHealedRef.current = true
          setActiveCodexProject(null)
          // Static app (index.html, no dev server) → the built-in static
          // preview renders it directly; go idle to reveal it. A dev-server
          // project (Vite/Next) re-runs locally via the host runner.
          if (!projectNeedsDevServer(files)) {
            setLiveRun({ phase: "idle", devUrl: "", note: "" })
            return
          }
          modeRef.current = "host"
          setLiveRun({ phase: "starting", devUrl: "", note: "Recuperando el proyecto…" })
          await runAppRef.current({ auto })
          return
        }
        // Unlike the host path, do NOT silently degrade on auto: the srcdoc
        // fallback cannot render a multi-file Vite workspace (black screen) —
        // an honest error banner beats a dead preview.
        lastErrorLogRef.current = String(started.error)
        setLiveRun({ phase: "error", devUrl: "", note: humanizePreviewError(started.error) })
        return
      }
      pollUntilReady(codexStatus, toDevUrl(started?.previewStatus?.basePath || started?.basePath))
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
      setLiveRun({ phase: "error", devUrl: "", note: humanizePreviewError(started.error) })
      return
    }
    // Host run is live → the Shell tool can now exec real commands against it.
    setActiveHostRunId(runIdRef.current)
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
  // Post-boot functional verification (Replit-style "does it actually work?").
  // Separate budget/dedup from the build-error auto-repair above so a blank /
  // crashed-but-compiling app also gets auto-fixed, without the two loops
  // fighting over one counter. verifiedRuntimeRef gates one check per ready.
  const verifiedRuntimeRef = React.useRef(false)
  const verifyFixCountRef = React.useRef(0)
  const lastVerifyNoteRef = React.useRef("")

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
    const needsDevServer = projectNeedsDevServer(filesRef.current) || Boolean(getGitBinding(activeFolderIdRef.current)) || Boolean(getActiveCodexProject())
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
    const needsDevServer = projectNeedsDevServer(filesRef.current) || Boolean(getGitBinding(activeFolderIdRef.current)) || Boolean(getActiveCodexProject())
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

  // Post-ready type verification: the readiness probe proves the dev server
  // answers; tsc --noEmit proves the TypeScript actually compiles. One verify
  // per ready transition (host runner only); failures feed the SAME capped +
  // de-duped auto-repair channel below, so the agent fixes type errors too.
  const verifiedReadyRef = React.useRef(false)
  const [typeCheck, setTypeCheck] = React.useState<null | "checking" | "clean" | { errors: number }>(null)

  // Auto-repair: when a run fails, hand the logs to the chat agent so it fixes
  // the code on its own (no manual "Reparar" click). Capped + de-duped so a fix
  // that keeps producing the same error can't spin an infinite agent loop. A
  // fresh successful run refills the budget for a later, unrelated failure.
  // Once the budget is exhausted we stop pretending the agent is still working
  // and flip to a terminal "stuck" state with an honest message + the log tail.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (liveRun.phase === "ready") {
      autoFixCountRef.current = 0
      lastAutoFixedNoteRef.current = ""
      if (modeRef.current === "host" && !verifiedReadyRef.current) {
        verifiedReadyRef.current = true
        const runId = runIdRef.current
        let cancelled = false
        setTypeCheck("checking")
        hostRunnerService.verify(runId).then((v) => {
          if (cancelled || phaseRef.current !== "ready" || runIdRef.current !== runId) return
          const errs = Array.isArray(v?.errors) ? v.errors : []
          if (v?.skipped) { setTypeCheck(null); return }
          if (v?.ok && errs.length === 0) { setTypeCheck("clean"); return }
          setTypeCheck({ errors: errs.length })
          const text = [
            `La app arrancó pero la verificación de tipos (tsc --noEmit) encontró ${errs.length} error(es):`,
            ...errs.slice(0, 12).map((e) => `${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`),
          ].join("\n")
          if (text !== lastAutoFixedNoteRef.current && autoFixCountRef.current < AUTO_FIX_MAX) {
            lastAutoFixedNoteRef.current = text
            autoFixCountRef.current += 1
            window.dispatchEvent(new CustomEvent("siragpt:code-fix-error", { detail: { text } }))
          }
        })
        return () => { cancelled = true }
      }
      return
    }
    verifiedReadyRef.current = false
    setTypeCheck(null)
    if (liveRun.phase !== "error") return
    const log = (lastErrorLogRef.current || liveRun.note || "").trim()
    if (!log) return
    // Infrastructure errors aren't code bugs — never hand them to the agent
    // (the self-heal already retried the recoverable ones).
    if (isInfraError(log)) return
    // De-dupe on a NORMALIZED signature (line numbers / paths / hashes stripped)
    // so a fix that keeps producing "the same" error — even if a line moved —
    // doesn't re-arm the agent, and correctly counts toward the budget.
    const signature = normalizeErrorSignature(log)
    if (autoFixCountRef.current >= AUTO_FIX_MAX) {
      // Budget spent: go terminal-honest instead of a misleading "revisando".
      setLiveRun((p) => (p.phase === "stuck" ? p : { ...p, phase: "stuck" }))
      return
    }
    if (signature === lastAutoFixedNoteRef.current) return
    lastAutoFixedNoteRef.current = signature
    autoFixCountRef.current += 1
    window.dispatchEvent(new CustomEvent("siragpt:code-fix-error", { detail: { text: log } }))
  }, [liveRun.phase, liveRun.note])

  // Manual "Reintentar" from the stuck state: refill the auto-fix budget and
  // re-run so the user can try again after editing the code themselves.
  const retryFromStuck = React.useCallback(() => {
    autoFixCountRef.current = 0
    lastAutoFixedNoteRef.current = ""
    void runApp()
  }, [runApp])

  // Replit-style functional verification: once the dev server is `ready`, drive
  // it through headless chromium (server-side) and, if the app booted but does
  // NOT actually render (blank / error-overlay / JS crash / missing required
  // element), hand those findings to the chat agent so it self-repairs — WITHOUT
  // hiding the (broken) preview. One check per ready session; own capped +
  // de-duped budget so it never fights the build-error loop above or spins.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (liveRun.phase !== "ready" || modeRef.current !== "host") {
      verifiedRuntimeRef.current = false
      return
    }
    if (verifiedRuntimeRef.current) return
    verifiedRuntimeRef.current = true
    const runId = runIdRef.current
    if (!runId) return
    let cancelled = false
    void hostRunnerService.verifyRuntime(runId).then((v) => {
      if (cancelled || phaseRef.current !== "ready" || runIdRef.current !== runId) return
      if (!v || v.skipped || v.ok) return
      const problems =
        v.errors && v.errors.length
          ? v.errors
          : (v.findings || []).filter((f) => f.severity === "error").map((f) => f.message)
      if (!problems.length) return
      const text = [
        "La app arrancó pero la verificación en vivo encontró problemas que hay que arreglar:",
        ...problems.slice(0, 8).map((p) => `- ${p}`),
      ].join("\n")
      if (text === lastVerifyNoteRef.current || verifyFixCountRef.current >= AUTO_FIX_MAX) return
      lastVerifyNoteRef.current = text
      verifyFixCountRef.current += 1
      window.dispatchEvent(new CustomEvent("siragpt:code-fix-error", { detail: { text } }))
    })
    return () => {
      cancelled = true
    }
  }, [liveRun.phase])

  // Lifecycle cleanup: stop the dev server when the pane unmounts AND on
  // "pagehide" (tab close / navigation). Without this the runner is orphaned
  // until the 30-min idle reaper — enough leaked dev servers can hit
  // capacity_full. On pagehide a normal fetch would be cancelled, so we fire a
  // keepalive navigator.sendBeacon straight at the host runner's /stop.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const beaconStop = () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      // GitHub-backed runs are shut down by githubService.stop on unmount; the
      // keepalive beacon only targets the same-origin host runner.
      if (modeRef.current !== "host" || !runIdRef.current) return
      try {
        const base = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/code-runner`
        const url = `${base}/${encodeURIComponent(runIdRef.current)}/stop`
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          navigator.sendBeacon(url)
        }
      } catch {
        /* best-effort — the idle reaper is the safety net */
      }
    }
    window.addEventListener("pagehide", beaconStop)
    return () => {
      window.removeEventListener("pagehide", beaconStop)
      if (pollRef.current) window.clearInterval(pollRef.current)
      // Component teardown (e.g. switching away from the preview): actively stop
      // the dev server instead of leaking it to the reaper.
      if (modeRef.current === "github" && runIdRef.current) void githubService.stop(runIdRef.current)
      else if (runIdRef.current) void hostRunnerService.stop(runIdRef.current)
    }
  }, [])

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
      if (!m || typeof m !== "object") return
      if (m.type === "sgpt-preview-console") {
        logSeq.current += 1
        const entry: LogEntry = { level: String(m.level || "log"), text: String(m.text ?? ""), id: logSeq.current }
        setLogs((prev) => (prev.length > 250 ? [...prev.slice(-250), entry] : [...prev, entry]))
        return
      }
      if (m.type === "sgpt-preview-selection-ready") {
        selectionReadyRef.current = true
        setSelectionMode(true)
        setSelectionFallback(false)
        return
      }
      if (m.type === "sgpt-preview-selection") {
        const meta = previewMetaRef.current
        const raw = (m.detail || {}) as CodePreviewSelectionDetail
        const detail: CodePreviewSelectionDetail = {
          ...raw,
          previewKind: meta.isLive ? "live" : meta.previewKind,
          entry: meta.isLive ? meta.liveSrc : meta.entry,
          activePath: meta.activePath,
          activeFolderId: meta.activeFolderId,
          capturedAt: raw.capturedAt || new Date().toISOString(),
        }
        setSelectionMode(false)
        setSelectionFallback(false)
        selectionReadyRef.current = false
        clearSelectionTimers()
        window.dispatchEvent(new CustomEvent<CodePreviewSelectionDetail>(CODE_SELECTION_CAPTURED_EVENT, { detail }))
        return
      }
      if (m.type === "sgpt-preview-selection-cancelled") {
        setSelectionMode(false)
        setSelectionFallback(false)
        selectionReadyRef.current = false
        clearSelectionTimers()
        window.dispatchEvent(
          new CustomEvent<CodePreviewSelectionCancelDetail>(CODE_SELECTION_CANCEL_EVENT, {
            detail: { reason: String(m.reason || "Selección cancelada."), source: "preview" },
          }),
        )
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [clearSelectionTimers])

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
  const isLive = liveRun.phase === "ready"

  // Live iframe src = dev-server URL + the sub-route from the address bar. The
  // path is normalised to always start with a single leading slash.
  const liveSrc = React.useMemo(() => {
    if (!liveRun.devUrl) return liveRun.devUrl
    const clean = `/${(navPath || "/").replace(/^\/+/, "")}`
    return liveRun.devUrl.replace(/\/+$/, "") + clean
  }, [liveRun.devUrl, navPath])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const detail: CodePreviewState = {
      phase: liveRun.phase,
      src: liveSrc,
      staticHtml: result.html,
      note: liveRun.note,
      kind: result.kind,
      entry: result.entry,
    }
    window.dispatchEvent(new CustomEvent<CodePreviewState>(CODE_PREVIEW_STATE_EVENT, { detail }))
  }, [liveRun.note, liveRun.phase, liveSrc, result.entry, result.html, result.kind])

  previewMetaRef.current = {
    activePath,
    activeFolderId: activeFolder?.id ?? null,
    entry: result.entry,
    previewKind: result.kind,
    liveSrc,
    isLive,
  }

  // Device framing: "responsive" fills the pane; tablet/phone render a fixed
  // viewport (swapped when rotated) with a live width×height readout.
  const framed = device !== "responsive"
  const nominal = framed ? DEVICE_VIEWPORTS[device] : null
  const frameW = nominal ? (orientation === "landscape" ? nominal.h : nominal.w) : null
  const frameH = nominal ? (orientation === "landscape" ? nominal.w : nominal.h) : null
  // Lightweight back/forward history over the address-bar sub-routes so the
  // Replit-style nav arrows work without reaching into the sandboxed iframe
  // (its opaque origin blocks contentWindow.history access by design).
  const [navStack, setNavStack] = React.useState<string[]>(["/"])
  const [navPos, setNavPos] = React.useState(0)
  const navigateTo = React.useCallback(
    (clean: string) => {
      if (clean === navPath) return
      const next = navStack.slice(0, navPos + 1)
      next.push(clean)
      setNavStack(next)
      setNavPos(next.length - 1)
      setNavPath(clean)
    },
    [navPath, navPos, navStack],
  )
  const goBack = React.useCallback(() => {
    if (navPos <= 0) return
    const target = navStack[navPos - 1] ?? "/"
    setNavPos(navPos - 1)
    setNavPath(target)
  }, [navPos, navStack])
  const goForward = React.useCallback(() => {
    if (navPos + 1 >= navStack.length) return
    const target = navStack[navPos + 1] ?? "/"
    setNavPos(navPos + 1)
    setNavPath(target)
  }, [navPos, navStack])
  const commitPath = React.useCallback(() => {
    const clean = `/${pathDraft.trim().replace(/^\/+/, "")}`
    setPathDraft(clean)
    navigateTo(clean)
  }, [navigateTo, pathDraft])
  // Keep the draft in sync when navPath is reset externally (e.g. a new run).
  React.useEffect(() => {
    setPathDraft(navPath)
  }, [navPath])

  const postSelectionMessage = React.useCallback((type: "sgpt-preview-select-start" | "sgpt-preview-select-cancel") => {
    const frame = previewFrameRef.current
    if (!frame?.contentWindow) return false
    frame.contentWindow.postMessage({ type }, "*")
    return true
  }, [])

  React.useEffect(() => {
    return () => clearSelectionTimers()
  }, [clearSelectionTimers])

  const cancelSelectionFromPreview = React.useCallback((reason: string) => {
    clearSelectionTimers()
    selectionReadyRef.current = false
    setSelectionMode(false)
    setSelectionFallback(false)
    window.dispatchEvent(
      new CustomEvent<CodePreviewSelectionCancelDetail>(CODE_SELECTION_CANCEL_EVENT, {
        detail: { reason, source: "preview" },
      }),
    )
  }, [clearSelectionTimers])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const startSelection = () => {
      clearSelectionTimers()
      selectionReadyRef.current = false
      setConsoleOpen(false)
      setSelectionMode(true)
      setSelectionFallback(false)
      const arm = () => {
        postSelectionMessage("sgpt-preview-select-start")
      }
      const fallback = () => {
        if (selectionReadyRef.current) return
        if (!previewFrameRef.current?.contentWindow) {
          cancelSelectionFromPreview("Abre un preview renderizable antes de seleccionar un elemento.")
          return
        }
        setSelectionFallback(true)
      }
      arm()
      selectionTimersRef.current.push(window.setTimeout(arm, 120))
      selectionTimersRef.current.push(window.setTimeout(arm, 360))
      selectionTimersRef.current.push(window.setTimeout(fallback, 760))
    }
    const cancelSelection = (event: Event) => {
      const detail = (event as CustomEvent<CodePreviewSelectionCancelDetail>).detail
      clearSelectionTimers()
      selectionReadyRef.current = false
      setSelectionMode(false)
      setSelectionFallback(false)
      if (detail?.source !== "preview") {
        postSelectionMessage("sgpt-preview-select-cancel")
      }
    }
    window.addEventListener(CODE_SELECT_TARGET_EVENT, startSelection)
    window.addEventListener(CODE_SELECTION_CANCEL_EVENT, cancelSelection)
    return () => {
      window.removeEventListener(CODE_SELECT_TARGET_EVENT, startSelection)
      window.removeEventListener(CODE_SELECTION_CANCEL_EVENT, cancelSelection)
    }
  }, [cancelSelectionFromPreview, clearSelectionTimers, postSelectionMessage])

  const handlePreviewFrameLoad = React.useCallback(() => {
    if (!selectionMode) return
    clearSelectionTimers()
    selectionReadyRef.current = false
    setSelectionFallback(false)
    selectionTimersRef.current.push(window.setTimeout(() => postSelectionMessage("sgpt-preview-select-start"), 40))
    selectionTimersRef.current.push(window.setTimeout(() => {
      if (!selectionReadyRef.current) postSelectionMessage("sgpt-preview-select-start")
    }, 180))
    selectionTimersRef.current.push(window.setTimeout(() => {
      if (!selectionReadyRef.current) setSelectionFallback(true)
    }, 760))
  }, [clearSelectionTimers, postSelectionMessage, selectionMode])

  const captureFallbackSelection = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectionFallback) return
    event.preventDefault()
    event.stopPropagation()
    clearSelectionTimers()
    selectionReadyRef.current = false
    const frameRect = previewFrameRef.current?.getBoundingClientRect()
    const hostRect = event.currentTarget.getBoundingClientRect()
    const rect = frameRect && frameRect.width > 0 && frameRect.height > 0 ? frameRect : hostRect
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width)
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height)
    const percentX = rect.width > 0 ? Math.round((x / rect.width) * 1000) / 10 : 0
    const percentY = rect.height > 0 ? Math.round((y / rect.height) * 1000) / 10 : 0
    const meta = previewMetaRef.current
    const detail: CodePreviewSelectionDetail = {
      selectionMethod: "region",
      selector: `preview-region(${percentX}%, ${percentY}%)`,
      tagName: "region",
      text: "Área visual seleccionada por coordenadas en el preview.",
      className: "",
      id: "",
      role: "",
      ariaLabel: "",
      href: "",
      src: "",
      rect: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      relativePoint: {
        x: Math.round(x),
        y: Math.round(y),
        percentX,
        percentY,
      },
      pageUrl: meta.liveSrc || meta.entry || "",
      pageTitle: "Preview APPS",
      previewKind: meta.isLive ? "live-region" : `${meta.previewKind}-region`,
      entry: meta.isLive ? meta.liveSrc : meta.entry,
      activePath: meta.activePath,
      activeFolderId: meta.activeFolderId,
      capturedAt: new Date().toISOString(),
    }
    setSelectionMode(false)
    setSelectionFallback(false)
    window.dispatchEvent(new CustomEvent<CodePreviewSelectionDetail>(CODE_SELECTION_CAPTURED_EVENT, { detail }))
  }, [clearSelectionTimers, selectionFallback])

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background px-2">
        {/* Canvas — opens the agent-driven mockup canvas tool. The device
            switcher lives beside the address bar, not here. */}
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: { toolId: "canvas" } }),
            )
          }
          title="Abrir el lienzo de mockups"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Canvas</span>
        </button>

        <span className="mx-0.5 h-4 w-px shrink-0 bg-border/60" />

        <button
          type="button"
          onClick={goBack}
          disabled={!isLive || navPos <= 0}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Atrás"
          title="Atrás"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!isLive || navPos + 1 >= navStack.length}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Adelante"
          title="Adelante"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={refresh}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Recargar preview"
          title="Recargar"
        >
          {building ? <ThinkingIndicator size="xs" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>

        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-3 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3 shrink-0 opacity-50" />
          {isLive ? (
            // Editable address bar → re-points the live iframe to a sub-route.
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                commitPath()
              }}
            >
              <span className="shrink-0 font-mono text-muted-foreground/60">localhost</span>
              <input
                type="text"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onBlur={commitPath}
                spellCheck={false}
                aria-label="Ruta de la app"
                title="Escribe una ruta y pulsa Enter para navegar"
                className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:text-muted-foreground/50"
                placeholder="/"
              />
            </form>
          ) : (
            <span className="truncate font-mono">localhost / {entryLabel}</span>
          )}
          <span className="ml-auto shrink-0 rounded bg-background/70 px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground/80">
            {KIND_LABEL[result.kind]}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* Device switcher — beside the address bar: click to preview the
              app on desktop / tablet / phone viewports. */}
          <DeviceMenu
            device={device}
            orientation={orientation}
            open={deviceMenuOpen}
            widthReadout={frameW}
            heightReadout={frameH}
            onOpenChange={setDeviceMenuOpen}
            onDevice={setDevice}
            onRotate={() => setOrientation((o) => (o === "portrait" ? "landscape" : "portrait"))}
          />
          <span className="mx-0.5 h-4 w-px bg-border/50" />
          {/* Phase B — auto-run stays primary; manual run is available when idle/error. */}
          {canRunProject ? (
            <>
              {liveRun.phase === "ready" || liveRun.phase === "starting" ? (
                <button
                  type="button"
                  onClick={stopApp}
                  title="Detener el dev server"
                  className="flex h-6 items-center gap-1 rounded-md bg-red-600/90 px-2 text-[11px] font-medium text-white transition-colors hover:bg-red-600"
                >
                  {liveRun.phase === "starting" ? <ThinkingIndicator size="xs" /> : <Square className="h-3 w-3" />}
                  <span>{liveRun.phase === "starting" ? "Arrancando…" : "Detener"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runApp()}
                  title="Instalar dependencias y correr el app (npm)"
                  className="flex h-6 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
                >
                  <Play className="h-3 w-3" />
                  <span>{gitBinding ? "Ejecutar repo" : "Ejecutar"}</span>
                </button>
              )}
              <span className="mx-0.5 h-4 w-px bg-border/50" />
            </>
          ) : null}

          {/* Type-check verdict for the live run: verifying → clean → or the
              error count while the agent auto-repairs. Host runner only. */}
          {liveRun.phase === "ready" && typeCheck ? (
            <span
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground"
              title="Verificación tsc --noEmit del proyecto en vivo"
            >
              {typeCheck === "checking" ? (
                <>
                  <ThinkingIndicator size="xs" />
                  <span>Verificando tipos…</span>
                </>
              ) : typeCheck === "clean" ? (
                <span className="text-emerald-600 dark:text-emerald-400">Tipos OK</span>
              ) : (
                <span className="text-[#C80000] dark:text-[#FF6B6B]">
                  {typeCheck.errors} error{typeCheck.errors === 1 ? "" : "es"} de tipos → reparando…
                </span>
              )}
            </span>
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
        </div>
      </div>

      {/* Viewport — full-bleed white when responsive (Replit-style); the gray
          canvas only shows behind the framed tablet/phone mockups. */}
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-auto p-0",
          framed ? "bg-zinc-100 dark:bg-zinc-900/55" : "bg-white dark:bg-zinc-900",
        )}
      >
        {selectionMode ? (
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/45 bg-zinc-950/82 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_18px_45px_-28px_rgba(15,23,42,0.72)] backdrop-blur-xl">
            <MousePointer2 className="h-3.5 w-3.5 text-violet-200" />
            <span>{selectionFallback ? "Selecciona un área del preview" : "Selecciona un elemento del preview"}</span>
            <span className="rounded-full bg-white/12 px-1.5 py-px font-mono text-[10px] text-white/75">Esc</span>
          </div>
        ) : null}
        {selectionFallback ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Seleccionar área del preview"
            className="absolute inset-0 z-20 cursor-crosshair bg-violet-500/[0.015] touch-none"
            onPointerDown={captureFallbackSelection}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancelSelectionFromPreview("Selección cancelada.")
            }}
          />
        ) : null}
        {liveRun.phase === "ready" ? (
          // Real running app from the cloud runner (npm dev server).
          <DeviceFrame device={device} width={frameW} height={frameH}>
            <iframe
              ref={previewFrameRef}
              src={liveSrc}
              title="App en vivo (dev server)"
              onLoad={handlePreviewFrameLoad}
              // CÓDIGO GENERADO NO CONFIABLE, dos regímenes de aislamiento:
              //  · src CROSS-origin (preview.<host>, modo codex): el navegador
              //    ya aísla por origen — la app tiene su PROPIO storage y no
              //    puede tocar cookies/APIs de siragpt.com. Sin sandbox, porque
              //    el origen opaco del sandbox rompía los módulos de Vite y el
              //    localStorage que las apps generadas usan (pantalla en blanco).
              //  · src same-origin (host runner/proxy local): sandbox SIN
              //    allow-same-origin → origen opaco, no puede leer el
              //    localStorage/cookies de SiraGPT ni llamar a sus APIs.
              // allow="clipboard-write" mantiene navigator.clipboard.writeText
              // (p.ej. el botón Copiar del componente «Invitar al proyecto»).
              sandbox={
                /^https?:\/\//.test(liveSrc || "") && typeof window !== "undefined" && !liveSrc.startsWith(window.location.origin)
                  ? undefined
                  : "allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
              }
              allow="clipboard-write"
              className="h-full w-full border-0 bg-white dark:bg-zinc-900"
            />
          </DeviceFrame>
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
              className="rounded-md bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-600 hover:bg-red-500/15 dark:text-red-400"
            >
              Reintentar manualmente
            </button>
          </div>
        ) : liveRun.phase === "stuck" ? (
          // Terminal-honest state: the auto-fix budget is spent, nothing is
          // actively "revisando" anymore. Show the truth + the log tail + a
          // manual retry that refills the budget.
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-sm font-medium text-rose-500">Lo intenté {AUTO_FIX_MAX} veces y no pude arreglarlo</p>
            <p className="mx-auto max-w-md text-[12px] leading-relaxed text-muted-foreground">
              Revisa el error de abajo y edita el código, o vuelve a intentarlo.
            </p>
            <pre className="mx-auto max-h-40 w-full max-w-md overflow-auto rounded-md border border-border/50 bg-muted/25 p-2 text-left font-mono text-[10px] leading-relaxed text-muted-foreground">
              {(lastErrorLogRef.current || liveRun.note || "").trim() || "Sin salida de error."}
            </pre>
            <button
              type="button"
              onClick={retryFromStuck}
              className="rounded-md bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-600 hover:bg-red-500/15 dark:text-red-400"
            >
              Reintentar
            </button>
          </div>
        ) : result.kind === "empty" || result.kind === "unsupported" ? (
          <PreviewLaunchpad kind={result.kind} note={result.note} />
        ) : (
          <DeviceFrame device={device} width={frameW} height={frameH}>
            <iframe
              ref={previewFrameRef}
              key={staticPreviewKey}
              srcDoc={result.html}
              title="Preview en vivo"
              onLoad={handlePreviewFrameLoad}
              className="h-full w-full border-0 bg-white dark:bg-zinc-900"
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
            />
          </DeviceFrame>
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
            className="flex flex-col items-start rounded-lg border border-border/60 bg-background px-4 py-3 text-left shadow-sm transition-colors hover:border-border hover:bg-muted/40"
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
        active && "bg-muted text-foreground ring-1 ring-border/70",
      )}
    >
      {children}
    </button>
  )
}

const DEVICE_ROWS: { id: Device; label: string; icon: React.ReactNode }[] = [
  { id: "responsive", label: "Escritorio", icon: <Monitor className="h-3.5 w-3.5" /> },
  { id: "tablet", label: "Tablet", icon: <Tablet className="h-3.5 w-3.5" /> },
  { id: "phone", label: "Móvil", icon: <Smartphone className="h-3.5 w-3.5" /> },
]

// Device selector dropdown: responsive / tablet / phone + a rotate toggle and a
// live width×height readout. Mirrors the pane's glass styling.
function DeviceMenu({
  device,
  orientation,
  open,
  widthReadout,
  heightReadout,
  onOpenChange,
  onDevice,
  onRotate,
}: {
  device: Device
  orientation: Orientation
  open: boolean
  widthReadout: number | null
  heightReadout: number | null
  onOpenChange: (open: boolean) => void
  onDevice: (device: Device) => void
  onRotate: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open, onOpenChange])
  const framed = device !== "responsive"
  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-0.5">
      {/* Phone+laptop trigger beside the address bar: click to preview the
          app on different device viewports. */}
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ver en distintos dispositivos"
        title="Ver en distintos dispositivos"
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          (open || framed) && "bg-muted text-foreground ring-1 ring-border/70",
        )}
      >
        <MonitorSmartphone className="h-4 w-4" />
      </button>
      {framed && widthReadout && heightReadout ? (
        <span className="shrink-0 rounded bg-background/70 px-1 py-px font-mono text-[9px] tabular-nums text-muted-foreground/80">
          {widthReadout}×{heightReadout}
        </span>
      ) : null}
      {open ? (
        <div className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-md border border-border/60 bg-background/95 py-1 shadow-lg backdrop-blur-xl">
          {DEVICE_ROWS.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                onDevice(row.id)
                onOpenChange(false)
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-muted/60",
                device === row.id && "font-medium",
              )}
            >
              {row.icon}
              <span className="flex-1">{row.label}</span>
              {device === row.id ? <Circle className="h-1.5 w-1.5 fill-current" /> : null}
            </button>
          ))}
          <div className="my-1 h-px bg-border/60" />
          <button
            type="button"
            disabled={!framed}
            onClick={() => {
              onRotate()
              onOpenChange(false)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span className="flex-1">
              {orientation === "portrait" ? "Rotar a horizontal" : "Rotar a vertical"}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

// Renders children in a fixed device viewport (tablet/phone, swapped on rotate)
// or stretched to the pane ("responsive"). The phone keeps its rounded bezel.
function DeviceFrame({
  device,
  width,
  height,
  children,
}: {
  device: Device
  width: number | null
  height: number | null
  children: React.ReactNode
}) {
  if (device === "responsive" || !width || !height) {
    return <div className="mx-auto h-full bg-white transition-all dark:bg-zinc-900">{children}</div>
  }
  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      <div
        className={cn(
          "overflow-hidden bg-white shadow-2xl transition-all dark:bg-zinc-900",
          device === "phone" ? "rounded-[28px] border-[6px] border-zinc-800" : "rounded-xl border-2 border-zinc-800",
        )}
        style={{ width, height, maxWidth: "100%", maxHeight: "100%" }}
      >
        {children}
      </div>
    </div>
  )
}
