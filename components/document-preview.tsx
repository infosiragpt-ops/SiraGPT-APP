"use client"

import React from "react"
import { Loader2, X, AlertCircle, Download, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * DocumentPreview — right-pane viewer for generated documents.
 *
 * Supports data URLs and same-origin URLs, so it works for freshly
 * generated files and after chat reloads when the data URL is persisted
 * in the message payload.
 */
interface DocumentPreviewProps {
  url: string
  onClose: () => void
}

type PreviewFormat = "pdf" | "docx" | "doc" | "xlsx" | "csv" | "svg" | "pptx" | "unknown"

type State =
  | { kind: "loading" }
  | { kind: "pdf" }
  | { kind: "svg" }
  | { kind: "html"; html: string; warnings: string[] }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string }

const FORMAT_EXTENSION: Record<PreviewFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  xlsx: "xlsx",
  csv: "csv",
  svg: "svg",
  pptx: "pptx",
  unknown: "bin",
}

function inferFormat(url: string): PreviewFormat {
  const dataMatch = /^data:([^;,]+)/i.exec(url)
  if (dataMatch) {
    const mime = dataMatch[1].toLowerCase()
    if (mime.includes("pdf")) return "pdf"
    if (mime.includes("wordprocessingml.document")) return "docx"
    if (mime.includes("msword")) return "doc"
    if (mime.includes("spreadsheetml.sheet")) return "xlsx"
    if (mime.includes("presentationml.presentation")) return "pptx"
    if (mime.includes("svg")) return "svg"
    if (mime.includes("csv") || mime.includes("plain")) return "csv"
    return "unknown"
  }

  const clean = url.toLowerCase().split("?")[0].split("#")[0]
  if (clean.endsWith(".pdf")) return "pdf"
  if (clean.endsWith(".docx")) return "docx"
  if (clean.endsWith(".doc")) return "doc"
  if (clean.endsWith(".xlsx")) return "xlsx"
  if (clean.endsWith(".csv")) return "csv"
  if (clean.endsWith(".svg")) return "svg"
  if (clean.endsWith(".pptx")) return "pptx"
  return "unknown"
}

function inferFilename(url: string, format: PreviewFormat) {
  if (url.startsWith("data:")) return `documento.${FORMAT_EXTENSION[format] || "bin"}`
  try {
    const clean = url.split("?")[0].split("#")[0]
    return decodeURIComponent(clean.split("/").pop() || `documento.${FORMAT_EXTENSION[format]}`)
  } catch {
    return `documento.${FORMAT_EXTENSION[format]}`
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function tableHtml(rows: unknown[][], options: { title?: string; truncated?: string } = {}) {
  if (!rows.length) {
    return `<section class="sgpt-sheet"><div class="sgpt-tab">${escapeHtml(options.title || "Hoja")}</div><p class="sgpt-muted">Sin datos para mostrar.</p></section>`
  }
  const body = rows.map((row, index) => {
    const Tag = index === 0 ? "th" : "td"
    const cells = row.map((cell) => `<${Tag}>${escapeHtml(cell)}</${Tag}>`).join("")
    return `<tr>${cells}</tr>`
  }).join("")
  return [
    `<section class="sgpt-sheet">`,
    options.title ? `<div class="sgpt-tab">${escapeHtml(options.title)}</div>` : "",
    `<table>${body}</table>`,
    options.truncated ? `<p class="sgpt-muted">${escapeHtml(options.truncated)}</p>` : "",
    `</section>`,
  ].join("")
}

function previewShell(innerHtml: string) {
  return `
    <style>
      .sgpt-preview { color:#111827; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .sgpt-preview .sgpt-sheet { margin:0 auto 24px; max-width:1100px; overflow:auto; border:1px solid #e5e7eb; border-radius:16px; background:white; box-shadow:0 20px 50px rgba(15,23,42,.06); }
      .sgpt-preview .sgpt-tab { display:inline-flex; margin:12px 12px 0; border-radius:999px; background:#eef2ff; color:#3730a3; padding:6px 12px; font-size:12px; font-weight:700; }
      .sgpt-preview table { width:100%; border-collapse:collapse; margin-top:12px; font-size:12px; }
      .sgpt-preview th { background:#111827; color:#fff; font-weight:700; text-align:left; padding:9px 10px; white-space:nowrap; }
      .sgpt-preview td { border-top:1px solid #eef2f7; padding:8px 10px; max-width:320px; overflow:hidden; text-overflow:ellipsis; vertical-align:top; }
      .sgpt-preview tr:nth-child(even) td { background:#f9fafb; }
      .sgpt-preview .sgpt-muted { color:#6b7280; font-size:12px; margin:10px 12px 14px; }
      .sgpt-preview.docx { font-family:"Times New Roman", Georgia, serif; font-size:15px; line-height:1.75; max-width:780px; margin:0 auto; }
      .sgpt-preview.docx h1 { font-size:24px; text-align:center; margin:24px 0 14px; }
      .sgpt-preview.docx h2 { font-size:20px; margin:20px 0 10px; }
      .sgpt-preview.docx h3 { font-size:17px; margin:16px 0 8px; }
      .sgpt-preview.docx p { margin:0 0 12px; text-align:justify; }
      .sgpt-preview.docx table { font-size:13px; }
      .sgpt-preview.docx img { max-width:100%; height:auto; }
    </style>
    ${innerHtml}
  `
}

function parseCsv(text: string, maxRows = 80) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (char === '"' && inQuotes && next === '"') {
      cell += '"'
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === "," && !inQuotes) {
      row.push(cell)
      cell = ""
      continue
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      if (rows.length >= maxRows) break
      continue
    }
    cell += char
  }
  if (cell.length || row.length) {
    row.push(cell)
    if (rows.length < maxRows) rows.push(row)
  }
  return rows
}

