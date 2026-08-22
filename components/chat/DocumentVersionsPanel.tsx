"use client"

/**
 * DocumentVersionsPanel — the "Historial" surface of the /chat document
 * editor. Read-only collaboration history for one uploaded file:
 *
 *   1. Lists FileVersions newest-first (number, relative date, summary or
 *      edition type — manual vs surgical via editPlanType, origin chat).
 *   2. Simple pagination: 20 per page against GET /files/:id/versions
 *      (limit/offset), plus a "cargar más" button while `total` allows.
 *   3. Selecting a version loads its Markdown (GET …/content) and shows a
 *      lightweight LCS line diff versus the current editor content.
 *   4. "Restaurar esta versión" → confirm → POST …/restore → reload content
 *      + versions, clear the stale localStorage draft, and rebase the editor.
 *
 * All data access goes through lib/chat/document-versions.ts (injected
 * collaborators, no raw fetch) so tests can stub everything.
 */

import * as React from "react"
import { History, Loader2, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  DOCUMENT_VERSIONS_PAGE_SIZE,
  clearDocumentDraft,
  diffLines,
  diffStats,
  hasMoreVersions,
  listDocumentVersions,
  restoreDocumentVersion,
  type DocumentVersionRecord,
} from "@/lib/chat/document-versions"

export const documentVersionsPanelTestIds = {
  root: "document-versions-panel",
  list: "document-versions-list",
  item: "document-version-item",
  diff: "document-version-diff",
} as const

export type DocumentVersionsPanelProps = {
  fileId: string | null
  /** Render gate — the chat mounts this only while the editor dialog is open. */
  open?: boolean
  /** The current editor markdown — the diff's right side. */
  currentMarkdown: string
  apiClient?: unknown
  chatId?: string
  className?: string
  /** Fired after a successful restore once content + history are rebased. */
  onRestored?: (markdown: string, restoredVersion: number) => void
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/** Relative time in Spanish-ish neutral short form ("hace 5 min"). */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ""
  let seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return "hace unos segundos"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  seconds = minutes * 60
  const hours = Math.round(seconds / 3600)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 30) return `hace ${days} d`
  const months = Math.round(days / 30)
  if (months < 12) return `hace ${months} meses`
  const years = Math.round(months / 12)
  return `hace ${years} años`
}

