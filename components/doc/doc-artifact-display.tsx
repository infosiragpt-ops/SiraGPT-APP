"use client"

/**
 * DocArtifactDisplay — inline renderer for `doc`-typed files.
 *
 * Shows three things when available:
 *   1. A file card (icon + filename + size + badge + actions).
 *   2. An inline preview of the document content. Rendered source
 *      per format:
 *        · docx  — server-side mammoth → HTML, embedded in an iframe
 *                  sandbox so its styles never leak into the chat.
 *        · xlsx  — server-side ExcelJS → styled HTML table(s) per
 *                  sheet, also inside an iframe.
 *        · pdf   — native <embed type="application/pdf"/>.
 *        · svg   — <img src={dataUrl}/> (SVG renders as picture).
 *        · pptx  — render-agent HTML preview + native PPTX download.
 *   3. A collapsible "Ver código" panel showing the Python snippet
 *      that produced the file.
 *
 * The iframe preview uses sandbox="" (empty) — scripts are *not*
 * allowed; we only need the document rendering. This means mammoth/
 * Office-derived HTML is displayed safely even if a malicious server ever
 * slipped a <script> through.
 */

import * as React from "react"
import {
  Download, Code2, ChevronDown, ChevronUp,
  Eye, EyeOff} from "lucide-react"

import { DOCUMENT_ACTION_CLASS, DOCUMENT_ACTION_ICON_CLASS, DOCUMENT_CARD_CLASS, DocumentArtifactIcon } from "./document-artifact-chrome"
import type { DocumentPreviewTarget } from "@/components/document-preview"
import { downloadUrlAsFile } from "@/lib/utils"
import { toast } from "sonner"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface DocFile {
  type: "doc"
  format: "docx" | "xlsx" | "pptx" | "pdf" | "svg" | "csv"
  title?: string
  explanation?: string
  filename: string
  // Phase 3 (ArtifactUrlResolver): the doc-pipeline now persists
  // bytes and hands the chat a real `/api/agent/artifact/<id>` URL.
  // `dataUrl` stays for backward compat with messages persisted
  // before the cutover (and as a fallback when the artifact store
  // is unreachable).
  url?: string | null
  dataUrl?: string | null
  mime?: string
  size?: number
  htmlPreview?: string | null    // server-rendered HTML for docx/xlsx
  pythonCode?: string
}

