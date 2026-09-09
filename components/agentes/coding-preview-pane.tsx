"use client"

/**
 * Pestaña Vista previa del IDE de /agentes (MVP programación web, Etapa 4).
 * Arranca el dev server del proyecto vinculado (POST /preview/start, que ya
 * espera readiness en servidor hasta ~90s), muestra el proxy tokenizado en
 * un iframe y lo detiene al desmontar. Sin abrir-en-pestaña-nueva: el live
 * top-level heredaría el origen SiraGPT (ver preview-pane.tsx).
 */

import * as React from "react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { ensureCodexPreviewOrigin } from "@/lib/codex/use-codex-health"
import { cn } from "@/lib/utils"

type Phase = "idle" | "starting" | "ready" | "error"

const HEARTBEAT_MS = 30_000

function sandboxFor(url: string): string | undefined {
  try {
    if (/^https?:\/\//.test(url) && !url.startsWith(window.location.origin)) return undefined
  } catch {
    return undefined
  }
  return "allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
}

export function CodingPreviewPane({ projectId }: { projectId: string | null }) {
  const [phase, setPhase] = React.useState<Phase>("idle")
  const [url, setUrl] = React.useState<string | null>(null)
  const [note, setNote] = React.useState("")
  const [frameKey, setFrameKey] = React.useState(0)
  const startedRef = React.useRef(false)
  const abortRef = React.useRef<AbortController | null>(null)

  const stop = React.useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = null
    if (startedRef.current && projectId) {
      startedRef.current = false
      try {
        await projectsCodexApi.stopPreview(projectId)
      } catch {
        // best-effort: el reaper del runner limpia solo
      }
    }
    setPhase("idle")
    setUrl(null)
  }, [projectId])

  // Al desmontar (cambio de proyecto/cierre), detener lo que arrancamos.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (startedRef.current && projectId) {
        startedRef.current = false
        void projectsCodexApi.stopPreview(projectId).catch(() => undefined)
      }
    }
  }, [projectId])

  // Heartbeat: si el dev server cae tras ready, volver a idle con nota.
  React.useEffect(() => {
    if (phase !== "ready" || !projectId) return
    const timer = window.setInterval(() => {
      void projectsCodexApi
        .previewStatus(projectId)
        .then((st) => {
          const running = Boolean((st as { running?: boolean })?.running ?? (st as { previewStatus?: { running?: boolean } })?.previewStatus?.running)
          if (!running) {
            startedRef.current = false
            setPhase("idle")
            setUrl(null)
            setNote("El servidor de vista previa se detuvo.")
          }
        })
        .catch(() => undefined)
    }, HEARTBEAT_MS)
    return () => window.clearInterval(timer)
  }, [phase, projectId])

  async function start() {
    if (!projectId || phase === "starting") return
    setPhase("starting")
    setNote("")
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const previewOrigin = await ensureCodexPreviewOrigin().catch(() => null)
      const out = await projectsCodexApi.startPreview(projectId, ctrl.signal)
      const base = out?.previewUrl || out?.basePath || ""
      if (!base) throw new Error("El servidor no devolvió URL de vista previa.")
      startedRef.current = true
      setUrl(`${previewOrigin || ""}${base}`)
      setPhase("ready")
    } catch (err) {
      if (ctrl.signal.aborted) return
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

  if (!projectId) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="agentes-preview-pane">
        Abre un proyecto para ver su vista previa.
      </p>
    )
  }

  if (phase === "ready" && url) {
    return (
      <div className="flex h-full flex-col" data-testid="agentes-preview-pane">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
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
        </div>
        <iframe
          key={frameKey}
          data-testid="agentes-preview-iframe"
          src={url}
          title="Vista previa del proyecto"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox={sandboxFor(url)}
          allow="clipboard-write"
        />
      </div>
    )
  }

  return (
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
