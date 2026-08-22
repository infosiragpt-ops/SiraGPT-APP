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
 * Lazy-load friendly: import normally, callers may `next/dynamic` it (the
 * chat does exactly that, and TiptapEditor is NOT SSR-safe, so the chat mounts
 * the panel with `ssr: false`).
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { Loader2, Save, Download, X, FileText, Send } from "lucide-react"
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
import {
  DocBridgeError,
  docFileNameForImport,
  sendDocumentToCode,
} from "@/lib/code-doc-bridge"
import {
  CODE_ACTIVE_CODEX_PROJECT_EVENT,
  getActiveCodexProject,
  useOptionalCodeWorkspace,
} from "@/lib/code-workspace-context"
import { codexApi, type CodexProject } from "@/lib/codex/codex-api"
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
  const tBridge = useTranslations("documents.docBridge")

  const resolvedFileId = resolveFileId(file, fileId)
  const resolvedFileName = resolveFileName(file, fileName)
  const resolvedFormat = resolveFormat(file, format)

  // ---- Content loading ---------------------------------------------------
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [content, setContent] = React.useState<string>("")
  const [contentLoaded, setContentLoaded] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    const boot = async () => {
      if (typeof initialContent === "string" && initialContent) {
        setContent(contentToMarkdown(initialContent))
        setContentLoaded(true)
        setLoadingContent(false)
        return
      }
      if (!resolvedFileId) {
        setContent("")
        setContentLoaded(true)
        setLoadingContent(false)
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

  const handleEditorChange = React.useCallback((next: string) => {
    setMarkdown(next)
  }, [])

  // Keep the editor's initial value in sync with the loaded content.
  const editorInitial = contentLoaded ? content : ""

  // ---- Export / send-to-code actions -------------------------------------
  const [exporting, setExporting] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  // Optional picker: when the user is not inside an active Codex project we
  // lazily list their projects so they can choose the target.
  const workspace = useOptionalCodeWorkspace()
  const [projectPicker, setProjectPicker] = React.useState<CodexProject[] | null>(null)

  const resolveActiveProjectId = React.useCallback((): string | null => {
    const singleton = getActiveCodexProject()
    if (singleton) return singleton
    if (typeof window === "undefined") return null
    try {
      const raw = window.localStorage.getItem("siragpt:active-codex-project")
      return raw && raw.trim() ? raw.trim() : null
    } catch {
      return null
    }
  }, [])

  const handleSendToCode = React.useCallback(
    async (projectId?: string) => {
      const markdownText = markdown || editorInitial
      if (sending) return
      if (!markdownText.trim()) {
        toast.error(tBridge("openInEditorEmpty"))
        return
      }
      setSending(true)
      try {
        const resolvedProjectId = projectId ?? resolveActiveProjectId()
        if (!resolvedProjectId) {
          // No active project — offer the user's project list once.
          let options = projectPicker
          if (!options) {
            options = await codexApi.listProjects().catch(() => [])
            setProjectPicker(options)
          }
          if (!options || options.length === 0) {
            toast.error(tBridge("sendToCodeNoProject"))
            return
          }
          const label = options.map((p, i) => `${i + 1}) ${p.name}`).join("   ")
          const answer = typeof window !== "undefined" ? window.prompt(`${tBridge("sentToCode", { name: "" })}\n${label}`) : null
          const index = answer ? Number.parseInt(answer, 10) - 1 : Number.NaN
          const chosen = options[Number.isInteger(index) ? index : -1]
          if (!chosen) return
          await sendDocumentToCode({
            projectId: chosen.id,
            fileName: resolvedFileName,
            markdown: markdownText,
            importFiles: codexApi.importFiles,
          })
        } else {
          await sendDocumentToCode({
            projectId: resolvedProjectId,
            fileName: resolvedFileName,
            markdown: markdownText,
            importFiles: codexApi.importFiles,
          })
        }
        toast.success(tBridge("sentToCode", { name: docFileNameForImport(resolvedFileName) }))
      } catch (err) {
        if (err instanceof DocBridgeError && err.code === "no_project") {
          toast.error(tBridge("sendToCodeNoProject"))
        } else {
          console.error("[document-editor] send-to-code failed:", err)
          toast.error(`${tBridge("sendToCodeFailed")}: ${err instanceof Error ? err.message : ""}`.trim())
        }
      } finally {
        setSending(false)
      }
    },
    [sending, markdown, editorInitial, resolveActiveProjectId, projectPicker, resolvedFileName, tBridge],
  )

  // Keep the send action enabled when an active project appears while open.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onActiveCodexProject = () => setProjectPicker(null)
    window.addEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, onActiveCodexProject)
    return () => window.removeEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, onActiveCodexProject)
  }, [])

  // Workspace context (when mounted under it) also exposes the active folder.
  React.useEffect(() => {
    if (workspace?.activeFolder?.id) setProjectPicker(null)
  }, [workspace?.activeFolder?.id])


  const handleClose = React.useCallback(() => {
    if (saving) return
    setMarkdown("")
    setContent("")
    setContentLoaded(false)
    onClose()
  }, [saving, onClose])

  const handleSave = React.useCallback(async () => {
    if (!resolvedFileId || saving) return
    if (markdown.length > 0 && !isEditorContentWithinLimits(markdown)) {
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
  }, [resolvedFileId, saving, markdown, apiClient, onSaved, onClose, chatId, summary])

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
              <Button
                variant="outline"
                size="sm"
                disabled={sending || !contentLoaded}
                className="h-8 gap-1.5"
                onClick={() => void handleSendToCode()}
                title={tBridge("sendToCodeTitle")}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {tBridge("sendToCode")}
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