/** Human label for a version's edition type. */
export function editionKindLabel(version: DocumentVersionRecord): string {
  if (version.editPlanType === "restore") return "Restauración"
  if (version.editPlanType === "manual_edit") return "Edición manual"
  // Background surgical edits carry an editPlan but not the manual marker;
  // rows without any plan are artifact-backed surgical edits too.
  return "Edición quirúrgica"
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5" aria-hidden="true">
      <div className="h-7 w-9 animate-pulse rounded-md bg-muted" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

export function DocumentVersionsPanel(props: DocumentVersionsPanelProps) {
  const { fileId, currentMarkdown, apiClient, chatId, className, onRestored } = props

  const [loadState, setLoadState] = React.useState<LoadState>({ kind: "idle" })
  const [versions, setVersions] = React.useState<DocumentVersionRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [loadingMore, setLoadingMore] = React.useState(false)

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selectedMarkdown, setSelectedMarkdown] = React.useState<string | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [diffError, setDiffError] = React.useState<string | null>(null)

  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const [restoreError, setRestoreError] = React.useState<string | null>(null)

  const loadPage = React.useCallback(async (offset: number) => {
    if (!fileId) return
    const appending = offset > 0
    if (appending) setLoadingMore(true)
    else setLoadState({ kind: "loading" })
    try {
      const page = await listDocumentVersions({ apiClient, fileId })
      // The endpoint returns the full newest-first list; we window it to the
      // requested page (limit/offset contract) so each "Cargar más" reveals
      // exactly one more slice.
      setVersions(page.versions.slice(0, offset + DOCUMENT_VERSIONS_PAGE_SIZE))
      setTotal(page.total)
      setLoadState({ kind: "ready" })
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo cargar el historial de versiones"
      if (appending) setRestoreError(message)
      else setLoadState({ kind: "error", message })
    } finally {
      setLoadingMore(false)
    }
  }, [apiClient, fileId])

  React.useEffect(() => {
    setVersions([])
    setTotal(0)
    setSelectedId(null)
    setSelectedMarkdown(null)
    setDiffError(null)
    setConfirmingId(null)
    setRestoreError(null)
    if (!fileId || props.open === false) {
      setLoadState({ kind: "idle" })
      return
    }
    void loadPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  const handleLoadMore = React.useCallback(() => {
    void loadPage(versions.length)
  }, [loadPage, versions.length])

  const handleSelectVersion = React.useCallback(async (version: DocumentVersionRecord) => {
    if (!fileId || !version.id) return
    if (selectedId === version.id) {
      // Toggle off.
      setSelectedId(null)
      setSelectedMarkdown(null)
      setDiffError(null)
      return
    }
    setSelectedId(version.id)
    setSelectedMarkdown(null)
    setDiffError(null)
    setDiffLoading(true)
    try {
      const client = (apiClient ?? {}) as {
        getFileVersionContent?: (
          fId: string,
          vId: string,
        ) => Promise<{ version?: { content?: string }; content?: string }>
        request?: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown>
      }
      let markdown: string | null = null
      if (typeof client.getFileVersionContent === "function") {
        const payload = await client.getFileVersionContent(fileId, version.id).catch(() => null)
        markdown = payload?.version?.content ?? payload?.content ?? null
      } else if (typeof client.request === "function") {
        const payload = (await client
          .request(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(version.id)}/content`)
          .catch(() => null)) as { version?: { content?: string } } | null
        markdown = payload?.version?.content ?? null
      }
      if (typeof markdown !== "string" || !markdown.trim()) {
        // Artifact-backed surgical versions predate the content column; there
        // is no text to diff honestly.
        setDiffError("Esta versión no guarda texto comparable")
        setSelectedMarkdown(null)
      } else {
        setSelectedMarkdown(markdown)
      }
    } catch {
      setDiffError("No se pudo leer el contenido de esta versión")
      setSelectedMarkdown(null)
    } finally {
      setDiffLoading(false)
    }
  }, [apiClient, fileId, selectedId])

  const handleRestoreClick = React.useCallback((version: DocumentVersionRecord) => {
    setRestoreError(null)
    setConfirmingId(version.id)
  }, [])

  const handleRestoreCancel = React.useCallback(() => {
    setConfirmingId(null)
  }, [])

  const handleRestoreConfirm = React.useCallback(async () => {
    const target = versions.find((v) => v.id === confirmingId)
    if (!fileId || !target || restoringId) return
    setRestoringId(target.id)
    setRestoreError(null)
    try {
      await restoreDocumentVersion({ apiClient, fileId, versionId: target.id, chatId })
      // Restoring invalidates any autosaved draft for this file — the server
      // head moved underneath it.
      clearDocumentDraft(fileId)
      // Rebase: reload history AND pull the restored Markdown as the new base.
      const refreshed = await listDocumentVersions({ apiClient, fileId })
      setVersions(refreshed.versions)
      setTotal(refreshed.total)
      setConfirmingId(null)
      setSelectedId(null)
      setSelectedMarkdown(null)
      // The restored head is the newest list entry; fetch its text so callers
      // can swap the editor onto it without guessing from the list payload.
      const head = refreshed.versions[0]
      let restoredMarkdown = ""
      if (head && head.hasContent !== false) {
        const client = (apiClient ?? {}) as {
          getFileVersionContent?: (fId: string, vId: string) => Promise<{ version?: { content?: string } }>
          request?: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown>
        }
        try {
          if (typeof client.getFileVersionContent === "function") {
            const payload = await client.getFileVersionContent(fileId, head.id).catch(() => null)
            restoredMarkdown = payload?.version?.content ?? ""
          } else if (typeof client.request === "function") {
            const payload = (await client
              .request(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(head.id)}/content`)
              .catch(() => null)) as { version?: { content?: string } } | null
            restoredMarkdown = payload?.version?.content ?? ""
          }
        } catch {
          /* fall through with empty — onRestored still fires */
        }
      }
      onRestored?.(restoredMarkdown, head ? head.version : target.version)
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo restaurar la versión"
      setRestoreError(message)
    } finally {
      setRestoringId(null)
    }
  }, [apiClient, chatId, confirmingId, fileId, onRestored, restoringId, versions])

  const selectedForDiff = versions.find((v) => v.id === selectedId) ?? null
  const diffLinesList = React.useMemo(() => {
    if (selectedMarkdown === null) return []
    return diffLines(selectedMarkdown, currentMarkdown ?? "")
  }, [selectedMarkdown, currentMarkdown])
  const stats = React.useMemo(() => diffStats(diffLinesList), [diffLinesList])

  const canLoadMore = hasMoreVersions(versions.length, total)

  return (
    <div
      data-testid={documentVersionsPanelTestIds.root}
      data-open={props.open === false ? "false" : "true"}
      className={cn("flex h-full flex-col", className)}
    >
      <Tabs defaultValue="history" className="flex h-full flex-col">
        <TabsList className="mx-3 mt-2 mb-1 self-start">
          <TabsTrigger value="history">Historial</TabsTrigger>
          <TabsTrigger value="diff" className={cn(!selectedForDiff && "pointer-events-none opacity-50")}>
            Comparar{selectedForDiff ? ` · v${selectedForDiff.version}` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col px-3 pb-2">
          {loadState.kind === "loading" ? (
            <div className="space-y-1 rounded-lg border border-border" role="status" aria-label="Cargando historial">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : loadState.kind === "error" ? (
            <div
              role="alert"
              data-testid="versions-error"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <p>{loadState.message}</p>
              <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => void loadPage(0)}>
                Reintentar
              </Button>
            </div>
          ) : versions.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
              <History className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">Aún no hay versiones guardadas</p>
              <p className="text-xs text-muted-foreground">
                Cada vez que guardes una edición aparecerá aquí con su fecha y su tipo.
              </p>
            </div>
          ) : (
            <>
              <ul
                data-testid={documentVersionsPanelTestIds.list}
                className="min-h-0 flex-1 divide-y divide-border overflow-auto rounded-lg border border-border"
              >
                {versions.map((version) => {
                  const isHead = version === versions[0]
                  const isSelected = selectedId === version.id
                  return (
                    <li key={version.id} data-testid={documentVersionsPanelTestIds.item}>
                      <button
                        type="button"
                        onClick={() => void handleSelectVersion(version)}
                        aria-expanded={isSelected}
                        className={cn(
                          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                          isSelected && "bg-muted",
                        )}
                      >
                        <span className="mt-0.5 flex h-7 shrink-0 items-center justify-center rounded-md bg-muted px-2 text-xs font-semibold">
                          v{version.version}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                            <span className="truncate">{editionKindLabel(version)}</span>
                            {isHead && (
                              <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                                Actual
                              </span>
                            )}
                            {!version.validationPassed && (
                              <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                                Sin validar
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {formatRelativeTime(version.createdAt)}
                            {version.summary ? ` · ${version.summary}` : ""}
                            {version.createdByChatId ? ` · desde un chat` : ""}
                          </span>
                        </span>
                      </button>
                      {isSelected && (
                        <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => void handleSelectVersion(version)}>
                            Cerrar comparación
                          </Button>
                          {restoringId === version.id ? (
                            <Button size="sm" className="h-7 gap-1.5" disabled>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Restaurando…
                            </Button>
                          ) : confirmingId === version.id ? (
                            <span className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                ¿Crear una nueva versión con el contenido de la v{version.version}?
                              </span>
                              <Button size="sm" variant="ghost" className="h-7" onClick={handleRestoreCancel}>
                                Cancelar
                              </Button>
                              <Button size="sm" className="h-7 gap-1.5" onClick={() => void handleRestoreConfirm()}>
                                <RotateCcw className="h-3.5 w-3.5" />
                                Confirmar restauración
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 gap-1.5"
                              onClick={() => handleRestoreClick(version)}
                              disabled={restoringId !== null}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Restaurar esta versión
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {total} {total === 1 ? "versión" : "versiones"} en total
                </p>
                {canLoadMore && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={handleLoadMore} disabled={loadingMore}>
                    {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Cargar más
                  </Button>
                )}
              </div>
            </>
          )}
          {restoreError && (
            <p role="alert" data-testid="restore-error" className="mt-2 text-xs text-destructive">
              {restoreError}
            </p>
          )}
        </TabsContent>

        <TabsContent value="diff" className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
          {diffLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground" role="status">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Calculando diferencias…
            </div>
          ) : diffError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {diffError}
            </div>
          ) : !selectedForDiff || selectedMarkdown === null ? (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
              Selecciona una versión del historial para compararla con la actual.
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Comparando v{selectedForDiff.version} con la versión actual ({stats.additions} añadidas,{" "}
                  {stats.deletions} eliminadas)
                </span>
                <span>Solo lectura</span>
              </div>
              <div
                data-testid={documentVersionsPanelTestIds.diff}
                className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/20 font-mono text-xs leading-relaxed"
              >
                {diffLinesList.map((line, index) => (
                  <div
                    key={`${line.type}-${index}`}
                    className={cn(
                      "whitespace-pre-wrap break-words px-3 py-0.5",
                      line.type === "added" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                      line.type === "removed" && "bg-red-500/10 text-red-800 dark:text-red-200",
                      line.type === "equal" && "text-muted-foreground",
                    )}
                  >
                    <span aria-hidden="true" className="mr-2 inline-block w-3 select-none opacity-70">
                      {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                    </span>
                    {line.text || " "}
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