async function renderXlsx(buffer: ArrayBuffer) {
  const XLSX = await import("xlsx")
  const workbook = XLSX.read(buffer, { type: "array" })
  const maxSheets = 4
  const maxRows = 80
  const sections = workbook.SheetNames.slice(0, maxSheets).map((name) => {
    const worksheet = workbook.Sheets[name]
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      blankrows: false,
      raw: false,
    }) as unknown[][]
    return tableHtml(rows.slice(0, maxRows), {
      title: name,
      truncated: rows.length > maxRows ? `${rows.length - maxRows} filas más. Descarga el archivo para verlo completo.` : undefined,
    })
  })
  if (workbook.SheetNames.length > maxSheets) {
    sections.push(`<p class="sgpt-muted">Se muestran ${maxSheets} de ${workbook.SheetNames.length} hojas.</p>`)
  }
  return previewShell(`<div class="sgpt-preview">${sections.join("")}</div>`)
}

export function DocumentPreview({ url, onClose }: DocumentPreviewProps) {
  const [state, setState] = React.useState<State>({ kind: "loading" })
  const format = React.useMemo(() => inferFormat(url), [url])
  const filename = React.useMemo(() => inferFilename(url, format), [url, format])

  const download = React.useCallback(() => {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.target = "_blank"
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [filename, url])

  React.useEffect(() => {
    if (!url) return

    if (format === "pdf") {
      setState({ kind: "pdf" })
      return
    }

    if (format === "svg") {
      setState({ kind: "svg" })
      return
    }

    if (format === "pptx") {
      setState({
        kind: "unsupported",
        message: "PowerPoint no tiene una vista previa directa estable en el navegador. Descarga el archivo para abrirlo en PowerPoint, Keynote o Google Slides.",
      })
      return
    }

    if (!["docx", "doc", "xlsx", "csv"].includes(format)) {
      setState({ kind: "unsupported", message: "Formato no soportado para previsualización." })
      return
    }

    let cancelled = false
    setState({ kind: "loading" })

    ;(async () => {
      try {
        const resp = await fetch(url, { credentials: "include" })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        if (format === "csv") {
          const text = await resp.text()
          if (cancelled) return
          const rows = parseCsv(text)
          setState({
            kind: "html",
            html: previewShell(`<div class="sgpt-preview">${tableHtml(rows, { title: filename })}</div>`),
            warnings: [],
          })
          return
        }

        const buffer = await resp.arrayBuffer()
        if (cancelled) return

        if (format === "xlsx") {
          const html = await renderXlsx(buffer)
          if (cancelled) return
          setState({ kind: "html", html, warnings: [] })
          return
        }

        const mammoth = await import("mammoth/mammoth.browser")
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          {
            styleMap: [
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
            ],
          },
        )
        if (cancelled) return
        setState({
          kind: "html",
          html: previewShell(`<article class="sgpt-preview docx">${result.value}</article>`),
          warnings: (result.messages || []).map((m: { message?: string }) => m.message || "").filter(Boolean),
        })
      } catch (err: unknown) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : "No se pudo abrir el documento."
        setState({ kind: "error", message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [filename, format, url])

  return (
    <div className="relative flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium" title={filename}>
            {filename}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            className="h-8 w-8"
            title="Descargar"
            aria-label="Descargar"
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title="Cerrar"
            aria-label="Cerrar previsualización"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="scroll-contain min-h-0 flex-1 overflow-auto bg-muted/10">
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando vista previa…
          </div>
        )}

        {state.kind === "pdf" && (
          <iframe src={url} className="h-full w-full bg-white" title={`Vista previa ${filename}`} />
        )}

        {state.kind === "svg" && (
          <div className="flex min-h-full items-center justify-center p-6">
            <img src={url} alt={filename} className="max-h-full max-w-full rounded-xl bg-white shadow-sm" />
          </div>
        )}

        {state.kind === "html" && (
          <div className="px-4 py-6 md:px-6 md:py-8">
            <div dangerouslySetInnerHTML={{ __html: state.html }} />
          </div>
        )}

        {(state.kind === "unsupported" || state.kind === "error") && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-border bg-background p-6 text-center shadow-sm">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="mb-1 font-medium">
                {state.kind === "error" ? "No se pudo previsualizar" : "Vista previa no disponible"}
              </p>
              <p className="mb-4 text-sm text-muted-foreground">{state.message}</p>
              <Button size="sm" onClick={download}>
                <Download className="mr-1.5 h-4 w-4" />
                Descargar archivo
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
