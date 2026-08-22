"use client"

/**
 * /code error boundary — reconnect first, scare never.
 *
 * After a FE deploy this route often throws ChunkLoadError on the
 * `dynamic(code-workspace)` import. `reset()` remounts the same stale
 * chunks, so version-skew uses the shared root hard-reload helper.
 * Other render crashes get one `reset()` after 750ms. The generic
 * «No se pudo cargar el espacio de código» modal appears only after
 * that automatic recovery is exhausted.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { reportClientLog } from "@/lib/client-logs"
import { readBrowserClientBuildId } from "@/lib/client-build-id"
import { track } from "@/lib/analytics"
import { isRecoverableClientBundleError } from "@/lib/client-bundle-recovery"
import { isChunkLoadOrBuildSkewError } from "@/lib/code-workspace-errors"
import {
  CODE_ERROR_RESET_DELAY_MS,
  markBuildSkewReload,
  markCodeWorkspaceErrorReset,
  resolveCodeWorkspaceErrorPhase,
  shouldAutoResetCodeWorkspaceError,
  shouldReloadForBuildSkew,
} from "@/lib/code-workspace-error-boundary"

export default function CodeWorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()
  const buildId = typeof window !== "undefined" ? readBrowserClientBuildId() : "unknown"
  const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null
  const [phase, setPhase] = useState<"recovering" | "exhausted">("recovering")

  useEffect(() => {
    track("error.route", {
      digest: error.digest,
      name: error.name,
      message: (error.message || "").slice(0, 500),
      url: "/code",
    })
    const willAutoRecover = resolveCodeWorkspaceErrorPhase(error, storage, buildId) === "recovering"
    if (willAutoRecover && (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error))) {
      return
    }
    reportClientLog({
      source: "render",
      severity: "error",
      action: "error.code_workspace",
      component: error.name || "CodeWorkspaceError",
      message: error.message || "Code workspace render error",
      stack: error.stack,
      extra: {
        digest: error.digest || null,
        buildId,
        traceId: error.digest || null,
        phase,
      },
    })
  }, [error, buildId, storage, phase])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (
      (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error))
      && shouldReloadForBuildSkew(error, sessionStorage, buildId)
    ) {
      markBuildSkewReload(error, sessionStorage, buildId)
      window.location.reload()
      return
    }
    if (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error)) {
      setPhase("exhausted")
      return
    }
    if (!shouldAutoResetCodeWorkspaceError(error, sessionStorage)) {
      setPhase("exhausted")
      return
    }
    markCodeWorkspaceErrorReset(error, sessionStorage)
    const timer = window.setTimeout(() => {
      reset()
    }, CODE_ERROR_RESET_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [error, reset, buildId])

  if (phase === "exhausted") {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-workspace-error-title"
        data-testid="code-workspace-error-exhausted"
      >
        <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-lg">
          <h1 id="code-workspace-error-title" className="text-lg font-semibold text-foreground">
            No se pudo cargar el espacio de código
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Reintentar remonta el workspace. El chat no se ve afectado.
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-xs text-muted-foreground/70">
              traceId: {error.digest}
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
              onClick={() => {
                if (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error)) {
                  window.location.reload()
                  return
                }
                reset()
              }}
            >
              Reintentar
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm"
              onClick={() => {
                window.location.assign("/code")
              }}
            >
              Ir a /code
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
              onClick={() => router.push("/chat")}
            >
              Volver al chat
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-[50vh] items-center justify-center p-6"
      role="status"
      aria-live="polite"
      data-testid="code-workspace-error-reconnect"
    >
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold text-foreground">Reconectando tu espacio…</h1>
        <p className="text-sm text-muted-foreground">
          Tus archivos y el chat están protegidos. No hace falta recargar a mano.
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-muted-foreground/70">traceId: {error.digest}</p>
        )}
      </div>
    </div>
  )
}
