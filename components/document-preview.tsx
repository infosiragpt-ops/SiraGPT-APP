"use client"

import React from "react"
import { X, AlertCircle, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn, downloadHref, downloadUrlAsFile } from "@/lib/utils"
import { normalizeBackendAssetUrl } from "@/lib/attachment-url"
import {
  createAuthenticatedFetch,
  isTrustedSiraApiUrl,
} from "@/lib/authenticated-fetch"
import { toast } from "sonner"
import DOMPurify from "dompurify"
import { readXlsxWorkbook, xlsxRowToValues } from "@/lib/xlsx-client"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

const ASSET_BASE_URL = (
  process.env.NEXT_PUBLIC_IMAGE_URL
  || process.env.NEXT_PUBLIC_API_URL
  || "http://localhost:5000"
).replace(/\/api\/?$/, "").replace(/\/+$/, "")
const authenticatedAssetFetch = createAuthenticatedFetch({ apiBaseUrl: ASSET_BASE_URL })

function fetchPreviewAsset(url: string): Promise<Response> {
  const normalized = normalizeBackendAssetUrl(url, process.env.NEXT_PUBLIC_IMAGE_URL)
  if (/^(data:|blob:)/i.test(normalized)) return fetch(normalized)
  return isTrustedSiraApiUrl(normalized, ASSET_BASE_URL)
    ? authenticatedAssetFetch(normalized)
    : fetch(normalized)
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
      // Explicit high-fidelity preview endpoint (server-side soffice→PDF). When
      // set, the viewer renders THIS as a real PDF (pages/zoom, Excel looks like
      // Excel) before any client-side fallback. Used for message-attached
      // generated documents whose bytes live at a /uploads path (no artifact id).
      previewPdfUrl?: string
    }

interface DocumentPreviewProps {
  url: DocumentPreviewTarget
  onClose: () => void
}

type PreviewFormat = "pdf" | "docx" | "doc" | "xlsx" | "csv" | "svg" | "pptx" | "html" | "unknown"

type State =
  | { kind: "loading"; message?: string }
  | { kind: "pdf" }
  | { kind: "pdfBlob"; url: string }
  | { kind: "svg" }
  | { kind: "docxNative"; buffer: ArrayBuffer }
  | { kind: "html"; html: string; warnings: string[] }
  | { kind: "iframeHtml"; html: string }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string }

const MIN_PREVIEW_ZOOM = 0.75
const MAX_PREVIEW_ZOOM = 1.75
const PREVIEW_ZOOM_STEP = 0.1

const previewHeaderClass =
  "border-b border-white/45 bg-white/72 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-2xl supports-[backdrop-filter]:bg-white/58 dark:border-white/10 dark:bg-zinc-950/72 dark:shadow-black/25"

const previewIconButtonClass =
  "h-9 w-9 rounded-full border border-white/60 bg-white/68 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_24px_rgba(15,23,42,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-white/88 hover:text-zinc-950 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_14px_30px_rgba(15,23,42,0.12)] dark:border-white/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/16"

const previewControlShellClass =
  "rounded-full border border-white/65 bg-white/70 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur-2xl supports-[backdrop-filter]:bg-white/56 dark:border-white/10 dark:bg-zinc-950/62 dark:shadow-black/30"

const previewMetricClass =
  "min-w-[4.6rem] rounded-full border border-white/60 bg-white/68 px-3 py-1.5 text-center text-xs font-semibold tabular-nums text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl dark:border-white/10 dark:bg-white/10 dark:text-zinc-100"

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

function cloneArrayBuffer(buffer: ArrayBuffer) {
  return buffer.slice(0)
}

