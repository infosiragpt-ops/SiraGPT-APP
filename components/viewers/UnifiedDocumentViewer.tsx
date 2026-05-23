"use client"

/**
 * UnifiedDocumentViewer — one fast viewer modal for every supported format.
 *
 * Dispatches to a format-specific renderer based on MIME + extension +
 * (where available) a first-bytes magic-byte sniff. The viewer itself
 * is the SAME component used by the composer chip AND by the sent-
 * message chip, so:
 *   • identical UX in both places
 *   • shared loading/error/dark-mode logic
 *   • single point for format detection + telemetry
 *
 * Source strategies, in priority order:
 *   1. `file` (in-memory File blob)      — used while an attachment is
 *      still in the composer BEFORE upload completes.
 *   2. `url` (server-backed URL)         — used after upload; hits
 *      /uploads/<user>/<filename> which the backend serves directly.
 *   3. `documentId` (RagDocument)        — reserved for future RAG
 *      preview endpoint; currently unused in main.
 *
 * Renderers (all client-side except where noted):
 *   image   → <img> with wheel-zoom and click-drag pan
 *   pdf     → pdf.js paginated viewer with zoom + navigation
 *   csv     → papa-free mini-parser → <table>
 *   xlsx    → ExcelJS parses workbook → tabs + bounded <table> per sheet
 *   docx    → mammoth → HTML (sanitized) → rendered in scrollable pane
 *   md      → ReactMarkdown with GFM tables + code fences
 *   json    → pretty-printed + monospace
 *   xml/html→ sandboxed iframe with srcDoc (sanitized)
 *   txt     → <pre> with mono font + wrap toggle
 *   code    → Shiki highlighting with line numbers
 *   other   → professional fallback with Download CTA (not a broken modal)
 */

import * as React from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import {
  Download,
  ExternalLink,
  AlertTriangle,
  FileText,
  FileSpreadsheet,
  Presentation,
  File as FileIcon,
  Image as ImageIcon,
  X,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Check,
  Copy,
  Maximize2,
  RefreshCw,
  Reply,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeBackendAssetUrl } from "@/lib/attachment-url"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import dynamic from "next/dynamic"
const ShikiCodeView = dynamic(
  () => import("@/components/ui/shiki-code-view").then(m => ({ default: m.ShikiCodeView })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse bg-muted/30" aria-hidden="true" /> }
)
import { readXlsxWorkbook, xlsxCellToText } from "@/lib/xlsx-client"
// mammoth is imported dynamically inside DocxRenderer's fallback path
// (~250 KB module, only loaded when docx-preview fails). Static import
// would force every viewer instance to ship the bytes even for non-DOCX
// previews, AND would bundle it into the page chunk so a stale HTML
// reference to a re-hashed chunk surfaces as "Loading chunk failed"
// instead of a recoverable per-document error.
let mammothPromise: Promise<typeof import("mammoth")> | null = null
function loadMammoth() {
  if (!mammothPromise) {
    mammothPromise = import("mammoth").catch((err) => {
      // Reset the cache so the next attempt actually retries instead of
      // keeping the rejected promise in scope forever.
      mammothPromise = null
      throw err
    })
  }
  return mammothPromise
}

let docxPreviewPromise: Promise<typeof import("docx-preview")> | null = null
function loadDocxPreview() {
  if (!docxPreviewPromise) {
    docxPreviewPromise = import("docx-preview").catch((err) => {
      docxPreviewPromise = null
      throw err
    })
  }
  return docxPreviewPromise
}

/**
 * True when the error came from webpack failing to load a code-split
 * chunk — almost always because the page HTML references a chunk hash
 * the running server no longer has on disk (after a deploy or a dev
 * hot-restart). Recovery is a hard refresh, not a per-document retry.
 */
function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  const e = err as { name?: string; message?: string }
  if (e.name === "ChunkLoadError") return true
  const msg = e.message || ""
  return /Loading chunk \S+ failed|ChunkLoadError|Failed to fetch dynamically imported module/i.test(msg)
}
import JSZip from "jszip"
import DOMPurify from "dompurify"
import { Document as PdfDocument, Page as PdfPage, pdfjs } from "react-pdf"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import "react-pdf/dist/Page/TextLayer.css"
import "react-pdf/dist/Page/AnnotationLayer.css"

// pdfjs worker — pinned to the exact pdfjs-dist version react-pdf bundles,
// so we never get a "API version X / Worker version Y" mismatch when the
// dependency is bumped. Hosted on unpkg by default; for fully offline /
// air-gapped deployments, copy `pdf.worker.min.mjs` into /public and point
// `workerSrc` at `/pdf.worker.min.mjs`.
if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
}

// ─── Format detection ────────────────────────────────────────────────

type Kind =
  | "image" | "pdf" | "docx" | "doc" | "xlsx" | "csv" | "pptx"
  | "md" | "html" | "xml" | "json" | "text" | "code"
  | "unknown"

const CODE_EXTENSIONS: Record<string, string> = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  css: "css", scss: "scss", less: "less",
}

function detectKind(file: AttachmentLike): Kind {
  const ext = extOf(file.name).toLowerCase()
  const mt = (file.mimeType || "").toLowerCase()
  if (mt.startsWith("image/") || /^(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|svg)$/.test(ext)) return "image"
  if (mt === "application/pdf" || ext === "pdf") return "pdf"
  // Legacy binary .doc → "doc" (needs server-side conversion); modern
  // .docx (OOXML) → "docx" (handled client-side by docx-preview).
  if (mt === "application/msword" || ext === "doc") return "doc"
  if (mt.includes("wordprocessingml") || ext === "docx") return "docx"
  if (mt.includes("spreadsheetml") || ext === "xlsx") return "xlsx"
  if (mt === "text/csv" || ext === "csv") return "csv"
  if (mt.includes("presentationml") || /^pptx?$/.test(ext)) return "pptx"
  if (mt === "text/markdown" || /^(md|markdown)$/.test(ext)) return "md"
  if (mt === "text/html" || /^html?$/.test(ext)) return "html"
  if (mt === "application/xml" || mt === "text/xml" || ext === "xml") return "xml"
  if (mt === "application/json" || ext === "json") return "json"
  if (CODE_EXTENSIONS[ext]) return "code"
  if (mt.startsWith("text/") || ["txt", "log", "env", "conf"].includes(ext)) return "text"
  return "unknown"
}

function extOf(name: string | undefined | null): string {
  if (!name) return ""
  const i = name.lastIndexOf(".")
  return i < 0 ? "" : name.slice(i + 1)
}

function iconForKind(kind: Kind) {
  switch (kind) {
    case "image": return ImageIcon
    case "pdf":
    case "docx":
    case "doc":
    case "md":
    case "html":
    case "text": return FileText
    case "xlsx":
    case "csv": return FileSpreadsheet
    case "pptx": return Presentation
    case "code":
    case "json":
    case "xml": return FileText
    default: return FileIcon
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export interface AttachmentLike {
  /** Stable id — used for caching and URL lookups. */
  id?: string | null
  /** File name with extension. */
  name: string
  /** MIME type as reported by the browser / backend. */
  mimeType?: string | null
  /** Byte size (for the header badge). */
  size?: number | null
  /** In-memory File blob (present while in composer before upload). */
  file?: File | null
  /** Server-backed URL — e.g. `/uploads/<userId>/<filename>`. */
  url?: string | null
  /** Pre-extracted plain text — used as a fallback for exotic formats. */
  extractedText?: string | null
}

interface UnifiedDocumentViewerProps {
  open: boolean
  onClose: () => void
  /** Modal by default; panel renders inline inside the chat split view. */
  variant?: "modal" | "panel"
  /** Primary attachment (required when open=true). */
  attachment: AttachmentLike | null
  /** Other attachments in the same context — enables arrow navigation. */
  siblings?: AttachmentLike[]
  /** Called when the user arrows to a different attachment in the set. */
  onNavigate?: (next: AttachmentLike) => void
  className?: string
}

class ViewerRenderBoundary extends React.Component<
  { children: React.ReactNode; name: string },
  { error: string | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "Error")
    return { error: message }
  }

  componentDidCatch(error: unknown) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[UnifiedDocumentViewer] renderer crashed:", error)
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border/50 px-4 py-3">
          <h2 className="truncate text-[14px] font-semibold">{this.props.name}</h2>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md space-y-2">
            <p className="text-[14px] font-semibold">No se pudo abrir el documento</p>
            <p className="text-[12px] text-muted-foreground">
              El render del documento falló dentro del navegador. Cierra esta vista y vuelve a intentarlo.
            </p>
            <p className="text-[11px] text-muted-foreground/70">{this.state.error}</p>
          </div>
        </div>
      </div>
    )
  }
}

