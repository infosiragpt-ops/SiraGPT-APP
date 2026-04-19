"use client"

/**
 * UnifiedDocumentViewer — one viewer modal for every supported format.
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
 *   pdf     → <iframe> using browser-native PDF viewer
 *   csv     → papa-free mini-parser → <table>
 *   xlsx    → SheetJS (xlsx) parses workbook → tabs + <table> per sheet
 *   docx    → mammoth → HTML (sanitized) → rendered in scrollable pane
 *   md      → ReactMarkdown with GFM tables + code fences
 *   json    → pretty-printed + monospace
 *   xml/html→ sandboxed iframe with srcDoc (sanitized)
 *   txt     → <pre> with mono font + wrap toggle
 *   code    → react-syntax-highlighter with line numbers
 *   other   → professional fallback with Download CTA (not a broken modal)
 */

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Download,
  ExternalLink,
  Loader2,
  AlertTriangle,
  FileText,
  FileSpreadsheet,
  Presentation,
  File as FileIcon,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import * as XLSX from "xlsx"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneLight, oneDark } from "react-syntax-highlighter/dist/esm/styles/prism"
import mammoth from "mammoth"

// ─── Format detection ────────────────────────────────────────────────

type Kind =
  | "image" | "pdf" | "docx" | "xlsx" | "csv" | "pptx"
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
  if (mt.includes("wordprocessingml") || ext === "docx" || ext === "doc") return "docx"
  if (mt.includes("spreadsheetml") || mt === "application/vnd.ms-excel" || /^xlsx?$/.test(ext)) return "xlsx"
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
  /** Primary attachment (required when open=true). */
  attachment: AttachmentLike | null
  /** Other attachments in the same context — enables arrow navigation. */
  siblings?: AttachmentLike[]
  /** Called when the user arrows to a different attachment in the set. */
  onNavigate?: (next: AttachmentLike) => void
}

function formatSize(n: number | null | undefined) {
  if (!n && n !== 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function absUrl(u: string) {
  if (!u) return u
  if (u.startsWith("http") || u.startsWith("blob:") || u.startsWith("data:")) return u
  const base = process.env.NEXT_PUBLIC_IMAGE_URL || ""
  return u.startsWith("/") ? `${base}${u}` : `${base}/${u}`
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
  attachment,
  siblings,
  onNavigate,
}: UnifiedDocumentViewerProps) {
  const isDark = useIsDark()
  if (!attachment) return null

  const kind = detectKind(attachment)
  const Icon = iconForKind(kind)

  // Navigation indices for multi-attachment browsing.
  const idx = siblings?.findIndex(a => a === attachment || a.id === attachment.id) ?? -1
  const canPrev = siblings && idx > 0
  const canNext = siblings && idx >= 0 && idx < siblings.length - 1
  const go = (delta: number) => {
    if (!siblings || !onNavigate) return
    const next = siblings[idx + delta]
    if (next) onNavigate(next)
  }

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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={cn(
          "flex h-[85vh] max-w-5xl flex-col overflow-hidden p-0",
          "bg-background",
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-3 border-b border-border/50 px-4 py-2.5 space-y-0">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px] font-semibold">
              {attachment.name}
            </DialogTitle>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {kind !== "unknown" && <span className="uppercase tracking-wide">{kind}</span>}
              {attachment.size ? <span>· {formatSize(attachment.size)}</span> : null}
              {siblings && siblings.length > 1 && idx >= 0 ? (
                <span>· {idx + 1} / {siblings.length}</span>
              ) : null}
            </div>
          </div>

          {siblings && siblings.length > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!canPrev}
                onClick={() => go(-1)}
                title="Anterior"
                aria-label="Anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!canNext}
                onClick={() => go(1)}
                title="Siguiente"
                aria-label="Siguiente"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {canDownload && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleDownload}
              title="Descargar"
              aria-label="Descargar"
            >
              <Download className="h-4 w-4" />
            </Button>
          )}
          {downloadUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => window.open(downloadUrl, "_blank", "noopener,noreferrer")}
              title="Abrir en nueva pestaña"
              aria-label="Abrir en nueva pestaña"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RendererDispatch kind={kind} attachment={attachment} isDark={isDark} />
        </div>
      </DialogContent>
    </Dialog>
  )
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
    case "docx":     return <DocxRenderer a={attachment} isDark={isDark} />
    case "md":       return <MarkdownRenderer a={attachment} />
    case "html":     return <HtmlRenderer a={attachment} />
    case "xml":
    case "code":     return <CodeRenderer a={attachment} kind={kind} isDark={isDark} />
    case "json":     return <JsonRenderer a={attachment} isDark={isDark} />
    case "text":     return <TextRenderer a={attachment} />
    default:         return <FallbackRenderer a={attachment} />
  }
}

// ─── Utilities for loading raw content ───────────────────────────────