function paginateOverflowingDocxSections(root: HTMLElement) {
  const sections = Array.from(root.querySelectorAll<HTMLElement>("section.docx, section.docx-preview-doc"))
  if (sections.length !== 1) return
  const source = sections[0]
  const wrapper = source.parentElement
  if (!wrapper) return

  const computed = window.getComputedStyle(source)
  const pageHeight = Number.parseFloat(computed.minHeight || "") || Number.parseFloat(computed.height || "") || 1122
  const pageWidth = source.getBoundingClientRect().width
  if (!pageHeight || source.scrollHeight <= pageHeight * 1.15) return

  const contentParent = source.children.length === 1 && source.firstElementChild instanceof HTMLElement
    ? source.firstElementChild
    : source
  const nodes = Array.from(contentParent.childNodes)
  if (nodes.length < 2) return

  const createPage = () => {
    const page = source.cloneNode(false) as HTMLElement
    page.removeAttribute("id")
    page.style.width = `${pageWidth}px`
    page.style.height = `${pageHeight}px`
    page.style.minHeight = `${pageHeight}px`
    page.style.overflow = "hidden"
    const content = contentParent === source
      ? page
      : contentParent.cloneNode(false) as HTMLElement
    if (content !== page) page.appendChild(content)
    wrapper.appendChild(page)
    return { page, content }
  }

  source.remove()
  let current = createPage()
  for (const node of nodes) {
    current.content.appendChild(node)
    if (current.page.scrollHeight > current.page.clientHeight + 8 && current.content.childNodes.length > 1) {
      current.content.removeChild(node)
      current = createPage()
      current.content.appendChild(node)
    }
  }
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

// High-fidelity preview endpoint for agent artifacts: the backend converts
// office files to PDF with LibreOffice headless (cached) and this viewer
// renders the PDF — real pages, real layout, zoom — instead of hand-rolled
// HTML tables. Returns null for URLs without a server-side preview.
function derivePreviewPdfUrl(assetUrl: string): string | null {
  const match = /^(.*\/api\/agent\/artifact\/[a-f0-9]{6,40})(\?.*)?$/i.exec(assetUrl || "")
  if (!match) return null
  return `${match[1]}/preview.pdf${match[2] || ""}`
}

export function DocumentPreview({ url, onClose }: DocumentPreviewProps) {
  const [state, setState] = React.useState<State>({ kind: "loading" })
  const [isDownloading, setIsDownloading] = React.useState(false)
  const [zoom, setZoom] = React.useState(1)
  const [activePage, setActivePage] = React.useState(1)
  const [pageCount, setPageCount] = React.useState(1)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const docxRootRef = React.useRef<HTMLDivElement | null>(null)
  const docxStyleRef = React.useRef<HTMLDivElement | null>(null)
  const [docxNativeReady, setDocxNativeReady] = React.useState(false)
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
  // Explicit high-fidelity endpoint passed by the caller (soffice→PDF for
  // files whose bytes live at /uploads, so derivePreviewPdfUrl can't infer it).
  const explicitPdfUrl = React.useMemo(() => {
    const raw = typeof url === "string" ? null : (url.previewPdfUrl || null)
    return raw ? normalizeBackendAssetUrl(raw, process.env.NEXT_PUBLIC_IMAGE_URL) : null
  }, [url])
  const format = React.useMemo(() => {
    const fromUrl = inferFormat(previewUrl)
    // Prefer the real document type for Word files: the chat sometimes hands
    // us an HTML preview data URL (mammoth) even though the underlying
    // artifact is a real .docx/.doc. In that case render the original bytes
    // natively so the preview matches the document "tal cual" instead of the
    // degraded HTML version (which also avoids the fragile iframe path).
    const nameSource = typeof url !== "string" ? (url.filename || url.downloadUrl || "") : ""
    const fromName = nameSource ? inferFormat(nameSource) : "unknown"
    if (fromName === "docx" || fromName === "doc") {
      const realBytesUrl = typeof url !== "string" ? (url.downloadUrl || "") : previewUrl
      if (realBytesUrl && !realBytesUrl.startsWith("data:")) return fromName
    }
    if (fromUrl !== "unknown") return fromUrl
    if (fromName !== "unknown") return fromName
    return fromUrl
  }, [previewUrl, url])
  const filename = React.useMemo(() => {
    if (typeof url !== "string" && url.filename) return url.filename
    return inferFilename(downloadUrl, format)
  }, [downloadUrl, format, url])
  const formatLabel = (FORMAT_EXTENSION[format] || "documento").toUpperCase()
  const canUsePreviewControls = ["pdf", "pdfBlob", "svg", "docxNative", "html", "iframeHtml"].includes(state.kind)
  const previewZoomStyle = React.useMemo(
    () => ({ zoom }) as React.CSSProperties & { zoom: number },
    [zoom],
  )

  const getDocxNativePages = React.useCallback((): HTMLElement[] => {
    const root = docxRootRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>("section.docx, section.docx-preview-doc"))
  }, [])

  const updatePageMetrics = React.useCallback(() => {
    const el = scrollRef.current
    if (!el || !canUsePreviewControls) {
      setActivePage(1)
      setPageCount(1)
      return
    }

    if (state.kind === "docxNative") {
      const pages = getDocxNativePages()
      if (pages.length === 0) {
        setActivePage(1)
        setPageCount(1)
        return
      }
      const scrollRect = el.getBoundingClientRect()
      let bestPage = 1
      let bestVisible = -1
      let bestDistance = Number.POSITIVE_INFINITY
      pages.forEach((page, index) => {
        const rect = page.getBoundingClientRect()
        const visible = Math.max(0, Math.min(rect.bottom, scrollRect.bottom) - Math.max(rect.top, scrollRect.top))
        const distance = Math.abs(rect.top - scrollRect.top)
        if (visible > bestVisible || (visible === bestVisible && distance < bestDistance)) {
          bestVisible = visible
          bestDistance = distance
          bestPage = index + 1
        }
      })
      setPageCount(pages.length)
      setActivePage(bestPage)
      return
    }

    const viewport = Math.max(1, el.clientHeight)
    const total = Math.max(1, Math.ceil(Math.max(el.scrollHeight, viewport) / viewport))
    const current = Math.min(total, Math.max(1, Math.floor((el.scrollTop + viewport * 0.35) / viewport) + 1))

    setPageCount((previous) => (previous === total ? previous : total))
    setActivePage((previous) => (previous === current ? previous : current))
  }, [canUsePreviewControls, getDocxNativePages, state.kind])

  // Keep a stable reference to the latest page-metrics updater so the docx
  // render effect can call it without listing it as a dependency. Without
  // this, the callback identity churn re-ran the render effect, whose cleanup
  // wiped the rendered DOM — the document flashed then went blank.
  const updatePageMetricsRef = React.useRef(updatePageMetrics)
  React.useEffect(() => {
    updatePageMetricsRef.current = updatePageMetrics
  }, [updatePageMetrics])

  const setBoundedZoom = React.useCallback((nextZoom: number) => {
    setZoom(Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, Number(nextZoom.toFixed(2)))))
  }, [])

  const goToPreviewPage = React.useCallback((page: number) => {
    const el = scrollRef.current
    if (!el) return
    const targetPage = Math.min(Math.max(page, 1), pageCount)
    if (state.kind === "docxNative") {
      const pages = getDocxNativePages()
      const pageEl = pages[targetPage - 1]
      if (pageEl) {
        const scrollRect = el.getBoundingClientRect()
        const pageRect = pageEl.getBoundingClientRect()
        el.scrollTo({
          top: el.scrollTop + pageRect.top - scrollRect.top - 12,
          behavior: "smooth",
        })
      }
      setActivePage(targetPage)
      return
    }
    el.scrollTo({
      top: (targetPage - 1) * Math.max(1, el.clientHeight),
      behavior: "smooth",
    })
    setActivePage(targetPage)
  }, [getDocxNativePages, pageCount, state.kind])

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

  const openInNewTab = React.useCallback(() => {
    if (typeof window === "undefined") return
    window.open(downloadUrl, "_blank", "noopener,noreferrer")
  }, [downloadUrl])

  React.useEffect(() => {
    setZoom(1)
    setActivePage(1)
    setPageCount(1)
  }, [previewUrl])

  React.useEffect(() => {
    if (!canUsePreviewControls) return
    const el = scrollRef.current
    if (!el) return

    const handleScroll = () => updatePageMetrics()
    const frame = window.requestAnimationFrame(updatePageMetrics)
    const delayedFrame = window.setTimeout(updatePageMetrics, 350)
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePageMetrics) : null

    el.addEventListener("scroll", handleScroll, { passive: true })
    observer?.observe(el)
    if (el.firstElementChild instanceof HTMLElement) observer?.observe(el.firstElementChild)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(delayedFrame)
      el.removeEventListener("scroll", handleScroll)
      observer?.disconnect()
    }
  }, [canUsePreviewControls, state.kind, updatePageMetrics, zoom])

  React.useEffect(() => {
    if (!canUsePreviewControls) return
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      setBoundedZoom(zoom * factor)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [canUsePreviewControls, setBoundedZoom, zoom])

  React.useEffect(() => {
    if (state.kind !== "docxNative") {
      setDocxNativeReady(false)
      return
    }

    const root = docxRootRef.current
    const styleHost = docxStyleRef.current
    if (!root || !styleHost) return

    let cancelled = false
    setDocxNativeReady(false)
    root.replaceChildren()
    styleHost.replaceChildren()

    ;(async () => {
      try {
        const { renderAsync } = await import("docx-preview")
        if (cancelled) return
        await renderAsync(cloneArrayBuffer(state.buffer), root, styleHost, {
          className: "docx-preview-doc",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderChanges: false,
        })
        if (cancelled) return
        paginateOverflowingDocxSections(root)
        const style = document.createElement("style")
        style.textContent = `
          .sira-document-preview-docx .docx-wrapper,
          .sira-document-preview-docx .docx-preview-doc-wrapper {
            background: transparent !important;
            padding: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            gap: 28px !important;
          }
          .sira-document-preview-docx section.docx,
          .sira-document-preview-docx section.docx-preview-doc {
            margin: 0 auto !important;
            border-radius: 2px !important;
            background: white !important;
            color: black !important;
            outline: 1px solid rgba(255,255,255,0.08) !important;
            box-shadow: 0 18px 50px rgba(0,0,0,0.34) !important;
          }
        `
        styleHost.appendChild(style)
        setDocxNativeReady(true)
        window.requestAnimationFrame(() => updatePageMetricsRef.current())
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : "No se pudo abrir el documento."
        setState({ kind: "error", message })
      }
    })()

    return () => {
      cancelled = true
      root.replaceChildren()
      styleHost.replaceChildren()
    }
  }, [state])

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
          const resp = await fetchPreviewAsset(previewUrl)
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
    let blobUrl: string | null = null
    setState({ kind: "loading" })

    ;(async () => {
      try {
        // For Word files the chat may pass an HTML preview data URL while the
        // real .docx bytes live at downloadUrl. Always fetch the actual
        // document bytes so the native renderer gets a valid DOCX.
        const assetUrl =
          (format === "docx" || format === "doc") && previewUrl.startsWith("data:")
            ? downloadUrl
            : previewUrl

        // High-fidelity path FIRST: server-side soffice→PDF for office files.
        // Any failure (409 offloaded, soffice down, network) falls through to
        // the legacy client-side renderers below — never a dead end. An
        // explicit previewPdfUrl (message-attached generated docs) wins over
        // the inferred agent-artifact endpoint.
        const pdfEndpoint = explicitPdfUrl || derivePreviewPdfUrl(downloadUrl) || derivePreviewPdfUrl(assetUrl)
        if (pdfEndpoint) {
          setState({ kind: "loading", message: "Generando vista previa…" })
          try {
            const pdfResp = await fetchPreviewAsset(pdfEndpoint)
            if (pdfResp.ok && (pdfResp.headers.get("content-type") || "").includes("pdf")) {
              const blob = await pdfResp.blob()
              if (cancelled) return
              blobUrl = URL.createObjectURL(blob)
              setState({ kind: "pdfBlob", url: blobUrl })
              return
            }
          } catch {
            // fall through to the legacy renderer
          }
          if (cancelled) return
          setState({ kind: "loading" })
        }

        const resp = await fetchPreviewAsset(assetUrl)
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

        if (format === "docx") {
          setState({ kind: "docxNative", buffer: cloneArrayBuffer(buffer) })
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
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [filename, format, previewUrl, downloadUrl, explicitPdfUrl])

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background">
      <div className={cn("sticky top-0 z-30 flex min-h-16 w-full min-w-0 items-center px-4", previewHeaderClass)}>
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden pr-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-white/60 bg-white/70 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_12px_24px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/10 dark:text-zinc-200">
            <FileText className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <span className="block min-w-0 max-w-full truncate text-sm font-semibold text-zinc-950 dark:text-zinc-50" title={filename}>
              {filename}
            </span>
            <span className="mt-0.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{formatLabel}</span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            disabled={isDownloading}
            className={cn("shrink-0", previewIconButtonClass)}
            title={isDownloading ? "Descargando" : "Descargar"}
            aria-label={isDownloading ? "Descargando" : "Descargar"}
          >
            {isDownloading ? <ThinkingIndicator size="sm" /> : <Download className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={openInNewTab}
            className={cn("shrink-0", previewIconButtonClass)}
            title="Abrir en una pestaña"
            aria-label="Abrir documento en una pestaña"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className={cn("shrink-0", previewIconButtonClass)}
            title="Cerrar"
            aria-label="Cerrar previsualización"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scroll-contain min-h-0 flex-1 overflow-auto bg-[linear-gradient(180deg,rgba(250,250,250,0.9),rgba(244,246,248,0.78))] dark:bg-[linear-gradient(180deg,rgba(24,24,27,0.95),rgba(9,9,11,0.96))]"
      >
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <ThinkingIndicator size="sm" />
            {state.message || "Cargando vista previa…"}
          </div>
        )}

        {state.kind === "pdfBlob" && (
          <iframe
            src={state.url}
            className="h-full w-full bg-white dark:bg-zinc-900"
            style={previewZoomStyle}
            title={`Vista previa ${filename}`}
          />
        )}

        {state.kind === "pdf" && (
          <iframe
            src={previewUrl}
            className="h-full w-full bg-white dark:bg-zinc-900"
            style={previewZoomStyle}
            title={`Vista previa ${filename}`}
          />
        )}

        {state.kind === "svg" && (
          <div className="flex min-h-full items-center justify-center p-6 pb-28" style={previewZoomStyle}>
            {/* eslint-disable-next-line @next/next/no-img-element -- SVG preview from blob URL (user-generated artifact); next/image cannot fetch blob: URIs */}
            <img src={previewUrl} alt={filename} className="max-h-full max-w-full rounded-xl bg-white dark:bg-zinc-800 shadow-sm" />
          </div>
        )}

        {state.kind === "iframeHtml" && (
          <iframe
            srcDoc={state.html}
            className="h-full w-full border-0 bg-white dark:bg-zinc-900"
            style={previewZoomStyle}
            title={`Vista previa ${filename}`}
            sandbox=""
          />
        )}

        {state.kind === "docxNative" && (
          <div
            className="relative min-h-full bg-[#262626] px-[clamp(1.5rem,8vw,6rem)] py-8 pb-28"
            style={previewZoomStyle}
          >
            <div ref={docxStyleRef} className="contents" aria-hidden="true" />
            <div ref={docxRootRef} className="sira-document-preview-docx min-h-[42rem]" />
            {!docxNativeReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#262626]/80 text-sm text-white/75 backdrop-blur-sm">
                <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-2 shadow-sm">
                  <ThinkingIndicator size="sm" />
                  Renderizando documento…
                </div>
              </div>
            )}
          </div>
        )}

        {state.kind === "html" && (
          <div className="px-4 pb-28 pt-6 md:px-6 md:pt-8" style={previewZoomStyle}>
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

      {canUsePreviewControls && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className={cn("pointer-events-auto flex max-w-full items-center gap-1", previewControlShellClass)}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", previewIconButtonClass)}
              onClick={() => goToPreviewPage(activePage - 1)}
              disabled={activePage <= 1}
              title="Página anterior"
              aria-label="Página anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className={previewMetricClass} aria-live="polite">
              {activePage} / {pageCount}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", previewIconButtonClass)}
              onClick={() => goToPreviewPage(activePage + 1)}
              disabled={activePage >= pageCount}
              title="Página siguiente"
              aria-label="Página siguiente"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            <span className="mx-1 h-6 w-px bg-zinc-300/70 dark:bg-white/10" aria-hidden="true" />

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", previewIconButtonClass)}
              onClick={() => setBoundedZoom(zoom - PREVIEW_ZOOM_STEP)}
              disabled={zoom <= MIN_PREVIEW_ZOOM}
              title="Alejar"
              aria-label="Alejar documento"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <button
              type="button"
              className={cn(previewMetricClass, "min-w-[4.1rem]")}
              onClick={() => setBoundedZoom(1)}
              title="Restablecer zoom"
              aria-label="Restablecer zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", previewIconButtonClass)}
              onClick={() => setBoundedZoom(zoom + PREVIEW_ZOOM_STEP)}
              disabled={zoom >= MAX_PREVIEW_ZOOM}
              title="Acercar"
              aria-label="Acercar documento"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