function formatSize(n: number | null | undefined) {
  if (!n && n !== 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const liquidToolbarClass =
  "border border-white/35 bg-background/78 shadow-[0_16px_44px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.38)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/62 dark:border-white/10 dark:bg-zinc-950/62 dark:shadow-[0_16px_44px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.08)]"

const liquidIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/10"

const liquidGhostButtonClass =
  "h-7 w-7 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/10"

function absUrl(u: string) {
  // Routes through the shared `normalizeBackendAssetUrl` so the
  // /uploads/* origin-rewrite (see lib/attachment-url.ts) stays in
  // one place. Fixes "Failed to fetch" when the backend baked in a
  // BASE_URL that isn't reachable from the browser.
  return normalizeBackendAssetUrl(u, process.env.NEXT_PUBLIC_IMAGE_URL)
}

function useIsDark() {
  const [isDark, setIsDark] = React.useState(false)
  React.useEffect(() => {
    if (typeof document === "undefined") return
    const update = () => setIsDark(document.documentElement.classList.contains("dark"))
    update()
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return isDark
}

export default function UnifiedDocumentViewer({
  open,
  onClose,
  variant = "modal",
  attachment,
  siblings,
  onNavigate,
  className,
}: UnifiedDocumentViewerProps) {
  // ALL hooks must run unconditionally — the early-return for null
  // attachment must come AFTER every hook below, otherwise toggling
  // the viewer between open/closed (which alternates attachment
  // between a value and null) flips the hook count and throws
  // "rendered more/fewer hooks than during the previous render".
  const isDark = useIsDark()
  // Retry counter used as React key on the renderer subtree — bumping
  // it forces a clean remount, which resets all internal state and
  // re-runs effects. The Retry button surfaced inside ErrorState calls
  // `onRetry` which lives in RendererCtx, so any renderer can trigger
  // a retry without explicit prop wiring.
  const [retryKey, setRetryKey] = React.useState(0)
  const onRetry = React.useCallback(() => setRetryKey(k => k + 1), [])
  // Reset retry counter when the user navigates to a different
  // attachment — otherwise an old "I retried 3x" state would carry over.
  React.useEffect(() => { setRetryKey(0) }, [attachment?.id, attachment?.name])

  // Navigation indices for multi-attachment browsing. These compute
  // safely on null attachment (idx = -1) so we can keep them outside
  // the early-return guard.
  const idx = (siblings && attachment)
    ? siblings.findIndex(a => a === attachment || a.id === attachment.id)
    : -1
  const canPrev = !!siblings && idx > 0
  const canNext = !!siblings && idx >= 0 && idx < siblings.length - 1
  const go = React.useCallback((delta: number) => {
    if (!siblings || !onNavigate) return
    const next = siblings[idx + delta]
    if (next) onNavigate(next)
  }, [siblings, onNavigate, idx])

  // Keyboard navigation — arrow Left/Right between siblings while the
  // viewer is open. Ignored when focus is inside an input/textarea or
  // contenteditable (so arrow keys still work for text selection in
  // the renderer itself, e.g. moving the cursor within code viewer).
  React.useEffect(() => {
    if (!open || !attachment) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "ArrowLeft" && canPrev) { e.preventDefault(); go(-1) }
      if (e.key === "ArrowRight" && canNext) { e.preventDefault(); go(1) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, attachment, canPrev, canNext, go])

  // Safe early-return — every hook above ran, so React's hook count
  // stays constant across renders regardless of attachment state.
  if (!open || !attachment) return null
  if (variant === "modal" && typeof document === "undefined") return null

  const kind = detectKind(attachment)
  const Icon = iconForKind(kind)

  const downloadUrl = attachment.url ? absUrl(attachment.url) : null
  const canDownload = !!downloadUrl || !!attachment.file

  const handleDownload = async () => {
    if (downloadUrl) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer")
      return
    }
    if (attachment.file) {
      const url = URL.createObjectURL(attachment.file)
      const a = document.createElement("a")
      a.href = url
      a.download = attachment.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 250)
    }
  }

  const shell = (
    <div
      className={cn(
        variant === "panel" ? "flex h-full w-full min-w-0 flex-col overflow-hidden" : "fixed inset-0 z-[10000]",
        className,
      )}
    >
      {variant === "modal" && (
        <div
          className="absolute inset-0 bg-black/80"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <section
        role="dialog"
        aria-modal={variant === "modal"}
        aria-labelledby="unified-document-viewer-title"
        data-testid="unified-document-viewer-dialog"
        className={cn(
          "flex flex-col overflow-hidden border border-border bg-background p-0",
          variant === "panel"
            ? "h-full w-full rounded-none border-y-0 border-r-0 shadow-none"
            : "fixed left-1/2 top-1/2 z-[10001] h-[85vh] w-[min(96vw,64rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg shadow-lg",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn(
          "relative flex flex-row items-center gap-3 border-b border-border/45 px-4 py-2.5",
          "bg-background/82 shadow-[0_10px_26px_rgba(15,23,42,0.05),inset_0_-1px_0_rgba(255,255,255,0.52)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/68 dark:bg-zinc-950/72 dark:shadow-[0_10px_26px_rgba(0,0,0,0.2),inset_0_-1px_0_rgba(255,255,255,0.05)]",
        )}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/45 bg-background/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] dark:bg-white/[0.04]">
            <Icon className="h-[18px] w-[18px] text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="unified-document-viewer-title" className="truncate text-[14.5px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
              {attachment.name}
            </h2>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {kind !== "unknown" && <span className="uppercase tracking-wide">{kind}</span>}
              {attachment.size ? <span>· {formatSize(attachment.size)}</span> : null}
              {siblings && siblings.length > 1 && idx >= 0 ? (
                <span>· {idx + 1} / {siblings.length}</span>
              ) : null}
            </div>
          </div>

          {siblings && siblings.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={liquidIconButtonClass}
                disabled={!canPrev}
                onClick={() => go(-1)}
                title="Anterior"
                aria-label="Anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={liquidIconButtonClass}
                disabled={!canNext}
                onClick={() => go(1)}
                title="Siguiente"
                aria-label="Siguiente"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Reuse-in-prompt: re-attaches this file to the next composer
              message via a window CustomEvent the chat shell listens to.
              Only meaningful for attachments that already have a backend
              id (i.e., already uploaded). */}
          {attachment.id && (
            <button
              type="button"
              className={liquidIconButtonClass}
              onClick={() => {
                if (typeof window === "undefined") return
                window.dispatchEvent(new CustomEvent("sira:reuse-attachment", {
                  detail: {
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    url: attachment.url,
                    extractedText: attachment.extractedText,
                  },
                }))
              }}
              title="Reutilizar en prompt"
              aria-label="Reutilizar en prompt"
            >
              <Reply className="h-4 w-4" />
            </button>
          )}
          {canDownload && (
            <button
              type="button"
              className={liquidIconButtonClass}
              onClick={handleDownload}
              title="Descargar"
              aria-label="Descargar"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          {downloadUrl && (
            <button
              type="button"
              className={liquidIconButtonClass}
              onClick={() => window.open(downloadUrl, "_blank", "noopener,noreferrer")}
              title="Abrir en nueva pestaña"
              aria-label="Abrir en nueva pestaña"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            className={liquidIconButtonClass}
            onClick={onClose}
            title="Cerrar"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Renderer subtree, wrapped in a context that gives
            LoadingState/ErrorState access to attachment+kind+onRetry,
            and keyed on `retryKey` so "Reintentar" remounts the renderer
            cleanly (resets all internal state, re-runs effects). */}
        <ViewerRenderBoundary name={attachment.name}>
          <RendererCtx.Provider value={{ attachment, kind, onRetry }}>
            <div className="min-h-0 flex-1 overflow-hidden" key={retryKey}>
              <RendererDispatch kind={kind} attachment={attachment} isDark={isDark} />
            </div>
          </RendererCtx.Provider>
        </ViewerRenderBoundary>
      </section>
    </div>
  )

  if (variant === "panel") return shell
  return createPortal(shell, document.body)
}

// ─── Renderer dispatch ───────────────────────────────────────────────

function RendererDispatch({
  kind, attachment, isDark,
}: { kind: Kind; attachment: AttachmentLike; isDark: boolean }) {
  switch (kind) {
    case "image":    return <ImageRenderer a={attachment} />
    case "pdf":      return <PdfRenderer a={attachment} />
    case "csv":      return <CsvRenderer a={attachment} />
    case "xlsx":     return <XlsxRenderer a={attachment} />
    // PPTX (and legacy .ppt): try server-rendered PDF first for layout
    // fidelity; if unavailable, fall back to the JSZip text+image
    // extraction we already have for OOXML .pptx.
    case "pptx":     return (
      <ServerConvertedPdfRenderer
        a={attachment}
        fallback={<PptxRenderer a={attachment} />}
      />
    )
    case "docx":     return <DocxRenderer a={attachment} isDark={isDark} />
    // Legacy binary .doc cannot be parsed in the browser. Server PDF
    // is the only viable preview path; if the server can't convert,
    // we surface the professional fallback (download CTA).
    case "doc":      return (
      <ServerConvertedPdfRenderer
        a={attachment}
        fallback={<FallbackRenderer a={attachment} />}
      />
    )
    case "md":       return <MarkdownRenderer a={attachment} />
    case "html":     return <HtmlRenderer a={attachment} />
    case "xml":
    case "code":     return <CodeRenderer a={attachment} kind={kind} isDark={isDark} />
    case "json":     return <JsonRenderer a={attachment} isDark={isDark} />
    case "text":     return <TextRenderer a={attachment} />
    default:         return <FallbackRenderer a={attachment} />
  }
}

// ─── ServerConvertedPdfRenderer ──────────────────────────────────────

/**
 * Probes the backend's `/api/files/:id/render?target=pdf` endpoint, which
 * runs LibreOffice (or Gotenberg) server-side to convert PPTX/PPT/DOC/
 * RTF/ODP/ODS/ODT to a faithful PDF. On success, the PDF is rendered
 * with the same `PdfRenderer` used for native PDFs — paginated, zoomable,
 * with a real text layer.
 *
 * On any non-200 response (typically 503 if the backend has neither
 * LibreOffice installed nor a Gotenberg URL configured, or 415 for an
 * unsupported source), we render the supplied fallback so the user is
 * never left with an empty modal.
 *
 * The backend caches the produced PDF on disk by file id, so the second
 * open of the same attachment is instant. An additional in-memory
 * `convertedPdfCache` avoids the fetch entirely for re-opens within the
 * same session — the second click on the same PPTX/DOC chip is sub-ms.
 */

const convertedPdfCache = new Map<string, AttachmentLike>()
const convertedPdfPromiseCache = new Map<string, Promise<AttachmentLike>>()

function hasClientPreviewSource(a: AttachmentLike): boolean {
  return !!a.file || !!a.url || !!a.extractedText
}

function canUseServerPdfConversion(a: AttachmentLike): boolean {
  const id = String(a.id || "")
  return !!id && !id.startsWith("temp")
}

function renderedPdfName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || name}.pdf`
}

async function fetchServerConvertedPdfAttachment(a: AttachmentLike): Promise<AttachmentLike> {
  if (!canUseServerPdfConversion(a)) {
    throw new Error("no-stable-id")
  }

  const key = String(a.id)
  const cached = convertedPdfCache.get(key)
  if (cached) return cached

  const inflight = convertedPdfPromiseCache.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    const token = typeof window !== "undefined"
      ? (window.localStorage?.getItem("auth-token") || "")
      : ""
    const base = process.env.NEXT_PUBLIC_IMAGE_URL || ""
    const url = `${base}/api/files/${encodeURIComponent(String(a.id))}/render?target=pdf`
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: "include",
    })
    if (!res.ok) {
      throw new Error(`http-${res.status}`)
    }

    const buf = await res.arrayBuffer()
    const cached = cloneArrayBuffer(buf)
    const pdfBlob = new File([cloneArrayBuffer(cached)], renderedPdfName(a.name), { type: "application/pdf" })
    const pdfAtt: AttachmentLike = {
      id: a.id,
      name: renderedPdfName(a.name),
      mimeType: "application/pdf",
      size: buf.byteLength,
      file: pdfBlob,
    }
    convertedPdfCache.set(key, pdfAtt)
    cacheSet(cacheKeyFor(pdfAtt, "ab"), { buffer: cached })
    return pdfAtt
  })()

  convertedPdfPromiseCache.set(key, promise)
  promise.finally(() => convertedPdfPromiseCache.delete(key)).catch(() => {})
  return promise
}

function ServerConvertedPdfRenderer({
  a, fallback,
}: { a: AttachmentLike; fallback: React.ReactNode }) {
  const [state, setState] = React.useState<"probing" | "ok" | "unavailable">("probing")
  const [pdfAttachment, setPdfAttachment] = React.useState<AttachmentLike | null>(null)
  const [unavailableReason, setUnavailableReason] = React.useState<string>("")

  React.useEffect(() => {
    setState("probing")
    setPdfAttachment(null)
    setUnavailableReason("")
    if (!canUseServerPdfConversion(a)) {
      setState("unavailable")
      setUnavailableReason(a.id ? "temporary-id" : "no-id")
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const pdfAtt = await fetchServerConvertedPdfAttachment(a)
        if (cancelled) return
        setPdfAttachment(pdfAtt)
        setState("ok")
      } catch (e: any) {
        if (!cancelled) {
          setUnavailableReason(e?.message || "fetch-failed")
          setState("unavailable")
        }
      }
    })()
    return () => { cancelled = true }
  }, [a])

  if (state === "probing" && hasClientPreviewSource(a)) return <>{fallback}</>
  if (state === "probing") return <LoadingState label="Generando vista de alta fidelidad…" />
  if (state === "unavailable" || !pdfAttachment) {
    if (process.env.NODE_ENV !== "production" && unavailableReason) {
      // eslint-disable-next-line no-console
      console.debug("[UnifiedDocumentViewer] server PDF unavailable:", unavailableReason)
    }
    return <>{fallback}</>
  }
  return <PdfRenderer a={pdfAttachment} />
}

// ─── Reusable CopyButton (code/json/text copy) ───────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* user gesture / permissions missing */ }
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onCopy}
      className={cn("h-7 gap-1.5 px-2 text-[11.5px] font-medium", className)}
      aria-label="Copiar al portapapeles"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? "Copiado" : "Copiar"}</span>
    </Button>
  )
}

// ─── Utilities for loading raw content ───────────────────────────────

// Module-level LRU cache so re-opening the same attachment (or opening a
// chip after prewarm) avoids re-reading/re-fetching the same bytes.
const MAX_CACHE_SIZE = 50

interface CacheEntry {
  text?: string
  buffer?: ArrayBuffer
  at: number
}

const contentCache = new Map<string, CacheEntry>()

function cacheKeyFor(a: AttachmentLike, suffix: string): string {
  return `${a.id || a.url || a.name || "anon"}:${suffix}`
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = contentCache.get(key)
  if (!entry) return undefined
  entry.at = Date.now()
  return entry
}

function cacheSet(key: string, partial: { text?: string; buffer?: ArrayBuffer }) {
  if (contentCache.size >= MAX_CACHE_SIZE) {
    let oldestKey = ""
    let oldestAt = Infinity
    for (const [k, v] of contentCache) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
    }
    if (oldestKey) contentCache.delete(oldestKey)
  }
  const existing = contentCache.get(key)
  contentCache.set(key, {
    text: partial.text ?? existing?.text,
    buffer: partial.buffer ?? existing?.buffer,
    at: Date.now(),
  })
}

/**
 * Build a fetch init that carries both the session cookie and the
 * Bearer token most of the backend's auth middlewares look for.
 * Without the Bearer header, deploys that protect /uploads/* with a
 * JWT gate (and any future auth-gated asset path) reject the request
 * with HTTP 403 even though the user is logged in — the cookie is
 * not enough on its own.
 */
function authedAssetFetchInit(): RequestInit {
  if (typeof window === "undefined") return { credentials: "include" }
  const token = window.localStorage?.getItem("auth-token") || ""
  return {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }
}

async function fetchAssetBytes(url: string): Promise<Response> {
  const normalized = absUrl(url)
  const init = /^(data:|blob:)/i.test(normalized)
    ? undefined
    : authedAssetFetchInit()
  return fetch(normalized, init)
}

function cloneArrayBuffer(buf: ArrayBuffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength)
  copy.set(new Uint8Array(buf))
  return copy.buffer
}

async function readAsText(a: AttachmentLike): Promise<string> {
  const tKey = cacheKeyFor(a, "text")
  const cachedText = cacheGet(tKey)
  if (cachedText?.text !== undefined) return cachedText.text

  if (a.extractedText) {
    cacheSet(tKey, { text: a.extractedText })
    return a.extractedText
  }

  if (a.file) {
    const text = await a.file.text()
    cacheSet(tKey, { text })
    return text
  }

  if (a.url) {
    const res = await fetchAssetBytes(a.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    cacheSet(tKey, { text })
    return text
  }

  throw new Error("No source available")
}

async function readAsArrayBuffer(a: AttachmentLike): Promise<ArrayBuffer> {
  const bKey = cacheKeyFor(a, "ab")
  const cachedBuf = cacheGet(bKey)
  if (cachedBuf?.buffer) return cloneArrayBuffer(cachedBuf.buffer)

  if (a.file) {
    try {
      const buf = await a.file.arrayBuffer()
      const cached = cloneArrayBuffer(buf)
      cacheSet(bKey, { buffer: cached })
      return cloneArrayBuffer(cached)
    } catch (fileErr) {
      if (!a.url) throw fileErr
    }
  }

  if (a.url) {
    const res = await fetchAssetBytes(a.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const cached = cloneArrayBuffer(buf)
    cacheSet(bKey, { buffer: cached })
    return cloneArrayBuffer(cached)
  }

  throw new Error("No source available")
}

export function prewarmUnifiedDocumentPreview(a: AttachmentLike): void {
  if (typeof window === "undefined") return
  const kind = detectKind(a)

  if (["doc", "docx", "xlsx", "pptx"].includes(kind) && canUseServerPdfConversion(a)) {
    void fetchServerConvertedPdfAttachment(a).catch(() => null)
  }

  if (["pdf", "docx", "xlsx", "pptx"].includes(kind) && (a.file || a.url)) {
    void readAsArrayBuffer(a).catch(() => null)
  }

  if (kind === "docx" && hasClientPreviewSource(a)) {
    void loadDocxPreview().catch(() => null)
  }

  if (["csv", "md", "html", "xml", "json", "text", "code"].includes(kind) && hasClientPreviewSource(a)) {
    void readAsText(a).catch(() => null)
  }
}

// ─── Renderer context ────────────────────────────────────────────────
//
// Avoids prop-drilling `attachment`, `kind`, and `onRetry` into every
// nested LoadingState / ErrorState. Provided at dispatch level by
// UnifiedDocumentViewer, consumed by the shared Loading/Error UI so
// they can show format-aware skeletons and a working Retry button
// without each renderer re-wiring the same props.
interface RendererCtxValue {
  attachment: AttachmentLike
  kind: Kind
  onRetry: () => void
}
const RendererCtx = React.createContext<RendererCtxValue | null>(null)

// ─── Skeletons (per-format shimmer) ──────────────────────────────────

function SkLine({
  w = "100%", h = 12, className = "", delay = 0,
}: { w?: string | number; h?: number; className?: string; delay?: number }) {
  return (
    <div
      className={cn("rounded bg-muted animate-pulse", className)}
      style={{
        width: typeof w === "number" ? `${w}px` : w,
        height: `${h}px`,
        animationDelay: `${delay}ms`,
      }}
    />
  )
}

function SkeletonGeneric({ label }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-2">
        <ThinkingIndicator size="md" />
        {label ? <span className="text-[12px]">{label}</span> : null}
      </div>
    </div>
  )
}

function SkeletonPdf() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <SkLine w={28} h={20} />
        <SkLine w={60} h={20} delay={80} />
        <div className="ml-auto flex items-center gap-1.5">
          <SkLine w={28} h={20} />
          <SkLine w={48} h={20} delay={60} />
          <SkLine w={28} h={20} delay={120} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 px-3 py-4">
        <div className="mx-auto max-w-[680px] space-y-3 rounded-sm bg-card p-8 shadow-md ring-1 ring-border/30">
          <SkLine w="60%" h={20} />
          <SkLine w="92%" h={11} delay={60} />
          <SkLine w="88%" h={11} delay={90} />
          <SkLine w="94%" h={11} delay={120} />
          <SkLine w="40%" h={11} delay={150} />
          <div className="h-3" />
          <SkLine w="50%" h={16} delay={180} />
          <SkLine w="95%" h={11} delay={210} />
          <SkLine w="89%" h={11} delay={240} />
          <SkLine w="93%" h={11} delay={270} />
          <SkLine w="35%" h={11} delay={300} />
        </div>
      </div>
    </div>
  )
}

function SkeletonXlsx() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
        <SkLine w={64} h={22} />
        <SkLine w={48} h={22} delay={60} />
        <SkLine w={48} h={22} delay={120} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="grid grid-cols-6 gap-px overflow-hidden rounded border border-border/40 bg-border/40">
          {Array.from({ length: 6 * 9 }).map((_, i) => (
            <div
              key={i}
              className="h-7 bg-card animate-pulse"
              style={{ animationDelay: `${(i % 6) * 70 + Math.floor(i / 6) * 30}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SkeletonPptx() {
  return (
    <div className="flex h-full">
      <div className="flex w-44 shrink-0 flex-col gap-1.5 border-r border-border/40 bg-muted/20 p-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border/40 bg-card p-2">
            <SkLine w={50} h={8} className="mb-1.5" delay={i * 80} />
            <SkLine w="80%" h={12} delay={i * 80 + 40} />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden bg-muted/10 p-6">
        <div className="mx-auto flex aspect-[16/9] max-w-4xl flex-col rounded-lg border border-border/50 bg-card p-8 shadow-sm">
          <SkLine w="55%" h={22} className="mb-4" />
          <SkLine w="92%" h={12} delay={80} />
          <SkLine w="88%" h={12} delay={120} className="mt-2" />
          <SkLine w="60%" h={12} delay={160} className="mt-2" />
          <div className="mt-auto flex justify-end">
            <SkLine w={36} h={10} delay={240} />
          </div>
        </div>
      </div>
    </div>
  )
}

function SkeletonDocx() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 px-3 py-6">
        <div className="mx-auto max-w-[680px] space-y-3 rounded-sm bg-card p-10 shadow-md ring-1 ring-border/30">
          <SkLine w="50%" h={22} />
          <div className="h-3" />
          <SkLine w="95%" h={11} delay={60} />
          <SkLine w="92%" h={11} delay={90} />
          <SkLine w="88%" h={11} delay={120} />
          <SkLine w="40%" h={11} delay={150} />
          <div className="h-3" />
          <SkLine w="92%" h={11} delay={180} />
          <SkLine w="86%" h={11} delay={210} />
          <SkLine w="93%" h={11} delay={240} />
        </div>
      </div>
    </div>
  )
}

function SkeletonImage() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/20 p-8">
      <div className="flex aspect-square w-full max-w-md items-center justify-center rounded-lg bg-muted animate-pulse">
        <ImageIcon className="h-10 w-10 text-muted-foreground/40" />
      </div>
    </div>
  )
}

function LoadingState({ label }: { label?: string }) {
  const ctx = React.useContext(RendererCtx)
  const kind = ctx?.kind
  switch (kind) {
    case "pdf":
    case "doc":  return <SkeletonPdf />
    case "xlsx":
    case "csv":  return <SkeletonXlsx />
    case "pptx": return <SkeletonPptx />
    case "docx": return <SkeletonDocx />
    case "image": return <SkeletonImage />
    default:     return <SkeletonGeneric label={label} />
  }
}

// Typed error state. Pulls attachment/kind/onRetry from RendererCtx so
// every renderer's `<ErrorState error={…} />` automatically gets the
// correct format icon, a working Download CTA backed by the actual
// attachment, and a Retry button that remounts the renderer.
function ErrorState({ error, hint }: { error: string; hint?: string }) {
  const ctx = React.useContext(RendererCtx)
  const Icon = ctx ? iconForKind(ctx.kind) : AlertTriangle
  const a = ctx?.attachment
  const onRetry = ctx?.onRetry
  const downloadUrl = a?.url ? absUrl(a.url) : null
  const canDownload = !!downloadUrl || !!a?.file

  const handleDownload = async () => {
    if (!a) return
    if (downloadUrl) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer")
      return
    }
    if (a.file) {
      const u = URL.createObjectURL(a.file)
      const link = document.createElement("a")
      link.href = u
      link.download = a.name
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(u), 250)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="rounded-full bg-amber-500/10 p-3 ring-1 ring-amber-500/25">
        <Icon className="h-7 w-7 text-amber-600 dark:text-amber-400" />
      </div>
      <div>
        <p className="text-[14px] font-semibold">No se pudo abrir el documento</p>
        <p className="mx-auto mt-1 max-w-md text-[12px] text-muted-foreground">{error}</p>
        {hint && <p className="mx-auto mt-1 max-w-md text-[11px] text-muted-foreground/70">{hint}</p>}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {canDownload && (
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Descargar archivo original
          </Button>
        )}
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reintentar
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Image ───────────────────────────────────────────────────────────

function ImageRenderer({ a }: { a: AttachmentLike }) {
  const src = React.useMemo(() => {
    if (a.file) return URL.createObjectURL(a.file)
    if (a.url) return absUrl(a.url)
    return null
  }, [a])
  React.useEffect(() => {
    return () => { if (src && src.startsWith("blob:")) URL.revokeObjectURL(src) }
  }, [src])

  const [zoom, setZoom] = React.useState(1)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const dragRef = React.useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  // Reset pan when zoom drops back to fit-to-screen.
  React.useEffect(() => { if (zoom <= 1) setPan({ x: 0, y: 0 }) }, [zoom])

  // Cmd/Ctrl + wheel → zoom centered on the image. Plain wheel without
  // modifier scrolls the container as usual (so users with long images
  // can still scroll naturally).
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      // deltaY is negative when scrolling up (= zoom in); use a smooth
      // exponential factor so the zoom feels uniform regardless of
      // current scale.
      const factor = Math.exp(-e.deltaY * 0.0015)
      setZoom(z => Math.min(8, Math.max(0.25, +(z * factor).toFixed(3))))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Drag-to-pan when zoomed in. Below 1× the image fits the viewport,
  // so panning is a no-op.
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoom <= 1) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setPan({ x: d.baseX + (ev.clientX - d.startX), y: d.baseY + (ev.clientY - d.startY) })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  // Double-click toggles between fit (1×) and 2× zoom for quick inspection.
  const onDoubleClick = () => setZoom(z => (z === 1 ? 2 : 1))

  if (!src) return <FallbackRenderer a={a} />
  const cursor = zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in"

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-muted/40 dark:bg-background"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      style={{ cursor }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- viewer accepts arbitrary attachment URLs (uploads, blob:, data:); we already use raw <img> for zoom/pan transforms. */}
      <img
        src={src}
        alt={a.name}
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
          transformOrigin: "center",
          transition: dragRef.current ? "none" : "transform 120ms ease-out",
        }}
        className="max-h-full max-w-full select-none will-change-transform"
        draggable={false}
      />
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-border/60 bg-background/85 px-1 py-0.5 shadow-md backdrop-blur">
        <Button size="icon" variant="ghost" className="h-7 w-7"
          onClick={() => setZoom(z => Math.max(0.25, +(z - 0.25).toFixed(2)))} aria-label="Reducir" title="Reducir">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}
          className="min-w-[44px] rounded px-1 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground hover:bg-muted"
          title="Restablecer (doble click)"
          aria-label="Restablecer zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button size="icon" variant="ghost" className="h-7 w-7"
          onClick={() => setZoom(z => Math.min(8, +(z + 0.25).toFixed(2)))} aria-label="Aumentar" title="Aumentar">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 select-none rounded-full border border-border/60 bg-background/85 px-2 py-0.5 text-[10px] text-muted-foreground/80 shadow-sm backdrop-blur">
        ⌘+Scroll para zoom · doble click para reset
      </div>
    </div>
  )
}

