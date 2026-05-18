"use client"

import React from "react"
import { X, AlertCircle, Download, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { downloadHref, downloadUrlAsFile } from "@/lib/utils"
import { normalizeBackendAssetUrl } from "@/lib/attachment-url"
import { toast } from "sonner"
import DOMPurify from "dompurify"
import { readXlsxWorkbook, xlsxRowToValues } from "@/lib/xlsx-client"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
/**
 * Build the fetch init the preview uses against the backend asset
 * host. Includes the cookie AND the Bearer token most auth gates
 * look for. Cookie alone is not enough on deploys that protect
 * /uploads/* with a JWT middleware — the request returns 403 and
 * the user sees "No se pudo previsualizar".
 */
function buildAssetFetchInit(): RequestInit {
  if (typeof window === "undefined") return { credentials: "include" }
  const token = window.localStorage?.getItem("auth-token") || ""
  return {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }
}

/**
 * DocumentPreview — right-pane viewer for generated documents.
 *
 * Supports data URLs and same-origin URLs, so it works for freshly
 * generated files and after chat reloads when the data URL is persisted
 * in the message payload.
 */
export type DocumentPreviewTarget =
  | string
  | {
      url: string
      downloadUrl?: string
      filename?: string
    }

interface DocumentPreviewProps {
  url: DocumentPreviewTarget
  onClose: () => void
}

type PreviewFormat = "pdf" | "docx" | "doc" | "xlsx" | "csv" | "svg" | "pptx" | "html" | "unknown"

type State =
  | { kind: "loading" }
  | { kind: "pdf" }
  | { kind: "svg" }
  | { kind: "html"; html: string; warnings: string[] }
  | { kind: "iframeHtml"; html: string }
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
  html: "html",
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
    if (mime.includes("html")) return "html"
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
  if (clean.endsWith(".html") || clean.endsWith(".htm")) return "html"
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

function sanitizeClientPreviewHtml(html: string) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "input", "button"],
    FORBID_ATTR: ["srcdoc"],
  })
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
  const workbook = await readXlsxWorkbook(buffer)
  const maxSheets = 4
  const maxRows = 80
  const sections = workbook.worksheets.slice(0, maxSheets).map((worksheet: any) => {
    const rows: string[][] = []
    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      if (rows.length < maxRows + 1) rows.push(xlsxRowToValues(row))
    })
    return tableHtml(rows.slice(0, maxRows), {
      title: worksheet.name,
      truncated: worksheet.actualRowCount > maxRows ? `${worksheet.actualRowCount - maxRows} filas más. Descarga el archivo para verlo completo.` : undefined,
    })
  })
  if (workbook.worksheets.length > maxSheets) {
    sections.push(`<p class="sgpt-muted">Se muestran ${maxSheets} de ${workbook.worksheets.length} hojas.</p>`)
  }
  return previewShell(`<div class="sgpt-preview">${sections.join("")}</div>`)
}

async function renderPptx(buffer: ArrayBuffer) {
  const mod = await import("jszip")
  const JSZip = mod.default || mod
  const zip = await JSZip.loadAsync(buffer)
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const ai = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0)
      const bi = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0)
      return ai - bi
    })
    .slice(0, 40)

  const parser = typeof DOMParser !== "undefined" ? new DOMParser() : null
  const slides: string[] = []

  for (let index = 0; index < slideNames.length; index += 1) {
    const xml = await zip.files[slideNames[index]].async("text")
    let texts: string[] = []

    if (parser) {
      const doc = parser.parseFromString(xml, "application/xml")
      texts = Array.from(doc.getElementsByTagName("a:t"))
        .map((node) => node.textContent?.trim() || "")
        .filter(Boolean)
    } else {
      texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
        .map((match) => match[1]?.replace(/&amp;/g, "&").trim() || "")
        .filter(Boolean)
    }

    const title = texts[0] || `Diapositiva ${index + 1}`
    const bullets = texts.slice(1, 9)
      .map((text) => `<li>${escapeHtml(text)}</li>`)
      .join("")
    slides.push(`
      <section class="sgpt-slide">
        <div class="sgpt-slide-kicker">Diapositiva ${index + 1}</div>
        <h2>${escapeHtml(title)}</h2>
        ${bullets ? `<ul>${bullets}</ul>` : `<p class="sgpt-muted">Sin texto extra en esta diapositiva.</p>`}
      </section>
    `)
  }

  const body = slides.length
    ? slides.join("")
    : `<section class="sgpt-slide"><h2>Presentación</h2><p class="sgpt-muted">No se detectó texto legible en las diapositivas. Descarga el archivo para abrirlo en PowerPoint.</p></section>`

  return previewShell(`
    <style>
      .sgpt-deck { max-width:980px; margin:0 auto; }
      .sgpt-slide { min-height:420px; margin:0 auto 24px; border:1px solid #e5e7eb; border-radius:24px; background:#fff; padding:42px 48px; box-shadow:0 24px 70px rgba(15,23,42,.08); }
      .sgpt-slide-kicker { color:#ea580c; font-size:12px; letter-spacing:.14em; text-transform:uppercase; font-weight:800; margin-bottom:18px; }
      .sgpt-slide h2 { color:#111827; font-size:34px; line-height:1.12; margin:0 0 24px; letter-spacing:0; }
      .sgpt-slide ul { margin:0; padding-left:22px; color:#334155; font-size:19px; line-height:1.55; }
      .sgpt-slide li { margin:0 0 10px; }
    </style>
    <div class="sgpt-preview sgpt-deck">${body}</div>
  `)
}

