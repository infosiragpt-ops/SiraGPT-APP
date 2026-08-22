"use client"

/**
 * DocumentEditorPanel — the human-facing rich-text editor for uploaded
 * documents in /chat. A slim dialog that:
 *   1. Loads the file's extracted content (getFileContent) as Markdown.
 *   2. Renders the shared TiptapEditor (editable) with the standard toolbar.
 *   3. Guardar  → persists the edit as a new FileVersion (POST /files/:id/edit)
 *      and calls onSaved(version) so the chat can attach it to a turn.
 *   4. Exportar → client-side .md / .txt / .docx (docx via lib/download-utils
 *      docx stack passthrough in lib/chat/document-editor).
 *   5. Cerrar  → discards (Cancelar) or closes after saving.
 *
 * Autosave resilience (front docsave 2026-08-22): every keystroke re-arms a
 * debounced save (~1.5s) and mirrors the content into a localStorage draft
 * keyed by (fileId, userId). Network failures retry with backoff
 * (0.5s/2s/8s) before surfacing a persistent error with "Reintentar ahora".
 * When the stored draft is newer than the server content, an explicit
 * recovery banner offers "Restaurar borrador / Descartar" — never silent
 * overwrites in either direction. While there are unsaved changes, closing
 * the tab warns via native beforeunload. Golden rule: NEVER lose an edit.
 *
 * Lazy-load friendly: import normally, callers may `next/dynamic` it (the
 * chat does exactly that, and TiptapEditor is NOT SSR-safe, so the chat mounts
 * the panel with `ssr: false`).
 */

import * as React from "react"
import { Loader2, Save, Download, X, FileText } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { TiptapEditor } from "@/components/editor/tiptap-editor"
import {
  contentToMarkdown,
  buildExportBlob,
  saveEditedDocument,
  isEditorContentWithinLimits,
  type DocExportFormat,
  type EditorSaveResult,
} from "@/lib/chat/document-editor"
import { useDocumentAutosave, type AutosaveStatus } from "@/hooks/use-document-autosave"
import { downloadFile } from "@/lib/download-utils"

export type DocumentEditorPanelProps = {
  open: boolean
  /** The uploaded file as it appears in the composer's `uploadedFiles`. */
  file?: unknown
  /** Survives shallow diffs of `file` (uploadedFiles changes identity often). */
  fileId?: string
  fileName?: string
  format?: "docx" | "pdf" | "md" | "txt" | string
  /** Extract the content — callers with the info available can avoid a refetch. */
  initialContent?: string
  loadContent?: (fileId: string) => Promise<string | null>
  /** The app's apiClient (has saveDocumentEdit/getFileContent); accepts unknown
   *  because the real ApiClient's `request` member is private. */
  apiClient?: unknown
  /** Chat that owns the conversation turn this edit belongs to. */
  chatId?: string
  /** Human-readable summary stored on the new FileVersion. */
  summary?: string
  /** Owner id for the local draft key (localStorage is per-browser). */
  userId?: string | null
  /** Turn the ~1.5s debounced autosave off (manual-save-only mode). */
  autosaveEnabled?: boolean
  className?: string
  onClose: () => void
  onSaved?: (result: EditorSaveResult) => void
}

const EDITABLE_EXT_RE = /\.(?:md|markdown|txt|docx?|pdf|rtf|odt|ods|odp|pptx?|xlsx?|csv)$/i

function resolveFileId(source: unknown, fallbackId?: string): string | null {
  if (typeof fallbackId === "string" && fallbackId) return fallbackId
  if (typeof source === "string") return source
  if (!source || typeof source !== "object") return null
  const record = source as Record<string, unknown>
  const candidate = record.id ?? record.fileId ?? record.attachmentId ?? record.tempId
  if (typeof candidate === "string" && candidate) return candidate
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate)
  return null
}

function resolveFileName(source: unknown, fallbackName?: string): string {
  if (typeof fallbackName === "string" && fallbackName.trim()) return fallbackName
  if (!source || typeof source !== "object") return "documento"
  const record = source as Record<string, unknown>
  const candidate = record.originalName ?? record.name ?? record.filename ?? record.fileName
  return typeof candidate === "string" && candidate.trim() ? candidate : "documento"
}

