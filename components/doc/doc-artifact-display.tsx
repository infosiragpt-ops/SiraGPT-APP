"use client"

/**
 * DocArtifactDisplay — inline chat renderer for `doc`-typed files
 * produced by /api/doc/generate.
 *
 * A compact "document card" per file, styled like the cards ChatGPT /
 * Claude show when they return a Word / Excel / PowerPoint / PDF /
 * SVG file. Click opens a preview when practical (PDF / SVG), Click
 * the download button to save the file locally.
 *
 * The dataUrl arrives embedded (base64) so the download is zero
 * round-trips. For PDFs the same dataUrl feeds an <embed/> preview.
 * For svg we render inline (safer — the iframe sandbox already
 * blocks script execution on SVG image previews).
 */

import * as React from "react"
import {
  FileText, FileSpreadsheet, FileImage, Download, ExternalLink,
  Presentation as PresentationIcon, FileCode2,
} from "lucide-react"

import { Button } from "@/components/ui/button"

interface DocFile {
  type: "doc"
  format: "docx" | "xlsx" | "pptx" | "pdf" | "svg"
  title?: string
  explanation?: string
  filename: string
  dataUrl: string | null      // null when we're loading a persisted
                              // message where the dataUrl was stripped
                              // at write time (see routes/doc.js)
  mime?: string
  size?: number
}

const FORMAT_META: Record<DocFile["format"], { label: string; accent: string; Icon: any }> = {
  docx: { label: "Word",       accent: "bg-blue-50 text-blue-700 border-blue-200",     Icon: FileText },
  xlsx: { label: "Excel",      accent: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: FileSpreadsheet },
  pptx: { label: "PowerPoint", accent: "bg-orange-50 text-orange-700 border-orange-200",  Icon: PresentationIcon },
  pdf:  { label: "PDF",        accent: "bg-red-50 text-red-700 border-red-200",          Icon: FileText },
  svg:  { label: "SVG",        accent: "bg-violet-50 text-violet-700 border-violet-200", Icon: FileCode2 },
}

function formatBytes(n?: number) {
  if (!n || n <= 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DocArtifactDisplay({ files }: { files: any[] }) {
  const docs = React.useMemo<DocFile[]>(
    () => (Array.isArray(files) ? files.filter((f: any) => f?.type === "doc") : []),
    [files]
  )
  if (docs.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {docs.map((d, i) => <DocCard key={i} doc={d} />)}
    </div>
  )
}

function DocCard({ doc }: { doc: DocFile }) {
  const meta = FORMAT_META[doc.format] || FORMAT_META.docx
  const available = !!doc.dataUrl && doc.dataUrl.startsWith("data:")
  const [previewOpen, setPreviewOpen] = React.useState(false)

  function download() {
    if (!available) return
    const a = document.createElement("a")
    a.href = doc.dataUrl as string
    a.download = doc.filename
    document.body.appendChild(a); a.click(); a.remove()
  }

  const canPreview = available && (doc.format === "pdf" || doc.format === "svg")
  const Icon = meta.Icon

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
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
              onClick={() => setPreviewOpen(v => !v)}
              className="h-8 px-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="ml-1 hidden text-[11.5px] sm:inline">
                {previewOpen ? "Ocultar" : "Previsualizar"}
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

      {/* PDF preview — inline <embed> fed by the base64 data URL. For
          SVG we drop it straight into an <img>; it renders without
          script execution (user agents treat base64 data: SVGs as
          pictures, not documents). */}
      {canPreview && previewOpen && available && (
        <div className="border-t border-border/50 bg-muted/20">
          {doc.format === "pdf" ? (
            <embed
              src={doc.dataUrl!}
              type="application/pdf"
              className="h-[70vh] w-full"
            />
          ) : doc.format === "svg" ? (
            <img
              src={doc.dataUrl!}
              alt={doc.title || doc.filename}
              className="mx-auto max-h-[70vh] w-full object-contain bg-white"
            />
          ) : null}
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
