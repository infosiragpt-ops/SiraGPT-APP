"use client"

/**
 * Pestaña Vista previa del IDE de /agentes (MVP programación web, Etapa 4).
 * Arranca el dev server del proyecto vinculado (POST /preview/start, que ya
 * espera readiness en servidor hasta ~90s), muestra el proxy tokenizado en
 * un iframe. Cerrar conserva el servidor; Detener lo cierra explícitamente.
 * Sin abrir-en-pestaña-nueva: el live
 * top-level heredaría el origen SiraGPT (ver preview-pane.tsx).
 * Hot-restart (Etapa 5 MVP): el IDE le pasa `fileVersion`, que sube cada vez
 * que el árbol/contenido del proyecto cambia de verdad; si el preview ya está
 * listo, solo se recarga el iframe (mismo mecanismo que "Recargar"), sin
 * reiniciar el dev server ni tocar la URL tokenizada.
 */

import * as React from "react"
import { RefreshCw, Square, X } from "lucide-react"

import { IntegratedBrowserBar } from "@/components/chat/integrated-browser-bar"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { ensureCodexPreviewOrigin } from "@/lib/codex/use-codex-health"
import { cn } from "@/lib/utils"
import { readyCodingPreviewPath } from "@/lib/chat/coding-preview-event"

type Phase = "idle" | "starting" | "ready" | "error"

const HEARTBEAT_MS = 30_000

function unavailablePreviewNote(value: unknown): string {
  const state = value && typeof value === "object" ? value as Record<string, unknown> : {}
  if (state.previewExpired === true && state.running === true) {
    return "El enlace de vista previa caducó. Pulsa Iniciar vista previa para renovarlo."
  }
  if (state.running === false) return "El servidor de vista previa se detuvo."
  return "La vista previa todavía no está disponible. Vuelve a iniciarla para comprobar el proyecto."
}