export function DocumentPreview({ url, onClose }: DocumentPreviewProps) {
  const [state, setState] = React.useState<State>({ kind: "loading" })
  const [isDownloading, setIsDownloading] = React.useState(false)
  // Resolve the URL through `normalizeBackendAssetUrl` so an absolute
  // `/uploads/...` URL the backend baked in gets rewritten to the
  // frontend's NEXT_PUBLIC_IMAGE_URL host. Fixes "Failed to fetch"
  // when BASE_URL on the server is unreachable from the browser
  // (production deploys, mixed-content, leftover localhost).
  const previewUrl = React.useMemo(() => {
    const raw = typeof url === "string" ? url : url.url
    return normalizeBackendAssetUrl(raw, process.env.NEXT_PUBLIC_IMAGE_URL)
  }, [url])
  const downloadUrl = React.useMemo(() => typeof url === "string" ? previewUrl : (url.downloadUrl || url.url), [previewUrl, url])
  const format = React.useMemo(() => {
    const fromUrl = inferFormat(previewUrl)
    if (fromUrl !== "unknown") return fromUrl
    if (typeof url !== "string" && url.filename) return inferFormat(url.filename)
    return fromUrl
  }, [previewUrl, url])
  const filename = React.useMemo(() => {
    if (typeof url !== "string" && url.filename) return url.filename
    return inferFilename(downloadUrl, format)
  }, [downloadUrl, format, url])

  const download = React.useCallback(async () => {
    if (isDownloading) return
    setIsDownloading(true)
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      await downloadUrlAsFile(downloadUrl, filename, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      toast.success("Descarga iniciada")
    } catch (error) {
      console.error("[DocumentPreview] download failed:", error)
      try {
        downloadHref(downloadUrl, filename)
        toast.success("Descarga iniciada")
      } catch {
        toast.error("No se pudo descargar el documento")
      }
    } finally {
      setIsDownloading(false)
    }
  }, [downloadUrl, filename, isDownloading])

  React.useEffect(() => {
    if (!previewUrl) return

    if (format === "pdf") {
      setState({ kind: "pdf" })
      return
    }

    if (format === "svg") {
      setState({ kind: "svg" })
      return
    }

    if (format === "html") {
      let cancelled = false
      setState({ kind: "loading" })
      ;(async () => {
        try {
          const resp = await fetch(previewUrl, buildAssetFetchInit())
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const html = await resp.text()
          if (cancelled) return
          setState({ kind: "iframeHtml", html: sanitizeClientPreviewHtml(html) })
        } catch (err: unknown) {
          if (cancelled) return
          const message = err instanceof Error ? err.message : "No se pudo abrir la vista previa."
          setState({ kind: "error", message })
        }
      })()
      return () => {
        cancelled = true
      }
    }

    if (!["docx", "doc", "xlsx", "csv", "pptx"].includes(format)) {
      setState({ kind: "unsupported", message: "Formato no soportado para previsualización." })
      return
    }

    let cancelled = false
    setState({ kind: "loading" })

    ;(async () => {
      try {
        const resp = await fetch(previewUrl, buildAssetFetchInit())
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        if (format === "csv") {
          const text = await resp.text()
          if (cancelled) return
          const rows = parseCsv(text)
          setState({
            kind: "html",
            html: sanitizeClientPreviewHtml(previewShell(`<div class="sgpt-preview">${tableHtml(rows, { title: filename })}</div>`)),
            warnings: [],
          })
          return
        }

        const buffer = await resp.arrayBuffer()
        if (cancelled) return

        if (format === "xlsx") {
          const html = await renderXlsx(buffer)
          if (cancelled) return
          setState({ kind: "html", html: sanitizeClientPreviewHtml(html), warnings: [] })
          return
        }

        if (format === "pptx") {
          const html = await renderPptx(buffer)
          if (cancelled) return
          setState({ kind: "html", html: sanitizeClientPreviewHtml(html), warnings: [] })
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
          html: sanitizeClientPreviewHtml(previewShell(`<article class="sgpt-preview docx">${result.value}</article>`)),
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
  }, [filename, format, previewUrl])

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background">
      <div className="sticky top-0 z-20 flex h-14 min-h-14 w-full min-w-0 items-center border-b border-border/40 bg-background px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-3">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate text-sm font-medium" title={filename}>
            {filename}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            disabled={isDownloading}
            className="h-8 w-8 shrink-0"
            title={isDownloading ? "Descargando" : "Descargar"}
            aria-label={isDownloading ? "Descargando" : "Descargar"}
          >
            {isDownloading ? <ThinkingIndicator size="sm" /> : <Download className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0"
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
            <ThinkingIndicator size="sm" />
            Cargando vista previa…
          </div>
        )}

        {state.kind === "pdf" && (
          <iframe src={previewUrl} className="h-full w-full bg-white dark:bg-zinc-900" title={`Vista previa ${filename}`} />
        )}

        {state.kind === "svg" && (
          <div className="flex min-h-full items-center justify-center p-6">
            <img src={previewUrl} alt={filename} className="max-h-full max-w-full rounded-xl bg-white dark:bg-zinc-800 shadow-sm" />
          </div>
        )}

        {state.kind === "iframeHtml" && (
          <iframe
            srcDoc={state.html}
            className="h-full w-full border-0 bg-white dark:bg-zinc-900"
            title={`Vista previa ${filename}`}
            sandbox=""
          />
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
