"use client"

/**
 * DocumentEditorPanel — the human-facing rich-text editor for uploaded
 * documents in /chat. A slim dialog that:
 *   1. Decides the edit mode EARLY: for files without injected content it
 *      asks GET /files/:id/meta first and picks single-doc vs chunked
 *      (paginated) mode WITHOUT downloading the body.
 *   2. Normal documents load the extracted content (getFileContent) as
 *      Markdown and render the shared TiptapEditor with the standard toolbar.
 *   3. LARGE documents (>8MB Markdown ≈ 500+ pages) never load whole: a pager
 *      shows "chunk N de M" where each chunk is its own lazily-loaded Tiptap
 *      instance; edits are held per page and reassembled EXACTLY on save.
 *   4. Guardar → persists the edit as a new FileVersion via the unchanged
 *      POST /files/:id/edit contract and calls onSaved(version).
 *   5. Exportar / Cerrar behave as before (export works on what is loaded;
 *      in chunked mode it exports the current page to stay within memory).
 *
 * Lazy-load friendly: import normally, callers may `next/dynamic` it (the
 * chat does exactly that, and TiptapEditor is NOT SSR-safe, so the chat mounts
 * the panel with `ssr: false`).
 */

import * as React from "react"
import { ChevronLeft, ChevronRight, Loader2, Save, Download, X, FileText } from "lucide-react"
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
  isEditorContentWithinLimits as isWithinLimits,
  type DocExportFormat,
  type EditorSaveResult,
} from "@/lib/chat/document-editor"
import {
  ChunkedDocumentController,
  type ChunkFileMeta,
} from "@/components/chat/chunked-editor-controller"
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
  /** The app's apiClient (has saveDocumentEdit/getFileContent/getFileMeta/getFileChunk); accepts unknown
   *  because the real ApiClient's `request` member is private. */
  apiClient?: unknown
  /** Chat that owns the conversation turn this edit belongs to. */
  chatId?: string
  /** Human-readable summary stored on the new FileVersion. */
  summary?: string
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

export const exportFormatLabel: Record<DocExportFormat, string> = {
  md: ".md",
  txt: ".txt",
  docx: ".docx",
}

