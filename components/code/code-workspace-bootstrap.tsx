"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { reportClientLog } from "@/lib/client-logs"
import { readBrowserClientBuildId } from "@/lib/client-build-id"
import {
  genericWorkspaceFailureCopy,
  WORKSPACE_STAGES,
  type WorkspaceProgress,
} from "@/lib/code-workspace-errors"
import {
  logCodeWorkspaceBootstrapFailure,
  runCodeWorkspaceBootstrap,
  type CodeBootstrapSnapshot,
} from "@/lib/code-workspace-bootstrap"

function pendingLabel(progress: WorkspaceProgress | null, state: string): string {
  if (progress?.label) return progress.label
  if (state === WORKSPACE_STAGES.RESOLVING_SESSION) return "Comprobando tu sesión…"
  if (state === WORKSPACE_STAGES.RECONNECTING) return "Reconectando tu espacio…"
  return "Preparando tu espacio…"
}

function CodeWorkspaceProgress({
  snapshot,
}: {
  snapshot: CodeBootstrapSnapshot
}) {
  const percent = snapshot.progress?.percent ?? 12
  return (
    <div
      className="flex min-h-[50vh] items-center justify-center p-6"
      role="status"
      aria-live="polite"
      data-testid="code-workspace-bootstrap-progress"
    >
      <div className="w-full max-w-md space-y-4 text-center">
        <p className="text-sm font-medium text-foreground">Preparando tu espacio…</p>
        <p className="text-sm text-muted-foreground">
          {pendingLabel(snapshot.progress, snapshot.state)}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.max(8, Math.min(100, percent))}%` }}
          />
        </div>
        {snapshot.progress?.stage && (
          <p className="text-xs text-muted-foreground/80">{snapshot.progress.stage}</p>
        )}
      </div>
    </div>
  )
}

function CodeWorkspaceFailureModal({
  snapshot,
  onRetry,
  onOpenCode,
  onBackToChat,
}: {
  snapshot: CodeBootstrapSnapshot
  onRetry: () => void
  onOpenCode: () => void
  onBackToChat: () => void
}) {
  const error = snapshot.error
  const traceId = error?.traceId || snapshot.traceId
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="code-workspace-failure-title"
      data-testid="code-workspace-bootstrap-failure"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-lg">
        <h2 id="code-workspace-failure-title" className="text-lg font-semibold text-foreground">
          No se pudo cargar el espacio de código
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {error?.userMessage || genericWorkspaceFailureCopy()}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Reintentar remonta el workspace. El chat no se ve afectado.
        </p>
        {traceId && (
          <p className="mt-3 font-mono text-xs text-muted-foreground/70">
            traceId: {traceId}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            onClick={onRetry}
          >
            Reintentar
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm"
            onClick={onOpenCode}
          >
            Ir a /code
          </button>
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
            onClick={onBackToChat}
          >
            Volver al chat
          </button>
        </div>
      </div>
    </div>
  )
}

export function CodeWorkspaceBootstrap({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const folderId = searchParams?.get("folder") || null
  const localId = searchParams?.get("local") || null
  const [snapshot, setSnapshot] = React.useState<CodeBootstrapSnapshot | null>(null)
  const [cycle, setCycle] = React.useState(0)
  const reportedRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void runCodeWorkspaceBootstrap({
      folderId,
      localId,
      storage: typeof sessionStorage !== "undefined" ? sessionStorage : null,
      clientBuild: readBrowserClientBuildId(),
      signal: controller.signal,
      refreshSession: async () => {
        try {
          const response = await authenticatedFetch("/api/auth/me", {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
          })
          return response.ok
        } catch {
          return false
        }
      },
      reload: () => {
        if (typeof window !== "undefined") window.location.reload()
      },
      onSnapshot: (next) => {
        if (!cancelled) setSnapshot(next)
      },
    }).then((final) => {
      if (cancelled) return
      setSnapshot(final)
      if (final.state === "FAILED" && final.error) {
        const key = `${final.error.code}:${final.error.traceId}`
        if (reportedRef.current === key) return
        reportedRef.current = key
        logCodeWorkspaceBootstrapFailure(final)
        reportClientLog({
          source: "client",
          severity: "error",
          action: "code.workspace.bootstrap",
          component: "CodeWorkspaceBootstrap",
          message: final.error.userMessage,
          extra: {
            code: final.error.code,
            stage: final.state,
            traceId: final.error.traceId,
            buildId: readBrowserClientBuildId(),
          },
        })
      }
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [folderId, localId, cycle])

  const retry = React.useCallback(() => {
    reportedRef.current = null
    setSnapshot(null)
    setCycle((value) => value + 1)
  }, [])

  const showProgress = !snapshot
    || (snapshot.state !== "READY"
      && snapshot.state !== "FAILED"
      && snapshot.state !== WORKSPACE_STAGES.DEGRADED)
  const showFailure = snapshot?.state === "FAILED"

  return (
    <>
      {showProgress ? (
        <CodeWorkspaceProgress snapshot={snapshot || {
          state: WORKSPACE_STAGES.RESOLVING_SESSION,
          attempt: 0,
          idempotencyKey: "",
          error: null,
          progress: { stage: WORKSPACE_STAGES.RESOLVING_SESSION, percent: 8, label: "Comprobando tu sesión…" },
          workspaceId: null,
          traceId: null,
          ready: false,
        }} />
      ) : children}
      {showFailure && snapshot && (
        <CodeWorkspaceFailureModal
          snapshot={snapshot}
          onRetry={retry}
          onOpenCode={() => router.replace("/code")}
          onBackToChat={() => router.push("/chat")}
        />
      )}
    </>
  )
}