// ─── PDF ─────────────────────────────────────────────────────────────

/**
 * High-fidelity PDF renderer using pdf.js (via react-pdf).
 *
 * Why we don't use the browser's native `<iframe src="...#toolbar=1">`:
 *   • Inconsistent toolbar across Chrome / Safari / Firefox / mobile
 *   • Some browsers strip the `#toolbar` hint entirely (PDFium ignores it)
 *   • No control over zoom, no programmatic page nav, no theme awareness
 *   • Selection layer behaves differently per engine
 *
 * pdf.js gives us:
 *   • paginated rendering with virtual scroll (fast on huge PDFs)
 *   • text layer for proper text selection + Cmd/Ctrl-F find
 *   • controllable zoom (Fit width / 50–300%)
 *   • predictable styling under light/dark mode
 *   • runs entirely in the browser — no server round-trip
 */
function PdfRenderer({ a }: { a: AttachmentLike }) {
  // pdf.js accepts a URL string OR a `{ data: Uint8Array }` payload.
  // Using `data` for in-memory File blobs avoids creating a blob URL
  // that pdf.js would have to refetch over HTTP.
  const [source, setSource] = React.useState<{ url: string } | { data: Uint8Array } | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [numPages, setNumPages] = React.useState<number>(0)
  const [scale, setScale] = React.useState<number>(1)
  const [containerWidth, setContainerWidth] = React.useState<number>(800)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pageRefs = React.useRef<Record<number, HTMLDivElement | null>>({})
  const [activePage, setActivePage] = React.useState<number>(1)

  // Resolve through the same authenticated byte loader used by the
  // other document renderers. A plain pdf.js URL load cannot attach the
  // Bearer token required by protected /uploads assets.
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const buf = await readAsArrayBuffer(a)
        if (!cancelled) setSource({ data: new Uint8Array(cloneArrayBuffer(buf)) })
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Error")
      }
    })()
    return () => { cancelled = true }
  }, [a])

  // Track container width for "fit-to-width" rendering.
  React.useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        // Subtract scrollbar gutter so pages don't overflow.
        const w = Math.max(320, Math.floor(entry.contentRect.width) - 24)
        setContainerWidth(w)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // IntersectionObserver — track which page is currently most visible so
  // the "page X of Y" indicator stays accurate while the user scrolls.
  React.useEffect(() => {
    if (!numPages) return
    const root = containerRef.current
    if (!root) return
    const visibility = new Map<number, number>()
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.pageNum)
          if (Number.isFinite(n)) visibility.set(n, e.intersectionRatio)
        }
        let bestPage = 1
        let bestRatio = 0
        visibility.forEach((ratio, page) => {
          if (ratio > bestRatio) { bestRatio = ratio; bestPage = page }
        })
        if (bestRatio > 0) setActivePage(bestPage)
      },
      { root, threshold: [0.1, 0.3, 0.55, 0.8] },
    )
    Object.values(pageRefs.current).forEach(el => { if (el) io.observe(el) })
    return () => io.disconnect()
  }, [numPages])

  const goToPage = (p: number) => {
    const target = Math.min(Math.max(1, p), numPages || 1)
    const el = pageRefs.current[target]
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
    setActivePage(target)
  }

  // Keyboard shortcuts within the PDF viewer.
  React.useEffect(() => {
    if (!numPages) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "PageDown" || e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); goToPage(activePage + 1)
      } else if (e.key === "PageUp" || e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); goToPage(activePage - 1)
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault(); setScale(s => Math.min(3, +(s + 0.25).toFixed(2)))
      } else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault(); setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))
      } else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault(); setScale(1)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // goToPage is defined elsewhere in the component but reads the
    // latest numPages/activePage from these deps — the function
    // identity is recreated per render, listing it would lint-loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, activePage])

  if (err) return <ErrorState error={err} hint="Si el archivo está cifrado o protegido, descárgalo y ábrelo en un visor PDF nativo." />
  if (!source) return <LoadingState label="Cargando PDF…" />

  const renderWidth = Math.floor(containerWidth * scale)

  return (
    <div className="relative flex h-full flex-col">
      {/* Pages */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-muted/30 px-3 pb-20 pt-4">
        <PdfDocument
          file={source}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          onLoadError={(e) => setErr(e?.message || "No se pudo abrir el PDF")}
          loading={<LoadingState label="Renderizando PDF…" />}
          error={<ErrorState error="No se pudo abrir el PDF" />}
          className="flex flex-col items-center gap-3"
        >
          {Array.from({ length: numPages }, (_, i) => i + 1).map(p => (
            <div
              key={p}
              data-page-num={p}
              ref={el => { pageRefs.current[p] = el }}
              className="rounded-sm bg-white dark:bg-zinc-800 shadow-md ring-1 ring-border/30"
            >
              <PdfPage
                pageNumber={p}
                width={renderWidth}
                renderTextLayer
                renderAnnotationLayer
              />
            </div>
          ))}
        </PdfDocument>
      </div>

      {/* Bottom liquid-glass controls */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
        <div className={cn("pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1", liquidToolbarClass)}>
          <Button size="icon" variant="ghost" className={liquidGhostButtonClass}
            disabled={activePage <= 1}
            onClick={() => goToPage(activePage - 1)}
            aria-label="Página anterior" title="Página anterior">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="flex items-center gap-1 rounded-full border border-border/35 bg-background/48 px-1.5 py-0.5 text-[11.5px] font-medium tabular-nums text-foreground/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.34)]">
            <input
              type="number"
              min={1}
              max={numPages || 1}
              value={activePage}
              onChange={e => {
                const n = parseInt(e.target.value, 10)
                if (Number.isFinite(n)) setActivePage(Math.min(Math.max(1, n), numPages || 1))
              }}
              onKeyDown={e => { if (e.key === "Enter") goToPage(activePage) }}
              onBlur={() => goToPage(activePage)}
              className="h-6 w-10 rounded-full border border-transparent bg-transparent px-1 text-center text-[11.5px] tabular-nums focus:border-border/70 focus:bg-background/70 focus:outline-none"
              aria-label="Número de página"
            />
            <span className="pr-1 text-muted-foreground">/ {numPages || "…"}</span>
          </div>
          <Button size="icon" variant="ghost" className={liquidGhostButtonClass}
            disabled={activePage >= numPages}
            onClick={() => goToPage(activePage + 1)}
            aria-label="Página siguiente" title="Página siguiente">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>

          <div className="mx-0.5 h-5 w-px bg-border/50" />

          <Button size="icon" variant="ghost" className={liquidGhostButtonClass}
            onClick={() => setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))}
            aria-label="Reducir zoom" title="Reducir (⌘−)">
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <button
            onClick={() => setScale(1)}
            className="h-7 min-w-[52px] rounded-full border border-border/35 bg-background/48 px-2 text-[11px] font-semibold tabular-nums text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.34)] hover:bg-background/65"
            title="Restablecer zoom (⌘0)"
            aria-label="Restablecer zoom"
          >
            {Math.round(scale * 100)}%
          </button>
          <Button size="icon" variant="ghost" className={liquidGhostButtonClass}
            onClick={() => setScale(s => Math.min(3, +(s + 0.25).toFixed(2)))}
            aria-label="Aumentar zoom" title="Aumentar (⌘+)">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className={liquidGhostButtonClass}
            onClick={() => setScale(1)}
            aria-label="Ajustar al ancho" title="Ajustar al ancho">
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Text ────────────────────────────────────────────────────────────

function TextRenderer({ a }: { a: AttachmentLike }) {
  const [text, setText] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [wrap, setWrap] = React.useState(true)

  React.useEffect(() => {
    ;(async () => {
      try { setText(await readAsText(a)) } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])

  if (err) return <ErrorState error={err} />
  if (text === null) return <LoadingState />
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />
          Ajustar líneas
        </label>
        <CopyButton text={text} />
      </div>
      <pre
        className={cn(
          "min-h-0 flex-1 overflow-auto p-4",
          "font-mono text-[12.5px] leading-[1.55] text-foreground/90",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
      >
        {text}
      </pre>
    </div>
  )
}

// ─── Markdown ────────────────────────────────────────────────────────

function MarkdownRenderer({ a }: { a: AttachmentLike }) {
  const [text, setText] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    ;(async () => {
      try { setText(await readAsText(a)) } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])
  if (err) return <ErrorState error={err} />
  if (text === null) return <LoadingState />
  return (
    <div className="h-full overflow-auto">
      <div className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}

// ─── JSON ────────────────────────────────────────────────────────────

function JsonRenderer({ a, isDark }: { a: AttachmentLike; isDark: boolean }) {
  const [text, setText] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    ;(async () => {
      try {
        const raw = await readAsText(a)
        try {
          setText(JSON.stringify(JSON.parse(raw), null, 2))
        } catch {
          setText(raw) // fallback: show raw if not valid JSON
        }
      } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])
  if (err) return <ErrorState error={err} />
  if (text === null) return <LoadingState />
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border/40 px-3 py-1.5">
        <CopyButton text={text} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ShikiCodeView
          code={text}
          language="json"
          theme={isDark ? "one-dark-pro" : "github-light"}
          showLineNumbers
          className="min-h-full bg-transparent"
        />
      </div>
    </div>
  )
}

// ─── Code ────────────────────────────────────────────────────────────

function CodeRenderer({ a, kind, isDark }: { a: AttachmentLike; kind: Kind; isDark: boolean }) {
  const [text, setText] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const ext = extOf(a.name).toLowerCase()
  const lang = kind === "xml" ? "xml" : (CODE_EXTENSIONS[ext] || "text")

  React.useEffect(() => {
    ;(async () => {
      try { setText(await readAsText(a)) } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])
  if (err) return <ErrorState error={err} />
  if (text === null) return <LoadingState />
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{lang}</span>
        <CopyButton text={text} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ShikiCodeView
          code={text}
          language={lang}
          theme={isDark ? "one-dark-pro" : "github-light"}
          showLineNumbers
          className="min-h-full bg-transparent"
        />
      </div>
    </div>
  )
}

// ─── HTML ────────────────────────────────────────────────────────────

// DOMPurify-backed sanitization. We keep two profiles:
//   • `sanitizeHtml`        — for arbitrary HTML files (HtmlRenderer).
//                             Stripped of scripts, event handlers, and
//                             javascript: / data: (non-image) URIs.
//   • `sanitizeDocxHtml`    — for HTML produced by mammoth from DOCX,
//                             which legitimately needs inline images
//                             via `data:image/...` URIs.
function sanitizeHtml(html: string): string {
  if (typeof window === "undefined") return ""
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style", "srcset"],
    ALLOW_DATA_ATTR: false,
  })
}

function sanitizeDocxHtml(html: string): string {
  if (typeof window === "undefined") return ""
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    // DOCX inline images come back as data:image/* — keep them.
    ADD_DATA_URI_TAGS: ["img"],
  })
}

function HtmlRenderer({ a }: { a: AttachmentLike }) {
  const [html, setHtml] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    ;(async () => {
      try { setHtml(sanitizeHtml(await readAsText(a))) } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])
  if (err) return <ErrorState error={err} />
  if (html === null) return <LoadingState />
  // iframe sandbox blocks scripts + same-origin access. Plus srcDoc
  // ensures no network fetches happen from cross-origin refs.
  return (
    <iframe
      title={a.name}
      srcDoc={html}
      sandbox=""
      className="h-full w-full bg-white dark:bg-zinc-900"
    />
  )
}

// ─── CSV ─────────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') inQuotes = false
      else cell += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ",") { row.push(cell); cell = "" }
      else if (c === "\n") { row.push(cell); cell = ""; rows.push(row); row = [] }
      else if (c === "\r") { /* skip */ }
      else cell += c
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function CsvRenderer({ a }: { a: AttachmentLike }) {
  const [rows, setRows] = React.useState<string[][] | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    ;(async () => {
      try { setRows(parseCsv(await readAsText(a))) } catch (e: any) { setErr(e?.message || "Error") }
    })()
  }, [a])
  if (err) return <ErrorState error={err} />
  if (!rows) return <LoadingState />
  const [head, ...body] = rows
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-muted/70 backdrop-blur">
          <tr>
            {(head || []).map((h, i) => (
              <th key={i} className="border-b border-border/60 px-3 py-2 text-left font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="odd:bg-background even:bg-muted/20">
              {r.map((cell, j) => (
                <td key={j} className="border-b border-border/30 px-3 py-1.5 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── XLSX (ExcelJS) ──────────────────────────────────────────────────

/**
 * XLSX renderer — bounded client-side preview via ExcelJS. We render a
 * capped grid so malicious or accidental giant workbooks cannot lock up
 * the browser while still giving users a useful inspection surface.
 */
function XlsxRenderer({ a }: { a: AttachmentLike }) {
  const [wb, setWb] = React.useState<any | null>(null)
  const [active, setActive] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
        const buf = await readAsArrayBuffer(a)
        const parsed = await readXlsxWorkbook(cloneArrayBuffer(buf))
        setWb(parsed)
        setActive(parsed.worksheets[0]?.name || null)
      } catch (e: any) {
        setErr(e?.message || "Error")
      }
    })()
  }, [a])

  if (err) return <ErrorState error={err} />
  if (!wb || !active) return <LoadingState label="Leyendo hoja de cálculo…" />

  const sheet = wb.worksheets.find((worksheet: any) => worksheet.name === active) || wb.worksheets[0]
  if (!sheet) return <ErrorState error="El workbook no contiene hojas visibles." />
  const maxRows = 500
  const maxColumns = 80
  const rowNumbers: number[] = []
  const rowLimit = Math.min(maxRows, Math.max(0, Number(sheet.actualRowCount || sheet.rowCount || 0)))
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const values = Array.isArray(row?.values) ? row.values.slice(1, maxColumns + 1) : []
    if (values.some((value: any) => String(xlsxCellToText(value)).trim())) rowNumbers.push(rowNumber)
  }
  const columnCount = Math.min(maxColumns, Math.max(1, Number(sheet.actualColumnCount || sheet.columnCount || 1)))
  const colIdx = Array.from({ length: columnCount }, (_, index) => index + 1)
  const truncatedRows = Number(sheet.actualRowCount || 0) > maxRows
  const truncatedColumns = Number(sheet.actualColumnCount || 0) > maxColumns

  return (
    <div className="flex h-full flex-col">
      {/* Sheet tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border/40 px-2 py-1.5">
        {wb.worksheets.map((worksheet: any) => (
          <button
            key={worksheet.name}
            onClick={() => setActive(worksheet.name)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap transition-colors",
              worksheet.name === active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {worksheet.name}
          </button>
        ))}
      </div>
      {(truncatedRows || truncatedColumns) && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          Vista acotada: se muestran hasta {maxRows} filas y {maxColumns} columnas para proteger el navegador.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-[12px]" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead className="sticky top-0 z-20 bg-muted/80 backdrop-blur">
            <tr>
              <th className="sticky left-0 z-30 border-b border-r border-border/60 bg-muted/80 px-2 py-1 text-[10px] font-semibold text-muted-foreground w-10">#</th>
              {colIdx.map(c => (
                <th
                  key={c}
                  className="border-b border-r border-border/40 px-3 py-1 text-left font-semibold text-[10px] uppercase tracking-wide text-muted-foreground"
                  style={sheet.getColumn(c)?.width ? { minWidth: Math.max(sheet.getColumn(c).width * 7, 72) } : undefined}
                >
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowNumbers.map(r => (
              <tr key={r} className="odd:bg-background even:bg-muted/10">
                <td className="sticky left-0 z-10 border-b border-r border-border/30 bg-inherit px-2 py-1 text-[10px] text-muted-foreground text-right">{r}</td>
                {colIdx.map(c => {
                  const cell = sheet.getRow(r).getCell(c)
                  const value = cell?.value
                  const display = xlsxCellToText(value)
                  const isNumber = typeof value === "number"
                  return (
                    <td
                      key={c}
                      className={cn(
                        "border-b border-r border-border/20 px-3 py-1 align-top",
                        isNumber && "text-right",
                      )}
                      title={value != null ? `Valor bruto: ${display}` : undefined}
                    >
                      {display}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function columnLabel(index: number) {
  let n = index
  let label = ""
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

// ─── PPTX (client-side text + image extraction via JSZip) ────────────

interface SlideExtract {
  index: number
  title: string | null
  paragraphs: Array<{ text: string; level: number }>
  images: string[]   // data URIs
}

async function extractPptx(buf: ArrayBuffer): Promise<SlideExtract[]> {
  const zip = await JSZip.loadAsync(buf)
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || "0", 10)
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || "0", 10)
      return na - nb
    })

  // Build a filename → data URI map for all media referenced by slides.
  const mediaEntries = Object.keys(zip.files).filter(n => n.startsWith("ppt/media/"))
  const mediaDataUris: Record<string, string> = {}
  await Promise.all(mediaEntries.map(async (name) => {
    const ext = name.split(".").pop()?.toLowerCase() || ""
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml",
    }
    const mime = mimeMap[ext]
    if (!mime) return
    const b64 = await zip.files[name].async("base64")
    const shortName = name.replace(/^ppt\/media\//, "")
    mediaDataUris[shortName] = `data:${mime};base64,${b64}`
  }))

  const slides: SlideExtract[] = []
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async("string")
    // Extract paragraphs with text runs, preserving list level.
    const paras: Array<{ text: string; level: number }> = []
    // <a:p> paragraph → contains <a:pPr lvl="N"> (optional) + <a:r>/<a:t>runs
    const pMatches = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || []
    for (const p of pMatches) {
      const lvlMatch = p.match(/<a:pPr[^>]*\blvl="(\d+)"/)
      const level = lvlMatch ? parseInt(lvlMatch[1], 10) : 0
      // All <a:t>...</a:t> joined — skips formatting but keeps text order.
      const tRuns = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => m[1])
      const text = tRuns.join("").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      if (text.trim()) paras.push({ text, level })
    }
    // Images — every <p:pic> element references media via r:embed — but
    // we need slideN.xml.rels to resolve. Quick-and-dirty: just pull any
    // media file that the slide's rels file references.
    const relsPath = slideNames[i].replace("slides/", "slides/_rels/") + ".rels"
    const relsZip = zip.files[relsPath]
    const images: string[] = []
    if (relsZip) {
      const rels = await relsZip.async("string")
      const matches = [...rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)]
      matches.forEach(m => {
        const uri = mediaDataUris[m[1]]
        if (uri) images.push(uri)
      })
    }
    // First paragraph is often the title — use it as the slide title.
    const title = paras[0]?.text || null
    const body = paras.length > 0 ? paras.slice(1) : []
    slides.push({ index: i + 1, title, paragraphs: body, images })
  }
  return slides
}

function PptxRenderer({ a }: { a: AttachmentLike }) {
  const [slides, setSlides] = React.useState<SlideExtract[] | null>(null)
  const [active, setActive] = React.useState(0)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
        const buf = await readAsArrayBuffer(a)
        setSlides(await extractPptx(cloneArrayBuffer(buf)))
      } catch (e: any) {
        setErr(e?.message || "Error")
      }
    })()
  }, [a])

  // Keyboard nav WITHIN the deck — overrides the outer sibling-nav in
  // this renderer because slide-by-slide nav is more contextual here.
  React.useEffect(() => {
    if (!slides || slides.length <= 1) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "ArrowLeft") { e.preventDefault(); setActive(i => Math.max(0, i - 1)) }
      if (e.key === "ArrowRight") { e.preventDefault(); setActive(i => Math.min(slides.length - 1, i + 1)) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [slides])

  if (err) return <ErrorState error={err} hint="Descarga y abre con PowerPoint / Keynote para fidelidad completa." />
  if (!slides) return <LoadingState label="Extrayendo diapositivas…" />
  if (slides.length === 0) return <FallbackRenderer a={a} />

  const slide = slides[active]

  return (
    <div className="flex h-full">
      {/* Slide strip (left) */}
      <div className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-border/40 bg-muted/20 py-2">
        {slides.map((s, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={cn(
              "mx-2 mb-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-all",
              i === active
                ? "border-foreground/40 bg-background shadow-sm font-semibold"
                : "border-transparent hover:border-border/60 hover:bg-background/50 text-muted-foreground",
            )}
          >
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground/80">
              Slide {s.index}
            </div>
            <div className="mt-0.5 truncate">
              {s.title || <span className="italic text-muted-foreground/70">(sin título)</span>}
            </div>
          </button>
        ))}
      </div>
      {/* Slide body (right) — 16:9 frame so the viewport feels like a slide */}
      <div className="min-w-0 flex-1 overflow-auto bg-muted/10 p-6">
        <div className="mx-auto flex aspect-[16/9] max-w-4xl flex-col rounded-lg border border-border/50 bg-background p-8 shadow-sm">
          {slide.title && (
            <h2 className="mb-4 text-[22px] font-semibold leading-tight tracking-tight">
              {slide.title}
            </h2>
          )}
          <div className="flex-1 space-y-2 overflow-auto">
            {slide.paragraphs.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-[14px] leading-[1.55]"
                style={{ paddingLeft: `${p.level * 18}px` }}
              >
                <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/60" />
                <span>{p.text}</span>
              </div>
            ))}
            {slide.images.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-3">
                {slide.images.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element -- slide images come from in-memory PPTX extraction (blob: / data: URLs).
                  <img key={i} src={src} alt="" className="max-h-48 max-w-full rounded-md border border-border/40" />
                ))}
              </div>
            )}
            {slide.paragraphs.length === 0 && slide.images.length === 0 && !slide.title && (
              <p className="text-[13px] italic text-muted-foreground">(Diapositiva sin contenido de texto)</p>
            )}
          </div>
          <div className="mt-3 text-right text-[10px] text-muted-foreground/70">
            {slide.index} / {slides.length}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── DOCX (docx-preview, mammoth fallback) ──────────────────────────

