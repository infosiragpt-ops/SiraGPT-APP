"use client"

/**
 * /code error boundary — live P0: ChunkLoad must hard-reload, not reset().
 *
 * Production modal at /opt/siragpt/app/code/error.tsx currently shows
 * «No se pudo cargar el espacio de código» and Reintentar only calls
 * reset(). After FE recreates, stale tabs throw ChunkLoadError on
 * dynamic(code-workspace, { ssr: false }); reset() remounts deleted
 * chunks and the modal sticks.
 *
 * Root app/error.tsx already recovers via maybeReloadStaleClientBundle.
 * This file uses that same helper (same __NEXT_DATA__.buildId guard).
 * First paint is «Reconectando tu espacio…». The generic modal appears
 * only after that one automatic recovery is exhausted. Reintentar on a
 * bundle error reloads the document — it never reset()s stale chunks.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { reportClientLog } from "@/lib/client-logs"
import { readBrowserClientBuildId } from "@/lib/client-build-id"
import { track } from "@/lib/analytics"
import {
  isRecoverableClientBundleError,
  maybeReloadStaleClientBundle,
} from "@/lib/client-bundle-recovery"
import { isChunkLoadOrBuildSkewError } from "@/lib/code-workspace-errors"
import {
  CODE_ERROR_RESET_DELAY_MS,
  markCodeWorkspaceErrorReset,
  resolveCodeWorkspaceErrorPhase,
  shouldAutoResetCodeWorkspaceError,
} from "@/lib/code-workspace-error-boundary"

function retryCodeWorkspace(error: Error, reset: () => void) {
  if (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error)) {
    window.location.reload()
    return
  }
  reset()
}

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
    if (isRecoverableClientBundleError(error)) return
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
        phase: resolveCodeWorkspaceErrorPhase(error, storage, buildId),
      },
    })
  }, [error, buildId, storage])

  useEffect(() => {
    if (typeof window === "undefined") return
    // Same one-shot hard reload as root app/error.tsx. Do not reset().
    if (maybeReloadStaleClientBundle(error)) return
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
  }, [error, reset])

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
              onClick={() => retryCodeWorkspace(error, reset)}
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