export function CodingPreviewPane({ projectId, fileVersion = 0, previewRevision = 0, browser }: {
  projectId: string | null
  fileVersion?: number
  previewRevision?: number
  browser?: { projectName: string; onClose: () => void }
}) {
  const [phase, setPhase] = React.useState<Phase>("idle")
  const [url, setUrl] = React.useState<string | null>(null)
  const [note, setNote] = React.useState("")
  const [frameKey, setFrameKey] = React.useState(0)
  const operationRef = React.useRef(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const seenFileVersionRef = React.useRef(fileVersion)
  const seenPreviewRevisionRef = React.useRef(previewRevision)

  const stop = React.useCallback(async () => {
    operationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPhase("idle")
    setUrl(null)
    if (projectId) {
      try { await projectsCodexApi.stopPreview(projectId) }
      catch { setNote("No se pudo confirmar la detención. Vuelve a abrir la vista previa para comprobar su estado.") }
    }
  }, [projectId])

  // Recover the runner's current, owned URL. Mount/reload never starts an app;
  // the agent or an explicit Iniciar does. A stale response cannot cross chats.
  React.useEffect(() => {
    const operation = ++operationRef.current
    const controller = new AbortController()
    setPhase("idle")
    setUrl(null)
    setNote("")
    if (projectId) {
      void (async () => {
        try {
          const status = await projectsCodexApi.previewStatus(projectId, controller.signal)
          const base = readyCodingPreviewPath(status, projectId)
          if (!base) {
            if (!controller.signal.aborted && operation === operationRef.current && status?.previewExpired === true) {
              setNote(unavailablePreviewNote(status))
            }
            return
          }
          const origin = await ensureCodexPreviewOrigin().catch(() => null)
          if (controller.signal.aborted || operation !== operationRef.current) return
          setUrl(`${origin || ""}${base}`)
          setPhase("ready")
        } catch { /* An unavailable/stopped runner stays explicitly idle. */ }
      })()
    }
    return () => {
      controller.abort()
      operationRef.current += 1
      abortRef.current?.abort()
      // Hiding the pane is not Stop: another viewer or agent can use this server.
    }
  }, [projectId])

  // Follow the owned runner URL if its capability was renewed elsewhere.
  // Serialize reads; a late heartbeat never revives Stop or a different chat.
  React.useEffect(() => {
    if (phase !== "ready" || !projectId) return
    let cancelled = false, inFlight = false
    const operation = operationRef.current
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      void (async () => {
        try {
          const status = await projectsCodexApi.previewStatus(projectId, controller.signal)
          if (cancelled || operation !== operationRef.current) return
          const base = readyCodingPreviewPath(status, projectId)
          if (!base) {
            setPhase("idle")
            setUrl(null)
            setNote(unavailablePreviewNote(status))
            return
          }
          const origin = await ensureCodexPreviewOrigin().catch(() => null)
          if (cancelled || operation !== operationRef.current) return
          setUrl(`${origin || ""}${base}`)
        } catch { /* Keep the current frame during a transient read failure. */ }
        finally { inFlight = false }
      })()
    }, HEARTBEAT_MS)
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer) }
  }, [phase, projectId])

  // Hot-restart: si los archivos del proyecto cambiaron (fileVersion del IDE)
  // y el preview ya está listo, recargar el iframe con la misma URL
  // tokenizada. No reinicia el dev server: el arranque fresco ya sirve los
  // archivos nuevos, así que los cambios durante "starting" se ignoran.
  React.useEffect(() => {
    if (seenFileVersionRef.current === fileVersion) return
    seenFileVersionRef.current = fileVersion
    if (phase === "ready" && url) setFrameKey((k) => k + 1)
  }, [fileVersion, phase, url])

  // A verified chat ready event can represent an edit to existing files;
  // neither the URL nor the file-tree names need to change. Reload only the
  // visible, running frame, never reopen a closed pane or revive Stop. Status
  // polling alone does not produce a revision, and failed reads cannot undo it.
  React.useEffect(() => {
    if (previewRevision <= seenPreviewRevisionRef.current) return
    seenPreviewRevisionRef.current = previewRevision
    if (phase === "ready" && url) setFrameKey((key) => key + 1)
  }, [previewRevision, phase, url])

  async function start() {
    if (!projectId || phase === "starting") return
    const operation = ++operationRef.current
    setPhase("starting")
    setNote("")
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const previewOrigin = await ensureCodexPreviewOrigin().catch(() => null)
      const out = await projectsCodexApi.startPreview(projectId, ctrl.signal)
      const base = readyCodingPreviewPath(out, projectId)
      if (!base) throw new Error("El servidor todavía no confirmó que la vista previa esté lista.")
      if (ctrl.signal.aborted || operation !== operationRef.current) return
      setUrl(`${previewOrigin || ""}${base}`)
      setPhase("ready")
    } catch (err) {
      if (ctrl.signal.aborted || operation !== operationRef.current) return
      const status = (err as { status?: number })?.status
      const message =
        status === 403
          ? "Tu cuenta no puede ejecutar vistas previas en producción."
          : status === 429
            ? "Hay demasiadas vistas previas activas; reintenta en unos segundos."
            : "No se pudo arrancar la vista previa. Reintenta."
      setNote(message)
      setPhase("error")
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  const renderPane = (content: React.ReactNode) => browser ? (
    <section className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border/40 bg-background"
      aria-label="Navegador del proyecto" data-testid="chat-project-browser" data-project-id={projectId || undefined}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-gradient-to-b from-white to-zinc-100 px-3 dark:border-white/10 dark:from-[#2a2a2c] dark:to-[#1b1b1d]">
        <IntegratedBrowserBar readOnlyLabel={`${browser.projectName || "Proyecto"} · Vista local`} autoNavigate={false} />
        <button type="button" aria-label="Recargar aplicación" title="Recargar aplicación"
          disabled={phase !== "ready" || !url} onClick={() => setFrameKey((key) => key + 1)}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Detener aplicación" title="Detener aplicación" data-testid="agentes-preview-stop"
          disabled={phase !== "ready" && phase !== "starting"} onClick={() => void stop()}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Cerrar navegador" title="Cerrar navegador" onClick={browser.onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{content}</div>
    </section>
  ) : content

  if (!projectId) {
    return renderPane(
      <p className="p-3 text-xs text-muted-foreground" data-testid="agentes-preview-pane">
        Abre un proyecto para ver su vista previa.
      </p>
    )
  }

  if (phase === "ready" && url) {
    return renderPane(
      <div className="flex h-full flex-col" data-testid="agentes-preview-pane">
        {browser ? null : <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <code className="flex-1 truncate text-xs text-muted-foreground">{url}</code>
          <button
            type="button"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setFrameKey((k) => k + 1)}
          >
            Recargar
          </button>
          <button
            type="button"
            data-testid="agentes-preview-stop"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void stop()}
          >
            Detener
          </button>
        </div>}
        <iframe
          key={frameKey}
          data-testid="agentes-preview-iframe"
          src={url}
          title="Vista previa del proyecto"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
          allow="clipboard-write"
        />
      </div>
    )
  }

  return renderPane(
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="agentes-preview-pane">
      {phase === "starting" ? (
        <>
          <ThinkingIndicator />
          <p className="text-xs text-muted-foreground">Iniciando vista previa… puede tardar hasta un par de minutos la primera vez.</p>
          <button
            type="button"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void stop()}
          >
            Cancelar
          </button>
        </>
      ) : (
        <>
          {phase === "error" ? (
            <p className="max-w-sm text-xs text-destructive" data-testid="agentes-preview-error">{note}</p>
          ) : note ? (
            <p className="max-w-sm text-xs text-muted-foreground">{note}</p>
          ) : (
            <p className="max-w-sm text-xs text-muted-foreground">
              Arranca el servidor del proyecto para ver la app corriendo.
            </p>
          )}
          <button
            type="button"
            data-testid={phase === "error" ? "agentes-preview-retry" : "agentes-preview-start"}
            onClick={() => void start()}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium",
              "bg-primary text-primary-foreground hover:opacity-90",
            )}
          >
            {phase === "error" ? "Reintentar" : "Iniciar vista previa"}
          </button>
        </>
      )}
    </div>
  )
}