/**
 * High-fidelity DOCX renderer:
 *   1. Primary path: `docx-preview` renders the document into the actual
 *      page-sized boxes from the .docx (sectPr / pgSz / pgMar), with real
 *      headers/footers, multi-column layouts, table styling, embedded
 *      images, list numbering, and the document's own fonts where
 *      available. The output looks like Word, not "HTML approximation".
 *   2. Fallback path: if docx-preview throws (corrupted .docx, exotic
 *      content types it doesn't grok yet), we fall back to mammoth's
 *      HTML conversion — lower fidelity but more lenient parser.
 *   3. Last-resort: if mammoth also throws, surface the error with a
 *      Download CTA so the user is never left at a broken modal.
 */
function DocxRenderer({ a, isDark: _isDark }: { a: AttachmentLike; isDark: boolean }) {
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const [mode, setMode] = React.useState<"loading" | "native" | "fallback" | "extracted" | "error">("loading")
  const [fallbackHtml, setFallbackHtml] = React.useState<string>("")
  const [err, setErr] = React.useState<string | null>(null)
  const [scale, setScale] = React.useState<number>(1)
  const [pageCount, setPageCount] = React.useState<number>(0)
  const [activePage, setActivePage] = React.useState<number>(1)

  React.useEffect(() => {
    setScale(1)
    setPageCount(0)
    setActivePage(1)
  }, [a.id, a.name])

  const getNativeDocxPages = React.useCallback((): HTMLElement[] => {
    const frameDoc = iframeRef.current?.contentDocument
    if (!frameDoc) return []
    return Array.from(frameDoc.querySelectorAll<HTMLElement>("section.docx, section.docx-preview-doc"))
  }, [])

  const updateNativePageState = React.useCallback(() => {
    const frame = iframeRef.current
    const frameWin = frame?.contentWindow
    const frameDoc = frame?.contentDocument
    if (!frameWin || !frameDoc) return
    const pages = getNativeDocxPages()
    if (!pages.length) {
      setPageCount(0)
      setActivePage(1)
      return
    }

    setPageCount(pages.length)

    const viewportHeight = frameWin.innerHeight || frameDoc.documentElement.clientHeight || 1
    let bestPage = 1
    let bestVisible = -1
    let bestDistance = Number.POSITIVE_INFINITY

    pages.forEach((page, index) => {
      const rect = page.getBoundingClientRect()
      const visible = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0))
      const distance = Math.abs(rect.top)
      if (visible > bestVisible || (visible === bestVisible && distance < bestDistance)) {
        bestVisible = visible
        bestDistance = distance
        bestPage = index + 1
      }
    })

    setActivePage(bestPage)
  }, [getNativeDocxPages])

  const applyNativeZoom = React.useCallback((nextScale: number) => {
    const frameDoc = iframeRef.current?.contentDocument
    if (!frameDoc?.body) return
    ;(frameDoc.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(nextScale)
    frameDoc.body.style.transformOrigin = "top center"
    frameDoc.body.style.transition = "zoom 160ms ease"
    window.requestAnimationFrame(updateNativePageState)
  }, [updateNativePageState])

  const goToNativePage = React.useCallback((page: number) => {
    const pages = getNativeDocxPages()
    const total = pages.length || 1
    const target = Math.min(Math.max(1, page), total)
    pages[target - 1]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setActivePage(target)
  }, [getNativeDocxPages])

  React.useEffect(() => {
    if (mode !== "native") return
    applyNativeZoom(scale)
  }, [mode, scale, applyNativeZoom])

  React.useEffect(() => {
    if (mode !== "native") return
    const frame = iframeRef.current
    const frameWin = frame?.contentWindow
    const frameDoc = frame?.contentDocument
    if (!frameWin || !frameDoc) return

    const onViewportChange = () => updateNativePageState()
    frameWin.addEventListener("scroll", onViewportChange, { passive: true })
    frameWin.addEventListener("resize", onViewportChange)

    const observer = new MutationObserver(onViewportChange)
    observer.observe(frameDoc.body, { childList: true, subtree: true })

    const raf = window.requestAnimationFrame(onViewportChange)
    return () => {
      window.cancelAnimationFrame(raf)
      observer.disconnect()
      frameWin.removeEventListener("scroll", onViewportChange)
      frameWin.removeEventListener("resize", onViewportChange)
    }
  }, [mode, updateNativePageState])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Fast path: when the binary source is missing (chat reload, no
      // file URL persisted) but we already have extracted markdown
      // text from server-side parsing, render that instead of failing.
      if (!a.url && !a.file && a.extractedText) {
        setFallbackHtml(extractedTextToHtml(a.extractedText, a.name))
        setMode("extracted")
        return
      }
      try {
        const buf = await readAsArrayBuffer(a)
        // Try docx-preview first (high fidelity). Imported lazily so the
        // ~250 KB module isn't loaded for any non-DOCX preview.
        try {
          const { renderAsync } = await loadDocxPreview()
          const frame = iframeRef.current
          const frameDoc = frame?.contentDocument
          if (cancelled || !frameDoc?.body || !frameDoc?.head) return

          frameDoc.open()
          frameDoc.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        min-height: 100%;
        background: #f4f4f5;
        color: #111827;
      }
      body {
        overflow: auto;
        font-family: Arial, Helvetica, sans-serif;
      }
      #docx-preview-root {
        min-height: 100vh;
      }
      .docx-wrapper,
      .docx-preview-doc-wrapper {
        background: transparent !important;
        padding: 24px 0 !important;
      }
      section.docx,
      section.docx-preview-doc {
        margin: 12px auto !important;
        border-radius: 2px;
        background: white !important;
        color: black !important;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12);
      }
    </style>
  </head>
  <body><div id="docx-preview-root"></div></body>
</html>`)
          frameDoc.close()
          const root = frameDoc.getElementById("docx-preview-root")
          if (cancelled || !root) return

          await renderAsync(cloneArrayBuffer(buf), root, frameDoc.head, {
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
          if (!cancelled) setMode("native")
          if (!cancelled) window.requestAnimationFrame(updateNativePageState)
        } catch (docxErr) {
          // Fallback to mammoth → sanitized HTML.
          // eslint-disable-next-line no-console
          console.warn("[UnifiedDocumentViewer] docx-preview failed, falling back to mammoth:", docxErr)
          const mammothMod = (await loadMammoth()) as any
          const mammoth = mammothMod.default || mammothMod
          const result = await mammoth.convertToHtml(
            { arrayBuffer: cloneArrayBuffer(buf) },
            {
              includeDefaultStyleMap: true,
              convertImage: mammoth.images?.imgElement
                ? mammoth.images.imgElement((image: any) =>
                    image.read("base64").then((data: string) => ({
                      src: `data:${image.contentType};base64,${data}`,
                    })),
                  )
                : undefined,
            },
          )
          if (cancelled) return
          setFallbackHtml(sanitizeDocxHtml(result.value))
          setMode("fallback")
        }
      } catch (e: any) {
        if (cancelled) return
        // Chunk-load errors are not data issues — they happen when the
        // page HTML references a JS chunk hash that no longer exists
        // (after a deploy or a dev-server hot-restart). Surface a
        // recover-by-reload message instead of dumping the webpack
        // error verbatim, and skip the extractedText fallback so the
        // refresh nudge isn't masked by a half-rendered page.
        const message = e?.message || String(e || "Error")
        if (isChunkLoadError(e)) {
          setErr("La aplicación se actualizó. Recarga la página para abrir el documento.")
          setMode("error")
          return
        }
        // Last-resort: if the binary read failed but the message
        // carries extractedText (server-side parse), still show the
        // user something readable instead of "No source available".
        if (a.extractedText) {
          setFallbackHtml(extractedTextToHtml(a.extractedText, a.name))
          setMode("extracted")
          return
        }
        setErr(message)
        setMode("error")
      }
    })()
    return () => { cancelled = true }
  }, [a, updateNativePageState])

  if (mode === "error") {
    const isReloadHint = err?.startsWith("La aplicación se actualizó")
    return (
      <ErrorState
        error={err || "Error"}
        hint={
          isReloadHint
            ? "Cmd+Shift+R (o Ctrl+Shift+R en Windows/Linux) suele bastar."
            : "Intenta descargar el archivo y ábrelo en Word / Pages."
        }
      />
    )
  }

  return (
    <div className="relative h-full overflow-hidden bg-muted dark:bg-zinc-900">
      {mode === "loading" && <LoadingState label="Renderizando documento…" />}

      {/* Native docx-preview output. The library generates its own page
          containers + CSS. It runs inside an iframe so any DOM cleanup
          performed by docx-preview cannot remove the app modal. */}
      <iframe
        ref={iframeRef}
        title={`Vista previa de ${a.name}`}
        sandbox="allow-same-origin"
        className={cn(
          "h-full w-full border-0 bg-muted dark:bg-zinc-900",
          mode !== "native" && "pointer-events-none absolute inset-0 opacity-0",
        )}
      />

      {mode === "native" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
          <div className={cn("pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1", liquidToolbarClass)}>
            <Button
              size="icon"
              variant="ghost"
              className={liquidGhostButtonClass}
              disabled={activePage <= 1}
              onClick={() => goToNativePage(activePage - 1)}
              aria-label="Página anterior"
              title="Página anterior"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <div className="flex h-7 items-center rounded-full border border-border/35 bg-background/48 px-3 text-[11px] font-semibold tabular-nums text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.34)]">
              {activePage} / {pageCount || "…"}
            </div>
            <Button
              size="icon"
              variant="ghost"
              className={liquidGhostButtonClass}
              disabled={!!pageCount && activePage >= pageCount}
              onClick={() => goToNativePage(activePage + 1)}
              aria-label="Página siguiente"
              title="Página siguiente"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>

            <div className="mx-0.5 h-5 w-px bg-border/50" />

            <Button
              size="icon"
              variant="ghost"
              className={liquidGhostButtonClass}
              onClick={() => setScale(s => Math.max(0.65, +(s - 0.1).toFixed(2)))}
              aria-label="Reducir zoom"
              title="Reducir zoom"
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <button
              type="button"
              onClick={() => setScale(1)}
              className="h-7 min-w-[52px] rounded-full border border-border/35 bg-background/48 px-2 text-[11px] font-semibold tabular-nums text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.34)] hover:bg-background/65"
              title="Restablecer zoom"
              aria-label="Restablecer zoom"
            >
              {Math.round(scale * 100)}%
            </button>
            <Button
              size="icon"
              variant="ghost"
              className={liquidGhostButtonClass}
              onClick={() => setScale(s => Math.min(1.6, +(s + 0.1).toFixed(2)))}
              aria-label="Aumentar zoom"
              title="Aumentar zoom"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Mammoth fallback. */}
      {mode === "fallback" && (
        <div
          className={cn(
            "prose prose-sm dark:prose-invert mx-auto max-w-3xl px-8 py-8",
            "[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_th]:border [&_td]:border-border/50 [&_th]:border-border/50",
            "[&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1",
            "[&_img]:max-w-full [&_img]:h-auto",
          )}
          dangerouslySetInnerHTML={{ __html: fallbackHtml }}
        />
      )}

      {/* extractedText fallback — original docx not available locally
          but the server-side parser stored its text. Shown so the user
          can at least read the content of an old chat without re-upload. */}
      {mode === "extracted" && (
        <div className="mx-auto max-w-3xl px-6 py-6">
          <div className="mb-4 rounded-md border border-amber-300/40 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
            Mostrando el texto extraído. El archivo binario original no está disponible (chat antiguo). Para una vista exacta, vuelve a adjuntar el .docx.
          </div>
          <div
            className={cn(
              "prose prose-sm dark:prose-invert max-w-none",
              "[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_th]:border [&_td]:border-border/50 [&_th]:border-border/50",
              "[&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1",
            )}
            dangerouslySetInnerHTML={{ __html: fallbackHtml }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Convert the server-side extractedText (a markdown-ish dump) to safe
 * HTML so the viewer can show it when the binary source is unavailable.
 * Falls back to a `<pre>` block if marked is not available.
 */
function extractedTextToHtml(extractedText: string, name?: string | null): string {
  const stripped = extractedText.replace(
    /^\s*Word document\s*—.*?\n---\n/u,
    ""
  )
  const escaped = stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  const title = name ? `<h1>${escaped ? "" : ""}${name.replace(/[<>&]/g, "")}</h1>` : ""
  // Inline minimal markdown rendering: headings (#, ##), paragraphs.
  const lines = stripped.split(/\r?\n/)
  const out: string[] = [title]
  let para: string[] = []
  const flushPara = () => {
    if (para.length === 0) return
    const text = escapeHtml(para.join(" ")).replace(/\s+/g, " ")
    if (text.trim()) out.push(`<p>${text}</p>`)
    para = []
  }
  for (const line of lines) {
    const m1 = /^#\s+(.+)$/.exec(line)
    const m2 = /^##\s+(.+)$/.exec(line)
    const m3 = /^###\s+(.+)$/.exec(line)
    const bullet = /^\s*[-•*]\s+(.+)$/.exec(line)
    if (m1) { flushPara(); out.push(`<h2>${escapeHtml(m1[1])}</h2>`); continue }
    if (m2) { flushPara(); out.push(`<h3>${escapeHtml(m2[1])}</h3>`); continue }
    if (m3) { flushPara(); out.push(`<h4>${escapeHtml(m3[1])}</h4>`); continue }
    if (bullet) { flushPara(); out.push(`<ul><li>${escapeHtml(bullet[1])}</li></ul>`); continue }
    if (line.trim() === "") { flushPara(); continue }
    para.push(line)
  }
  flushPara()
  return out.join("\n")
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ─── Fallback ────────────────────────────────────────────────────────

function FallbackRenderer({ a }: { a: AttachmentLike }) {
  const url = a.url ? absUrl(a.url) : null
  const hasFile = !!a.file
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileIcon className="h-10 w-10 text-muted-foreground" />
      <div>
        <p className="text-[14px] font-semibold">Previsualización no disponible</p>
        <p className="mx-auto mt-1 max-w-md text-[12px] text-muted-foreground">
          Este formato no puede mostrarse con fidelidad en el navegador. Descárgalo para
          abrirlo con la aplicación nativa.
        </p>
      </div>
      <div className="mt-2 flex gap-2">
        {url && (
          <Button variant="outline" size="sm" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Abrir en pestaña nueva
          </Button>
        )}
        {(url || hasFile) && (
          <Button
            size="sm"
            onClick={async () => {
              if (url) {
                window.open(url, "_blank", "noopener,noreferrer")
                return
              }
              if (a.file) {
                const u = URL.createObjectURL(a.file)
                const link = document.createElement("a")
                link.href = u
                link.download = a.name
                document.body.appendChild(link)
                link.click()
                document.body.removeChild(link)
                setTimeout(() => URL.revokeObjectURL(u), 250)
              }
            }}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Descargar
          </Button>
        )}
      </div>
    </div>
  )
}