function formatBytes(n?: number) {
  if (!n || n <= 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DocArtifactDisplay({ files, onDocumentPreview }: {
  files: any[]
  onDocumentPreview?: (target: DocumentPreviewTarget) => void
}) {
  const docs = React.useMemo<DocFile[]>(
    () => (Array.isArray(files) ? files.filter((f: any) => f?.type === "doc") : []),
    [files]
  )
  if (docs.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {docs.map((d, i) => <DocCard key={i} doc={d} onDocumentPreview={onDocumentPreview} />)}
    </div>
  )
}

function htmlPreviewDataUrl(html: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function DocCard({ doc, onDocumentPreview }: { doc: DocFile; onDocumentPreview?: (target: DocumentPreviewTarget) => void }) {
  // Source for preview / download — prefer the auth-gated URL when
  // the pipeline hands one back, otherwise fall through to the
  // legacy data URL (backward compat with messages persisted before
  // the ArtifactUrlResolver cutover).
  const sourceUrl: string | null = (doc.url && doc.url.length > 0)
    ? doc.url
    : (doc.dataUrl && doc.dataUrl.startsWith("data:") ? doc.dataUrl : null)
  const available = !!sourceUrl
  const hasHtmlPreview = !!doc.htmlPreview && doc.htmlPreview.length > 0
  const hasPdfPreview = doc.format === "pdf" && available
  const hasSvgPreview = doc.format === "svg" && available
  const anyPreview = hasHtmlPreview || hasPdfPreview || hasSvgPreview
  const canPreview = onDocumentPreview ? (available || hasHtmlPreview) : anyPreview

  // When the parent provides a right-pane preview, keep the card
  // compact and open the split panel only on user click.
  const [previewOpen, setPreviewOpen] = React.useState<boolean>(anyPreview && !onDocumentPreview)
  const [codeOpen, setCodeOpen] = React.useState(false)
  const [isDownloading, setIsDownloading] = React.useState(false)

  function preview() {
    if (onDocumentPreview && hasHtmlPreview) {
      onDocumentPreview({
        url: htmlPreviewDataUrl(doc.htmlPreview as string),
        downloadUrl: sourceUrl || undefined,
        filename: doc.filename,
      })
      return
    }
    if (onDocumentPreview && sourceUrl) {
      onDocumentPreview({
        url: sourceUrl,
        downloadUrl: sourceUrl,
        filename: doc.filename,
      })
      return
    }
    if (anyPreview) setPreviewOpen(v => !v)
  }

  async function download() {
    if (!sourceUrl || isDownloading) return
    setIsDownloading(true)
    try {
      // /api/agent/artifact/<id> is auth-gated; cookies alone are
      // not enough on this app (JWT lives in localStorage). data:
      // and blob: URLs ignore the init silently and download via
      // the existing branches in downloadUrlAsFile.
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      await downloadUrlAsFile(sourceUrl, doc.filename, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
    } catch (error) {
      console.error("[DocArtifactDisplay] download failed:", error)
      toast.error("No se pudo descargar el documento")
    } finally {
      setIsDownloading(false)
    }
  }

  const previewLabel = !onDocumentPreview && previewOpen ? "Ocultar documento" : "Ver documento"
  return (
    <div className={DOCUMENT_CARD_CLASS} data-testid="generated-document-card" aria-label={`Archivo: ${doc.filename}`} role="group">
      {/* Header card — always visible */}
      <div className="flex items-center gap-3 p-3">
        <DocumentArtifactIcon format={doc.format} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-semibold text-foreground" title={doc.title || doc.filename}>
            {doc.title || doc.filename}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{doc.format.toUpperCase()}</span>
            {doc.size ? <span>{formatBytes(doc.size)}</span> : null}
            {doc.title && doc.title !== doc.filename ? <span className="max-w-full truncate" title={doc.filename}>{doc.filename}</span> : null}
          </div>
          {doc.explanation && (
            <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground/90">
              {doc.explanation}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={preview}
              className={DOCUMENT_ACTION_CLASS}
              title={`${previewLabel}: ${doc.filename}`}
              aria-label={`${previewLabel}: ${doc.filename}`}
              aria-expanded={!onDocumentPreview ? previewOpen : undefined}
            >
              {!onDocumentPreview && previewOpen ? <EyeOff className={DOCUMENT_ACTION_ICON_CLASS} aria-hidden="true" /> : <Eye className={DOCUMENT_ACTION_ICON_CLASS} aria-hidden="true" />}
            </button>
          )}
          <button
            type="button"
            onClick={download}
            disabled={!available || isDownloading}
            className={DOCUMENT_ACTION_CLASS}
            title={isDownloading ? "Descargando documento" : `Descargar ${doc.filename}`}
            aria-label={`Descargar documento: ${doc.filename}`}
            aria-busy={isDownloading}
          >
            {isDownloading
              ? <ThinkingIndicator size="sm" className="h-[18px] w-[18px]" />
              : <Download className={DOCUMENT_ACTION_ICON_CLASS} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Preview area */}
      {previewOpen && anyPreview && (
        <div className="border-t border-border/50 bg-muted/5">
          {hasPdfPreview && sourceUrl ? (
            <embed src={sourceUrl} type="application/pdf" className="h-[70vh] w-full" />
          ) : hasSvgPreview && sourceUrl ? (
            <img
              src={sourceUrl}
              alt={doc.title || doc.filename}
              className="mx-auto max-h-[70vh] w-full bg-white dark:bg-zinc-900 object-contain"
            />
          ) : hasHtmlPreview ? (
            <iframe
              srcDoc={doc.htmlPreview!}
              // empty sandbox = scripts NOT allowed (preview is read-only)
              sandbox=""
              className="h-[70vh] w-full border-0 bg-white dark:bg-zinc-900"
              title={doc.title || doc.filename}
            />
          ) : null}
        </div>
      )}

      {/* Code toggle — shows the Python that produced the file */}
      {doc.pythonCode && (
        <div className="border-t border-border/50">
          <button
            onClick={() => setCodeOpen(v => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/20 transition-colors"
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Ver código Python</span>
            {codeOpen
              ? <ChevronUp className="ml-auto h-3.5 w-3.5" />
              : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
          </button>
          {codeOpen && (
            <pre className="max-h-[40vh] overflow-auto border-t border-border/50 bg-[#0b1220] p-3 text-[11.5px] leading-snug text-[#e2e8f0]">
              <code>{doc.pythonCode}</code>
            </pre>
          )}
        </div>
      )}

      {!available && (
        <div className="border-t border-border/50 bg-muted/10 px-3 py-2 text-[11.5px] text-muted-foreground">
          El archivo estuvo disponible durante la sesión en que se generó. Para volver a descargarlo, pedime que lo regenere.
        </div>
      )}
    </div>
  )
}