export function DocumentEditorPanel(props: DocumentEditorPanelProps) {
  const { open, file, fileId, fileName, format, initialContent, onClose, onSaved, chatId, summary } = props
  const loadContent = props.loadContent
  const apiClient = props.apiClient

  const resolvedFileId = resolveFileId(file, fileId)
  const resolvedFileName = resolveFileName(file, fileName)
  const resolvedFormat = resolveFormat(file, format)

  // ---- Mode + content loading ---------------------------------------------
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [content, setContent] = React.useState<string>("")
  const [contentLoaded, setContentViewLoaded] = React.useState(false)
  /** Chunked (paginated) mode for large documents. */
  const [chunkedMode, setChunkedMode] = React.useState(false)
  const chunkedRef = React.useRef<ChunkedDocumentController | null>(null)

  // Pager state (chunked mode only).
  const [pageIndex, setPageIndex] = React.useState(0)
  const [totalChunks, setTotalChunks] = React.useState(0)
  const [pageContent, setPageContent] = React.useState("")
  const [pageLoading, setPageLoading] = React.useState(false)
  const [meta, setMeta] = React.useState<ChunkFileMeta | null>(null)

  // Reset per-open state whenever the dialog opens for a (possibly different)
  // document. Kept in one place so Cancel/Save/close cannot leak drafts.
  React.useEffect(() => {
    if (!open) return
    setChunkedMode(false)
    chunkedRef.current = null
    setMeta(null)
    setTotalChunks(0)
    setPageIndex(0)
    setPageContent("")
  }, [open, resolvedFileId])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    const boot = async () => {
      // Explicit injected content always uses the normal editor (the caller
      // vouches that it fits — it already lives in memory upstream).
      if (typeof initialContent === "string" && initialContent) {
        setContent(contentToMarkdown(initialContent))
        setContentViewLoaded(true)
        setLoadingContent(false)
        return
      }
      if (!resolvedFileId) {
        setContent("")
        setContentViewLoaded(true)
        setLoadingContent(false)
        return
      }

      setLoadingContent(true)
      try {
        if (loadContent) {
          const text = await loadContent(resolvedFileId)
          if (cancelled) return
          if (typeof text === "string" && text) {
            setContent(contentToMarkdown(text))
            return
          }
          // loadContent produced nothing → fall through to meta decision.
        } else {
          // Early mode decision BEFORE fetching any body: ask /:id/meta.
          const client = apiClient as { getFileMeta?: (id: string) => Promise<ChunkFileMeta> } | undefined
          let fileMeta: ChunkFileMeta | null = null
          if (typeof client?.getFileMeta === "function") {
            try {
              fileMeta = await client.getFileMeta(resolvedFileId)
            } catch {
              fileMeta = null
            }
          }
          if (cancelled) return

          if (fileMeta?.chunkedMode) {
            // Large document → paginated mode. The body is NEVER fetched whole.
            const controller = new ChunkedDocumentController({
              fileId: resolvedFileId,
              client: apiClient as never,
            })
            try {
              await controller.loadMeta()
            } catch {
              // Meta failed after a successful probe — degrade to normal mode.
              setMeta(null)
            }
            if (cancelled) return
            chunkedRef.current = controller
            setMeta(controller.meta ?? fileMeta)
            setTotalChunks(controller.totalChunks || fileMeta.estimatedTotalChunks || 0)
            setChunkedMode(true)
            setLoadingContent(false)
            setContentViewLoaded(true)
            return
          }

          // Normal document: fetch the body once through the injected client.
          let fetched = ""
          const contentClient = apiClient as { getFileContent?: (id: string) => Promise<string> } | undefined
          if (typeof contentClient?.getFileContent === "function") {
            fetched = await contentClient.getFileContent(resolvedFileId).catch(() => "")
          }
          if (cancelled) return
          setContent(contentToMarkdown(fetched))
        }
      } catch {
        if (!cancelled) setContent("")
      } finally {
        if (!cancelled) {
          setContentViewLoaded(true)
          setLoadingContent(false)
        }
      }
    }

    setContentViewLoaded(false)
    void boot()
    return () => { cancelled = true }
  }, [open, resolvedFileId, initialContent, loadContent, apiClient])

  // Load the current page whenever the pager moves (or mode engages).
  React.useEffect(() => {
    if (!chunkedMode) return
    const controller = chunkedRef.current
    if (!controller) return
    let cancelled = false
    const run = async () => {
      setPageLoading(true)
      try {
        const text = await controller.getPage(pageIndex)
        if (cancelled) return
        if (controller.totalChunks > 0) setTotalChunks(controller.totalChunks)
        setPageContent(text)
      } catch {
        if (!cancelled) {
          toast.error("No se pudo cargar la página del documento")
        }
      } finally {
        if (!cancelled) setPageLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [chunkedMode, pageIndex])

  const goToPage = React.useCallback((target: number) => {
    if (totalChunks <= 0) return
    const clamped = Math.max(0, Math.min(totalChunks - 1, Math.floor(target)))
    if (clamped !== pageIndex) setPageIndex(clamped)
  }, [pageIndex, totalChunks])

  // ---- Editor state ------------------------------------------------------
  const [markdown, setMarkdown] = React.useState<string>("")
  const [saving, setSaving] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  const handleEditorChange = React.useCallback((next: string) => {
    setMarkdown(next)
    // In chunked mode every keystroke lands in the page draft store, so the
    // edit survives navigation without keeping sibling pages mounted.
    chunkedRef.current?.setPageDraft(pageIndex, next)
  }, [pageIndex])

  // Keep the editor's initial value in sync with the loaded content.
  // Chunked mode swaps the surface entirely (see render below), so this stays
  // bound to the single-doc path.
  const editorInitial = contentLoaded && !chunkedMode ? content : ""

  // ---- Actions -----------------------------------------------------------
  const handleClose = React.useCallback(() => {
    if (saving) return
    setMarkdown("")
    setContent("")
    setContentViewLoaded(false)
    onClose()
  }, [saving, onClose])

  const handleSave = React.useCallback(async () => {
    if (!resolvedFileId || saving) return

    // ── Chunked mode: assemble the full document exactly once. ──
    if (chunkedMode) {
      const controller = chunkedRef.current
      if (!controller) return
      setSaving(true)
      let assembled = ""
      try {
        assembled = await controller.assembleForSave()
        const result = await saveEditedDocument({
          apiClient: apiClient ?? {},
          fileId: resolvedFileId,
          markdown: assembled,
          chatId,
          summary: summary ?? "Edición manual desde el editor de documentos",
        })
        // Persisted → drafts become the new clean baseline and only ONE full
        // copy lingers (cached page 0), released on close/navigation.
        controller.commitSave(assembled.length > 0 ? "" : undefined)
        toast.success("Documento guardado")
        onSaved?.(result)
        handleClose()
      } catch (err) {
        console.error("[document-editor] chunked save failed:", err)
        toast.error(`No se pudo guardar: ${err instanceof Error ? err.message : "error desconocido"}`)
      } finally {
        // Drop the assembled copy explicitly; drafts remain until commit.
        assembled = ""
        setSaving(false)
      }
      return
    }

    // ── Normal mode (unchanged contract) ──
    if (markdown.length > 0 && !isWithinLimits(markdown)) {
      toast.error("El documento es demasiado grande para guardarlo")
      return
    }
    setSaving(true)
    try {
      const result = await saveEditedDocument({
        apiClient: apiClient ?? {},
        fileId: resolvedFileId,
        markdown,
        chatId,
        summary: summary ?? "Edición manual desde el editor de documentos",
      })
      toast.success("Documento guardado")
      onSaved?.(result)
      onClose()
    } catch (err) {
      console.error("[document-editor] save failed:", err)
      toast.error(`No se pudo guardar: ${err instanceof Error ? err.message : "error desconocido"}`)
    } finally {
      setSaving(false)
    }
  }, [resolvedFileId, saving, markdown, chunkedMode, apiClient, onSaved, onClose, handleClose, chatId, summary])

  const handleExport = React.useCallback(async (formatKey: DocExportFormat) => {
    if (exporting) return
    setExporting(true)
    try {
      // Chunked mode exports the CURRENT PAGE only — exporting a 500-page
      // document would defeat the memory budget of this mode. UI says so.
      const payload = chunkedMode ? pageContent : (markdown || editorInitial)
      const { blob, filename } = await buildExportBlob(payload, formatKey, resolvedFileName)
      downloadFile(blob, filename)
      toast.success(chunkedMode
        ? `Página ${pageIndex + 1} exportada como ${exportFormatLabel[formatKey]}`
        : `Exportado como ${exportFormatLabel[formatKey]}`)
    } catch (err) {
      console.error("[document-editor] export failed:", err)
      toast.error("No se pudo exportar el documento")
    } finally {
      setExporting(false)
    }
  }, [exporting, markdown, editorInitial, resolvedFileName, chunkedMode, pageContent, pageIndex])

  // Every text-ish upload is editable (we edit the extracted text as Markdown);
  // binary-only uploads not matching the document set stay editable too, since
  // extracted text still gives the user a working text pane.
  const canEdit = true
  const busy = loadingContent || (chunkedMode && pageLoading && !contentLoaded)

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
                {chunkedMode && (
                  <span className="ml-2 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    Documento grande — modo paginado
                  </span>
                )}
              </DialogDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
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
                    disabled={exporting || !contentLoaded || (chunkedMode && pageLoading)}
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

        <div className="h-[min(72vh,640px)] overflow-hidden px-0 pb-2">
          {busy ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Cargando contenido…
            </div>
          ) : chunkedMode ? (
            <div className="flex h-full flex-col">
              {/* Pager: chunk N de M · prev/next · salto directo */}
              <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2"
                  disabled={pageIndex <= 0 || pageLoading}
                  onClick={() => goToPage(pageIndex - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  Página {pageIndex + 1} de {Math.max(totalChunks, 1)}
                  {totalChunks > 0 ? ` · ~${Math.max(meta?.contentChars ?? 0, 0).toLocaleString("es")} caracteres` : ""}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2"
                  disabled={totalChunks <= 0 || pageIndex >= totalChunks - 1 || pageLoading}
                  onClick={() => goToPage(pageIndex + 1)}
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <form
                  className="ml-auto flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const parsed = Number.parseInt(new FormData(event.currentTarget).get("jump") as string, 10)
                    if (Number.isFinite(parsed)) goToPage(parsed - 1)
                  }}
                >
                  <input
                    name="jump"
                    inputMode="numeric"
                    placeholder="Ir a…"
                    className="h-7 w-16 rounded-md border border-input bg-transparent px-2 text-xs tabular-nums outline-none focus-visible:border-ring"
                  />
                  <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    Ir
                  </Button>
                </form>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {pageLoading ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Cargando página…
                  </div>
                ) : (
                  // Each page is an independent, lazily-mounted Tiptap instance.
                  // Only ONE exists at a time — keying by pageIndex remounts it.
                  <TiptapEditor
                    key={`page-${pageIndex}`}
                    initialMarkdown={pageContent}
                    onChange={handleEditorChange}
                    placeholder="Empieza a escribir…"
                    editable={canEdit}
                  />
                )}
              </div>
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