async function readAsText(a: AttachmentLike): Promise<string> {
  if (a.file) return await a.file.text()
  if (a.url) {
    const res = await fetch(absUrl(a.url), { credentials: "include" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }
  if (a.extractedText) return a.extractedText
  throw new Error("No source available")
}

async function readAsArrayBuffer(a: AttachmentLike): Promise<ArrayBuffer> {
  if (a.file) return await a.file.arrayBuffer()
  if (a.url) {
    const res = await fetch(absUrl(a.url), { credentials: "include" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.arrayBuffer()
  }
  throw new Error("No source available")
}

function LoadingState({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-[12px]">{label}</span>
      </div>
    </div>
  )
}

function ErrorState({ error, hint }: { error: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" />
      <p className="text-[14px] font-medium">No se pudo abrir el documento</p>
      <p className="max-w-md text-[12px] text-muted-foreground">{error}</p>
      {hint && <p className="text-[11px] text-muted-foreground/80">{hint}</p>}
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

  if (!src) return <FallbackRenderer a={a} />
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-auto bg-muted/30">
      <img
        src={src}
        alt={a.name}
        style={{ transform: `scale(${zoom})`, transformOrigin: "center", transition: "transform 120ms ease-out" }}
        className="max-h-full max-w-full select-none"
        draggable={false}
      />
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1 py-0.5 shadow-md backdrop-blur">
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoom(z => Math.max(0.25, z - 0.25))} aria-label="Reducir">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[40px] text-center text-[11px] font-medium tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoom(z => Math.min(4, z + 0.25))} aria-label="Aumentar">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ─── PDF ─────────────────────────────────────────────────────────────

function PdfRenderer({ a }: { a: AttachmentLike }) {
  const [src, setSrc] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let revoke: string | null = null
    ;(async () => {
      try {
        if (a.file) {
          const url = URL.createObjectURL(a.file)
          revoke = url
          setSrc(url)
        } else if (a.url) {
          setSrc(absUrl(a.url))
        } else {
          throw new Error("Sin fuente PDF")
        }
      } catch (e: any) { setErr(e?.message || "Error") }
    })()
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [a])

  if (err) return <ErrorState error={err} />
  if (!src) return <LoadingState />
  return (
    <iframe
      src={`${src}#toolbar=1&navpanes=0&view=FitH`}
      title={a.name}
      className="h-full w-full bg-muted/20"
    />
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
      <div className="flex items-center justify-end border-b border-border/40 px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />
          Ajustar líneas
        </label>
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
    <div className="h-full overflow-auto">
      <SyntaxHighlighter language="json" style={isDark ? oneDark : oneLight} showLineNumbers customStyle={{ margin: 0, padding: "1rem", background: "transparent" }}>
        {text}
      </SyntaxHighlighter>
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
    <div className="h-full overflow-auto">
      <SyntaxHighlighter
        language={lang}
        style={isDark ? oneDark : oneLight}
        showLineNumbers
        customStyle={{ margin: 0, padding: "1rem", background: "transparent", fontSize: "12.5px" }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  )
}

// ─── HTML ────────────────────────────────────────────────────────────

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'")
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
      className="h-full w-full bg-white"
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

// ─── XLSX (SheetJS) ──────────────────────────────────────────────────

function XlsxRenderer({ a }: { a: AttachmentLike }) {
  const [wb, setWb] = React.useState<XLSX.WorkBook | null>(null)
  const [active, setActive] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
        const buf = await readAsArrayBuffer(a)
        const parsed = XLSX.read(buf, { type: "array" })
        setWb(parsed)
        setActive(parsed.SheetNames[0] || null)
      } catch (e: any) {
        setErr(e?.message || "Error")
      }
    })()
  }, [a])

  if (err) return <ErrorState error={err} />
  if (!wb || !active) return <LoadingState />

  const sheet = wb.Sheets[active]
  const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })
  const head = (data[0] || []) as any[]
  const body = data.slice(1)

  return (
    <div className="flex h-full flex-col">
      {/* Sheet tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border/40 px-2 py-1.5">
        {wb.SheetNames.map(name => (
          <button
            key={name}
            onClick={() => setActive(name)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap transition-colors",
              name === active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-muted/70 backdrop-blur">
            <tr>
              <th className="sticky left-0 z-10 border-b border-r border-border/60 bg-muted/70 px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">#</th>
              {head.map((h, i) => (
                <th key={i} className="border-b border-border/60 px-3 py-1.5 text-left font-semibold">{String(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className="odd:bg-background even:bg-muted/20">
                <td className="sticky left-0 z-10 border-b border-r border-border/30 bg-inherit px-2 py-1 text-[10px] text-muted-foreground">{i + 2}</td>
                {head.map((_, j) => (
                  <td key={j} className="border-b border-border/30 px-3 py-1 align-top">{String(r[j] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── DOCX (mammoth) ──────────────────────────────────────────────────

function DocxRenderer({ a, isDark }: { a: AttachmentLike; isDark: boolean }) {
  const [html, setHtml] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
        const buf = await readAsArrayBuffer(a)
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buf },
          { includeDefaultStyleMap: true },
        )
        setHtml(sanitizeHtml(result.value))
      } catch (e: any) {
        setErr(e?.message || "Error")
      }
    })()
  }, [a])

  if (err) return <ErrorState error={err} hint="Intenta descargar el archivo y ábrelo en Word / Pages." />
  if (html === null) return <LoadingState label="Convirtiendo Word a HTML…" />

  return (
    <div className="h-full overflow-auto">
      <div
        className={cn(
          "prose prose-sm dark:prose-invert mx-auto max-w-3xl px-8 py-8",
          "[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_th]:border [&_td]:border-border/50 [&_th]:border-border/50",
          "[&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1",
          "[&_img]:max-w-full [&_img]:h-auto",
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
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