function resolveFormat(source: unknown, explicit?: string): string {
  const name = resolveFileName(source)
  const mime = source && typeof source === "object"
    ? String((source as Record<string, unknown>).mimeType ?? (source as Record<string, unknown>).type ?? "")
    : ""
  if (explicit) return explicit
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (ext) return ext
  if (/word|document/.test(mime)) return "docx"
  if (/pdf/.test(mime)) return "pdf"
  return "txt"
}

/** Stable per-session mutation id so retried saves dedupe server-side. */
function newMutationId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
  } catch { /* older runtime */ }
  return `cme-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const exportFormatLabel: Record<DocExportFormat, string> = {
  md: ".md",
  txt: ".txt",
  docx: ".docx",
}

export function DocumentEditorPanel(props: DocumentEditorPanelProps) {
  const { open, file, fileId, fileName, format, initialContent, onClose, onSaved, chatId, summary } = props
  const loadContent = props.loadContent
  const apiClient = props.apiClient
  const resolvedUserId = props.userId ?? null

  const tDocuments = useTranslations("documents")
  const timeFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }),
    [],
  )

  const resolvedFileId = resolveFileId(file, fileId)
  const resolvedFileName = resolveFileName(file, fileName)
  const resolvedFormat = resolveFormat(file, format)

  // ---- Content loading ---------------------------------------------------
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [content, setContent] = React.useState<string>("")
  const [contentLoaded, setContentLoaded] = React.useState(false)
  // Epoch ms of the server content we loaded — the reference clock the draft
  // banner compares against ("draft newer than server").
  const [serverLoadedAt, setServerLoadedAt] = React.useState<number>(0)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    const boot = async () => {
      if (typeof initialContent === "string" && initialContent) {
        setContent(contentToMarkdown(initialContent))
        setContentLoaded(true)
        setLoadingContent(false)
        setServerLoadedAt(Date.now())
        return
      }
      if (!resolvedFileId) {
        setContent("")
        setContentLoaded(true)
        setLoadingContent(false)
        setServerLoadedAt(Date.now())
        return
      }
      setLoadingContent(true)
      try {
        const text = loadContent
          ? await loadContent(resolvedFileId)
          : null
        if (cancelled) return
        if (typeof text === "string" && text) {
          setContent(contentToMarkdown(text))
        } else {
          // Default loader: extracted content endpoint via the injected client.
          let fetched = ""
          const client = apiClient as { getFileContent?: (id: string) => Promise<string> } | undefined
          if (typeof client?.getFileContent === "function") {
            fetched = await client.getFileContent(resolvedFileId).catch(() => "")
          }
          if (cancelled) return
          setContent(contentToMarkdown(fetched))
        }
      } catch {
        if (!cancelled) setContent("")
      } finally {
        if (!cancelled) {
          setContentLoaded(true)
          setLoadingContent(false)
          setServerLoadedAt(Date.now())
        }
      }
    }

    setContentLoaded(false)
    void boot()
    return () => { cancelled = true }
  }, [open, resolvedFileId, initialContent, loadContent, apiClient])

  // ---- Editor state ------------------------------------------------------
  const [markdown, setMarkdown] = React.useState<string>("")
  const [saving, setSaving] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const manualSaveFailedRef = React.useRef(false)

  // Stable per-dialog mutation id: retries of one logical edit reuse it so
  // POST /files/:id/edit can dedupe a lost-response race server-side.
  const clientMutationIdRef = React.useRef<string>(newMutationId())

  // ---- Draft recovery ----------------------------------------------------
  const [pendingDraft, setPendingDraft] = React.useState<{ content: string; savedAt: number } | null>(null)
  const draftCheckedForRef = React.useRef<string | null>(null)

  // ---- Autosave core ------------------------------------------------------
  const performServerSave = React.useCallback(async (md: string): Promise<EditorSaveResult> => {
    // Attachments without a resolvable id cannot persist; failing here routes
    // the autosave machinery into its visible retry/error state instead of
    // silently pretending the edit was saved.
    if (!resolvedFileId) throw new Error("document file id unavailable")
    const result = await saveEditedDocument({
      apiClient: apiClient ?? {},
      fileId: resolvedFileId,
      markdown: md,
      chatId,
      summary: summary ?? "Edición manual desde el editor de documentos",
      clientMutationId: clientMutationIdRef.current,
    })
    // The server durably confirmed this exact content → a fresh logical edit
    // starts from here; reuse would collapse two different edits into one.
    clientMutationIdRef.current = newMutationId()
    return result
  }, [apiClient, resolvedFileId, chatId, summary])

  const autosave = useDocumentAutosave({
    fileId: open ? resolvedFileId : null,
    userId: resolvedUserId,
    baseVersion: 0,
    enabled: props.autosaveEnabled !== false,
    save: React.useCallback(async (md: string) => {
      await performServerSave(md)
    }, [performServerSave]),
  })

  // Surface the recovery banner once per (file, dialog session), only when a
  // stored draft exists that is newer than what we just loaded from the
  // server AND differs from it. Never automatic: restore/discard is explicit.
  React.useEffect(() => {
    if (!open || !resolvedFileId || !contentLoaded) return
    if (draftCheckedForRef.current === `${resolvedFileId}:${String(initialContent ?? "")}`) return
    draftCheckedForRef.current = `${resolvedFileId}:${String(initialContent ?? "")}`
    const draft = autosave.recoverableDraft(serverLoadedAt)
    if (draft) setPendingDraft({ content: draft.content, savedAt: draft.savedAt })
  }, [open, resolvedFileId, contentLoaded, serverLoadedAt, initialContent, autosave])

  const handleRestoreDraft = React.useCallback(() => {
    if (!pendingDraft) return
    setMarkdown(pendingDraft.content)
    autosave.restoreDraft({ content: pendingDraft.content, savedAt: pendingDraft.savedAt, baseVersion: 0 })
    setPendingDraft(null)
  }, [pendingDraft, autosave])

  const handleDiscardDraft = React.useCallback(() => {
    autosave.discardDraft()
    setPendingDraft(null)
  }, [autosave])

  // ---- Status pill ---------------------------------------------------------
  const statusLabel = React.useMemo(() => {
    const st: AutosaveStatus = saving ? "saving" : autosave.status
    switch (st) {
      case "dirty":
      case "idle":
      default:
        return null
      case "saving":
        return tDocuments("autosaveSaving")
      case "saved":
        return tDocuments("autosaveSaved", {
          time: autosave.lastSavedAt
            ? timeFormatter.format(new Date(autosave.lastSavedAt))
            : timeFormatter.format(new Date()),
        })
      case "error":
        return autosave.attempt > 0
          ? tDocuments("autosaveError")
          : tDocuments("autosaveErrorFinal")
    }
  }, [saving, autosave.status, autosave.lastSavedAt, autosave.attempt, tDocuments, timeFormatter])

  const showAutosaveOffHint =
    props.autosaveEnabled === false &&
    autosave.status !== "idle" &&
    !statusLabel

  const handleEditorChange = React.useCallback((next: string) => {
    setMarkdown(next)
    autosave.notifyChange(next)
  }, [autosave])

  // Keep the editor's initial value in sync with the loaded content.
  const editorInitial = contentLoaded ? content : ""

  // ---- Actions -----------------------------------------------------------
  const handleClose = React.useCallback(() => {
    if (saving) return
    setMarkdown("")
    setContent("")
    setContentLoaded(false)
    setPendingDraft(null)
    draftCheckedForRef.current = null
    autosave.markClean()
    onClose()
  }, [saving, onClose, autosave])

  const handleSave = React.useCallback(async () => {
    if (!resolvedFileId || saving) return
    if (markdown.length > 0 && !isEditorContentWithinLimits(markdown)) {
      toast.error("El documento es demasiado grande para guardarlo")
      return
    }
    setSaving(true)
    try {
      const result = await performServerSave(markdown)
      autosave.markClean()
      toast.success("Documento guardado")
      onSaved?.(result)
      onClose()
    } catch (err) {
      console.error("[document-editor] save failed:", err)
      // Keep the panel open + dirty state intact: autosave/backoff keeps
      // retrying and the draft stays in localStorage either way.
      toast.error(`No se pudo guardar: ${err instanceof Error ? err.message : "error desconocido"}`)
    } finally {
      setSaving(false)
    }
  }, [resolvedFileId, saving, markdown, performServerSave, autosave, onSaved, onClose])

  const handleRetryNow = React.useCallback(() => {
    autosave.retryNow()
  }, [autosave])

  const handleExport = React.useCallback(async (formatKey: DocExportFormat) => {
    if (exporting) return
    setExporting(true)
    try {
      const { blob, filename } = await buildExportBlob(markdown || editorInitial, formatKey, resolvedFileName)
      downloadFile(blob, filename)
      toast.success(`Exportado como ${exportFormatLabel[formatKey]}`)
    } catch (err) {
      console.error("[document-editor] export failed:", err)
      toast.error("No se pudo exportar el documento")
    } finally {
      setExporting(false)
    }
  }, [exporting, markdown, editorInitial, resolvedFileName])

  // Every text-ish upload is editable (we edit the extracted text as Markdown);
  // binary-only uploads not matching the document set stay editable too, since
  // extracted text still gives the user a working text pane.
  const canEdit = true

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent
        className={cn("w-[min(96vw,1000px)] max-w-none gap-3 p-0 sm:rounded-xl", props.className)}
        showCloseButton={false}
      >
        <DialogHeader className="border-b px-5 py-3 text-left">
          <div className="flex items-center gap-3">
            <FileText className="h-4.5 w-4.5 text-muted-foreground" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">Editor de documentos</DialogTitle>
              <DialogDescription className="truncate text-xs">
                {resolvedFileName} · {String(resolvedFormat).toUpperCase()} — el guardado crea una nueva versión, el original no se modifica.
              </DialogDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Discrete autosave status — visible but never in the way. */}
              {(statusLabel || showAutosaveOffHint) && (
                <span
                  data-testid="document-autosave-status"
                  className={cn(
                    "hidden truncate text-xs text-muted-foreground sm:inline",
                    autosave.status === "error" && "text-destructive",
                  )}
                >
                  {showAutosaveOffHint ? (
                    <>
                      {tDocuments("autosaveOff")}
                    </>
                  ) : autosave.status === "saving" ? (
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin align-[-1px]" />
                  ) : null}
                  {showAutosaveOffHint ? null : statusLabel}
                </span>
              )}
              {autosave.status === "error" && !saving && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetryNow}
                  disabled={saving}
                  className="h-8 gap-1.5"
                >
                  {tDocuments("autosaveRetryNow")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                disabled={saving}
                className="h-8 gap-1.5 text-muted-foreground"
              >
                <X className="h-4 w-4" />
                Cancelar
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={exporting || !contentLoaded}
                    className="h-8 gap-1.5"
                  >
                    {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Exportar
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => handleExport("docx")} disabled={exporting}>
                    Exportar como Word (.docx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleExport("md")} disabled={exporting}>
                    Exportar como Markdown (.md)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleExport("txt")} disabled={exporting}>
                    Exportar como Texto (.txt)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !contentLoaded || !resolvedFileId}
                className="h-8 gap-1.5"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Guardar
              </Button>
            </div>
          </div>
        </DialogHeader>

        {pendingDraft && (
          <div
            data-testid="document-draft-banner"
            role="alert"
            className="mx-5 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 text-amber-900 dark:text-amber-100">
              {tDocuments("draftBannerTitle")}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleRestoreDraft} className="h-7">
                {tDocuments("draftRestore")}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDiscardDraft} className="h-7 text-muted-foreground">
                {tDocuments("draftDiscard")}
              </Button>
            </span>
          </div>
        )}

        <div className="h-[min(72vh,640px)] overflow-hidden px-0 pb-2">
          {loadingContent ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Cargando contenido…
            </div>
          ) : (
            <TiptapEditor
              initialMarkdown={editorInitial}
              onChange={handleEditorChange}
              placeholder="Empieza a escribir…"
              editable={canEdit}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
