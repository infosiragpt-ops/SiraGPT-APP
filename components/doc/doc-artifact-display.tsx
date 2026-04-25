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
 *        · xlsx  — server-side SheetJS → styled HTML table(s) per
 *                  sheet, also inside an iframe.
 *        · pdf   — native <embed type="application/pdf"/>.
 *        · svg   — <img src={dataUrl}/> (SVG renders as picture).
 *        · pptx  — render-agent HTML preview + native PPTX download.
 *   3. A collapsible "Ver código" panel showing the Python snippet
 *      that produced the file.
 *
 * The iframe preview uses sandbox="" (empty) — scripts are *not*
 * allowed; we only need the document rendering. This means mammoth/
 * sheetjs output is displayed safely even if a malicious server ever
 * slipped a <script> through.
 */

import * as React from "react"
import {
  FileText, FileSpreadsheet, Download, FileCode2,
  Presentation as PresentationIcon, Code2, ChevronDown, ChevronUp,
  Eye, EyeOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { DocumentPreviewTarget } from "@/components/document-preview"

interface DocFile {
  type: "doc"
  format: "docx" | "xlsx" | "pptx" | "pdf" | "svg" | "csv"
  title?: string
  explanation?: string
  filename: string
  dataUrl: string | null
  mime?: string
  size?: number
  htmlPreview?: string | null    // server-rendered HTML for docx/xlsx
  pythonCode?: string
}

const FORMAT_META: Record<DocFile["format"], { label: string; accent: string; Icon: any }> = {
  docx: { label: "Word",       accent: "bg-blue-50 text-blue-700 border-blue-200",           Icon: FileText },
  xlsx: { label: "Excel",      accent: "bg-emerald-50 text-emerald-700 border-emerald-200",  Icon: FileSpreadsheet },
  csv:  { label: "CSV",        accent: "bg-teal-50 text-teal-700 border-teal-200",           Icon: FileSpreadsheet },
  pptx: { label: "PowerPoint", accent: "bg-orange-50 text-orange-700 border-orange-200",     Icon: PresentationIcon },
  pdf:  { label: "PDF",        accent: "bg-red-50 text-red-700 border-red-200",              Icon: FileText },
  svg:  { label: "SVG",        accent: "bg-violet-50 text-violet-700 border-violet-200",     Icon: FileCode2 },
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
  const meta = FORMAT_META[doc.format] || FORMAT_META.docx
  const available = !!doc.dataUrl && doc.dataUrl.startsWith("data:")
  const hasHtmlPreview = !!doc.htmlPreview && doc.htmlPreview.length > 0
  const hasPdfPreview = doc.format === "pdf" && available
  const hasSvgPreview = doc.format === "svg" && available
  const anyPreview = hasHtmlPreview || hasPdfPreview || hasSvgPreview
  const canPreview = onDocumentPreview ? (available || hasHtmlPreview) : anyPreview

  // When the parent provides a right-pane preview, keep the card
  // compact and open the split panel only on user click.
  const [previewOpen, setPreviewOpen] = React.useState<boolean>(anyPreview && !onDocumentPreview)
  const [codeOpen, setCodeOpen] = React.useState(false)

  function preview() {
    if (onDocumentPreview && hasHtmlPreview) {
      onDocumentPreview({
        url: htmlPreviewDataUrl(doc.htmlPreview as string),
        downloadUrl: available ? (doc.dataUrl as string) : undefined,
        filename: doc.filename,
      })
      return
    }
    if (onDocumentPreview && available) {
      onDocumentPreview({
        url: doc.dataUrl as string,
        downloadUrl: doc.dataUrl as string,
        filename: doc.filename,
      })
      return
    }
    if (anyPreview) setPreviewOpen(v => !v)
  }

  function download() {
    if (!available) return
    const a = document.createElement("a")
    a.href = doc.dataUrl as string
    a.download = doc.filename
    document.body.appendChild(a); a.click(); a.remove()
  }

  const Icon = meta.Icon
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
      {/* Header card — always visible */}
      <div className="flex items-center gap-3 p-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${meta.accent}`}>
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-[14px] font-semibold text-foreground">
            {doc.title || doc.filename}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10.5px] font-medium uppercase tracking-wider ${meta.accent}`}>
              {meta.label}
            </span>
            <span className="truncate">{doc.filename}</span>
            {doc.size ? <span>· {formatBytes(doc.size)}</span> : null}
          </div>
          {doc.explanation && (
            <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground/90">
              {doc.explanation}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && (
            <Button
              variant="ghost" size="sm"
              onClick={preview}
              className="h-8 px-2"
            >
              {!onDocumentPreview && previewOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span className="ml-1 hidden text-[11.5px] sm:inline">
                {!onDocumentPreview && previewOpen ? "Ocultar" : "Vista previa"}
              </span>
            </Button>
          )}
          <Button
            variant="default" size="sm"
            onClick={download}
            disabled={!available}
            className="h-8"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="ml-1 hidden text-[11.5px] sm:inline">Descargar</span>
          </Button>
        </div>
      </div>

      {/* Preview area */}
      {previewOpen && anyPreview && (
        <div className="border-t border-border/50 bg-muted/5">
          {hasPdfPreview ? (
            <embed src={doc.dataUrl!} type="application/pdf" className="h-[70vh] w-full" />
          ) : hasSvgPreview ? (
            <img
              src={doc.dataUrl!}
              alt={doc.title || doc.filename}
              className="mx-auto max-h-[70vh] w-full bg-white object-contain"
            />
          ) : hasHtmlPreview ? (
            <iframe
              srcDoc={doc.htmlPreview!}
              // empty sandbox = scripts NOT allowed (preview is read-only)
              sandbox=""
              className="h-[70vh] w-full border-0 bg-white"
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
