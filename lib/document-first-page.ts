"use client"

import DOMPurify from "dompurify"

import { createAuthenticatedFetch, isTrustedSiraApiUrl } from "@/lib/authenticated-fetch"
import { normalizeBackendAssetUrl } from "@/lib/attachment-url"
import { readXlsxWorkbook, xlsxCellToText } from "@/lib/xlsx-client"

export type PageThumbKind = "pdf" | "docx" | "xlsx" | "pptx" | "image" | "other"

export type DocumentFirstPage = {
  kind: PageThumbKind
  dataUrl?: string
  html?: string
  rows?: string[][]
  title?: string
}

const ASSET_BASE_URL = (
  process.env.NEXT_PUBLIC_IMAGE_URL
  || process.env.NEXT_PUBLIC_API_URL
  || "http://localhost:5000"
).replace(/\/api\/?$/, "").replace(/\/+$/, "")

const authenticatedAssetFetch = createAuthenticatedFetch({ apiBaseUrl: ASSET_BASE_URL })

const cache = new Map<string, DocumentFirstPage>()
let pdfWorkerReady = false

export function isPagePreviewDocument(name?: string | null, mime?: string | null): boolean {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || ""
  const mt = String(mime || "").toLowerCase()
  if (mt.startsWith("image/")) return false
  if (mt.includes("pdf") || ext === "pdf") return true
  if (mt.includes("word") || mt.includes("officedocument.wordprocessing") || ext === "doc" || ext === "docx") return true
  if (mt.includes("spreadsheet") || ext === "xls" || ext === "xlsx" || ext === "csv") return true
  if (mt.includes("presentation") || ext === "ppt" || ext === "pptx") return true
  return /^(odt|ods|odp|rtf)$/.test(ext)
}

export function detectPageThumbKind(name?: string | null, mime?: string | null): PageThumbKind {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || ""
  const mt = String(mime || "").toLowerCase()
  if (mt.startsWith("image/") || /^(jpe?g|png|gif|webp|bmp|svg)$/.test(ext)) return "image"
  if (mt.includes("pdf") || ext === "pdf") return "pdf"
  if (mt.includes("word") || ext === "doc" || ext === "docx") return "docx"
  if (mt.includes("spreadsheet") || ext === "xls" || ext === "xlsx" || ext === "csv") return "xlsx"
  if (mt.includes("presentation") || ext === "ppt" || ext === "pptx") return "pptx"
  return "other"
}

function cacheKey(input: { id?: string | null; name?: string; size?: number | null; file?: File | null; url?: string | null }): string {
  if (input.file) {
    return `file:${input.file.name}:${input.file.size}:${input.file.lastModified}`
  }
  return `id:${input.id || ""}:${input.url || ""}:${input.name || ""}:${input.size || 0}`
}

async function readBytes(input: { file?: File | null; url?: string | null }): Promise<ArrayBuffer | null> {
  if (input.file) {
    try {
      return await input.file.arrayBuffer()
    } catch {
      /* fall through to url */
    }
  }
  const raw = String(input.url || "").trim()
  if (!raw) return null
  const normalized = normalizeBackendAssetUrl(raw, process.env.NEXT_PUBLIC_IMAGE_URL)
  const res = /^(data:|blob:)/i.test(normalized)
    ? await fetch(normalized)
    : isTrustedSiraApiUrl(normalized, ASSET_BASE_URL)
      ? await authenticatedAssetFetch(normalized)
      : await fetch(normalized)
  if (!res.ok) return null
  return res.arrayBuffer()
}

async function renderPdfFirstPage(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist")
  if (!pdfWorkerReady && typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString()
    pdfWorkerReady = true
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  try {
    const page = await doc.getPage(1)
    const unscaled = page.getViewport({ scale: 1 })
    const scale = Math.min(1.4, 420 / Math.max(1, unscaled.width))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement("canvas")
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas")
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toDataURL("image/jpeg", 0.82)
  } finally {
    await doc.destroy()
  }
}

async function renderDocxHtml(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth")
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
  const html = DOMPurify.sanitize(result.value || "", {
    USE_PROFILES: { html: true },
  })
  return html || "<p></p>"
}

async function renderXlsxRows(buffer: ArrayBuffer): Promise<string[][]> {
  const workbook = await readXlsxWorkbook(buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []
  const rows: string[][] = []
  const maxRows = Math.min(8, Number(sheet.rowCount) || 8)
  const maxCols = Math.min(6, Number(sheet.columnCount) || 6)
  for (let r = 1; r <= maxRows; r += 1) {
    const row = sheet.getRow(r) as { values?: unknown[] }
    const values = Array.isArray(row.values) ? row.values.slice(1, maxCols + 1) : []
    rows.push(values.map(xlsxCellToText))
  }
  return rows
}

async function renderPptxHtml(buffer: ArrayBuffer): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buffer)
  const slide = zip.file(/^ppt\/slides\/slide1\.xml$/)[0]
  if (!slide) return ""
  const xml = await slide.async("string")
  const texts = Array.from(xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)).map((m) => m[1].trim()).filter(Boolean)
  const title = texts[0] || ""
  const body = texts.slice(1, 8)
  const safe = (s: string) => DOMPurify.sanitize(s)
  return `<h1>${safe(title)}</h1>${body.map((t) => `<p>${safe(t)}</p>`).join("")}`
}

export async function renderDocumentFirstPage(input: {
  id?: string | null
  name?: string
  mimeType?: string | null
  size?: number | null
  file?: File | null
  url?: string | null
}): Promise<DocumentFirstPage | null> {
  const key = cacheKey(input)
  const hit = cache.get(key)
  if (hit) return hit

  const kind = detectPageThumbKind(input.name, input.mimeType)
  const buffer = await readBytes(input)
  if (!buffer || buffer.byteLength < 8) return { kind }

  try {
    let page: DocumentFirstPage = { kind }
    if (kind === "pdf") {
      page = { kind, dataUrl: await renderPdfFirstPage(buffer) }
    } else if (kind === "docx") {
      page = { kind, html: await renderDocxHtml(buffer) }
    } else if (kind === "xlsx") {
      page = { kind, rows: await renderXlsxRows(buffer) }
    } else if (kind === "pptx") {
      page = { kind, html: await renderPptxHtml(buffer), title: input.name }
    } else if (kind === "image" && input.file) {
      page = { kind, dataUrl: URL.createObjectURL(input.file) }
    }
    cache.set(key, page)
    return page
  } catch {
    const fallback: DocumentFirstPage = { kind }
    cache.set(key, fallback)
    return fallback
  }
}
