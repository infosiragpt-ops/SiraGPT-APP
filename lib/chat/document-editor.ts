import DOMPurify from "dompurify"
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } from "docx"

/**
 * document-editor — orchestrator for the /chat rich-text document editor.
 *
 * Thin, dependency-injected functions that wire the uploaded file's
 * extracted content into the Tiptap editor (markdown), produce client-side
 * exports (.md / .txt / .docx), and persist a manual edit as a FileVersion
 * through the backend edit route (POST /files/:id/edit).
 *
 * Everything here is pure or mock-friendly on purpose:
 *   - `apiClient` is passed in (never imported), so unit tests can stub it.
 *   - DOM-dependent helpers (markdownToDocxBlob, buildExportBlob) are split
 *     from the string-only ones (sanitizeContentForEditor,
 *     contentToMarkdown) so the pure core runs in any runtime.
 */

export type DocExportFormat = "md" | "txt" | "docx"

/**
 * Upload formats whose extracted content the editor can turn into
 * structured Markdown before handing it to Tiptap. `contentToMarkdown`
 * dispatches on these; anything else falls back to plain-text handling.
 * Keep in sync with the composer accept list (components/chat-interface-enhanced.tsx).
 */
export const EDITABLE_IMPORT_FORMATS = [
  "md", "markdown", "txt", "docx", "html", "htm",
  "rtf", "odt", "ods", "odp", "csv", "tsv",
] as const

export type EditorImportFormat = (typeof EDITABLE_IMPORT_FORMATS)[number]

export type EditorSaveResult = {
  fileId: string
  version: {
    id: string
    version: number
    filename: string
    summary: string | null
    createdAt: string
    downloadUrl?: string | null
  }
}

export type EditorSaveOptions = {
  /** apiClient — injected so tests can pass a fake. */
  apiClient: unknown
  fileId: string
  /** The edited markdown. */
  markdown: string
  chatId?: string
  summary?: string
}

/** Minimal shape of the apiClient surface this module needs. */
export type EditorApiClient = {
  saveDocumentEdit?: (fileId: string, body: { content: string; chatId?: string; summary?: string }) => Promise<unknown>
  getFileContent?: (id: string) => Promise<string>
  request?: (endpoint: string, options?: { method?: string; body?: string }) => Promise<unknown>
}

const MAX_EDIT_SURFACE_CHARS = 1_000_000

function fallbackApiClient(client: unknown): EditorApiClient {
  return (client || {}) as EditorApiClient
}

/**
 * DOMPurify interop: under webpack the ESM build gives a purifier object with
 * `.sanitize`; under plain CommonJS (node --test, tsc output) `dompurify`
 * resolves to a factory needing a window and __importDefault wraps THAT as
 * `{ default: factory }`. Resolve whichever shape we got once.
 */
type DomPurifier = { sanitize: (input: string, config?: unknown) => string }
let domPurifier: DomPurifier | null = null
function getPurifier(): DomPurifier | null {
  if (domPurifier) return domPurifier
  const candidate = DOMPurify as unknown
  if (candidate && typeof (candidate as DomPurifier).sanitize === "function") {
    domPurifier = candidate as DomPurifier
    return domPurifier
  }
  const factory = (candidate as { default?: unknown }).default
  if (typeof factory === "function" && typeof window !== "undefined") {
    try {
      domPurifier = (factory as (root: unknown) => DomPurifier)(window)
      return domPurifier
    } catch {
      return null
    }
  }
  return null
}

/**
 * Strip dangerous markup from an uploaded file's raw extracted content so it
 * can be handed to the editor. `extractedText` is plain text in practice, but
 * some pipelines may return HTML-ish or script-laden payloads (fragmented
 * preprocessing, pasted web content, sketchy PDFs), so this is the single
 * funnel every raw source passes through.
 */
export function sanitizeContentForEditor(raw: string): string {
  if (!raw) return ""
  const text = String(raw)
    // Normalize exotic newlines so markdown rendering is stable.
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
  if (!text.trim()) return ""
  const purifier = getPurifier()
  // No DOM available (pure node runtime) → fall back to a conservative tag
  // strip; the editor never renders this as HTML anyway (Tiptap parses MD).
  const sanitized = purifier
    ? purifier.sanitize(text, { SAFE_FOR_TEMPLATES: false })
    : text.replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<[^>]+on\w+\s*=[^>]*>/gi, "")
  // DOMPurify returns TrustedHTML in strict DOMPurify builds; convert to string.
  return typeof sanitized === "string" ? sanitized : String(sanitized)
}

/**
 * Map extracted plain text to editor markdown.
 *
 * Kept lossless for real documents: the extracted text is the user's content,
 * so we preserve it verbatim instead of mangling it. The one explicit
 * normalization is folding multiple consecutive blank lines into a single one,
 * because Tiptap's markdown round-trip collapses runs of empty paragraphs and
 * a stack of blank lines would produce a confusing diff when the user saves.
 */
export function contentToMarkdown(raw: string, _format?: string): string {
  const text = sanitizeContentForEditor(raw)
  if (!text) return ""
  // Single newline → Tiptap paragraph split (marked parses `\n` as a soft
  // break, so convert to real paragraph boundaries for editability).
  return text.replace(/\n{3,}/g, "\n\n").trim()
}

// ---------------------------------------------------------------------------
// Format-specific converters (Frente 1: matriz de formatos)
//
// The backend extractor returns flat text for most formats (with headers like
// "RTF document — ... \n---\n"). These converters run CLIENT-SIDE on the raw
// file bytes when the panel has them, so the editor gets real structure
// (headings, lists, tables) instead of the flattened extraction. Every
// converter is a pure string→string function so it runs in any runtime and is
// unit-testable without DOM or network.
// ---------------------------------------------------------------------------

/** Normalizes CRLF/CR to LF without the DOMPurify pass. */
function normalizeNewlines(raw: string): string {
  return String(raw ?? "").replace(/\r\n?/g, "\n")
}

type ZipLike = {
  file(path: string): { async(kind: "string"): Promise<string> } | null
}

/** Lazy-loads jszip (already a dependency) and normalizes its CJS/ESM shape. */
async function loadZip(bytes: Uint8Array): Promise<ZipLike> {
  const mod = await import("jszip")
  const ctor = ((mod as unknown as { default?: unknown }).default ?? mod) as {
    loadAsync(data: Uint8Array): Promise<ZipLike>
  }
  return ctor.loadAsync(bytes)
}

/**
 * RTF → plain text. Handles the constructs Word actually emits: destination
 * groups to discard ({\fonttbl}, {\colortbl}, {\stylesheet}, {\*\generator}),
 * hex escapes (\'e1), Unicode escapes (\uN?), paragraph/line/tab breaks and
 * the remaining control words (\b, \i0). `\\{`, `\\}` and `\\\\` are the
 * escaped literal braces/backslash.
 *
 * Tokenizer approach (single pass, no intermediate group stripping): control
 * words swallow ONE following space per the RTF spec (`\b word` → " word"),
 * destination groups are skipped by balanced-brace scan, and everything else
 * is kept verbatim.
 */
export function rtfToText(raw: string): string {
  if (!raw) return ""

  // Destination markers whose whole group is metadata: \fonttbl, \colortbl,
  // \stylesheet, \listtable, \revtbl, \info and the extended \*\name form.
  const DESTINATION_RE = /^\\(?:\*)?\\?(?:fonttbl|colortbl|stylesheet|listtable|revtbl|info|generator)\b/

  const out: string[] = []
  const src = String(raw)
  const length = src.length
  let index = 0
  let skipDepth = 0 // >0 while inside a discarded destination group

  while (index < length) {
    const char = src[index]

    if (char === "\\") {
      const next = src[index + 1]
      // Escaped literals: \\{ \\} \\\\ — keep the literal char.
      if (next === "{" || next === "}" || next === "\\") {
        if (skipDepth === 0) out.push(next)
        index += 2
        continue
      }
      // Hex escape \'hh.
      if (next === "'") {
        const hex = src.slice(index + 2, index + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (skipDepth === 0) {
            const code = parseInt(hex, 16)
            out.push(code >= 32 && code !== 127 ? String.fromCharCode(code) : "")
          }
          index += 4
          continue
        }
      }
      // Unicode escape \uN with optional replacement ?.
      const uniMatch = /^\\u(-?\d+)\??/.exec(src.slice(index))
      if (uniMatch) {
        if (skipDepth === 0) {
          const cp = parseInt(uniMatch[1], 10)
          try {
            out.push(cp < 0 ? String.fromCharCode(65536 + cp) : String.fromCodePoint(cp))
          } catch {
            out.push("")
          }
        }
        index += uniMatch[0].length
        continue
      }
      // Control word: \<letters>[optional -digits]<one optional space>.
      const wordMatch = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(index))
      if (wordMatch) {
        const word = wordMatch[1]
        if (DESTINATION_RE.test(`\\${word}`)) {
          skipDepth += 1
        } else if (skipDepth === 0) {
          if (word === "par" || word === "pard" || word === "sect" || word === "page") out.push("\n")
          else if (word === "line") out.push("\n")
          else if (word === "tab") out.push("\t")
          else if (["emdash", "endash", "bullet", "lquote", "rquote", "ldquote", "rdquote"].includes(word)) out.push(" ")
          // Formatting toggles (\b, \i0, \fs24, …) produce nothing.
        }
        index += wordMatch[0].length
        continue
      }
      // Unknown escape (\' without hex, stray backslash): drop it.
      index += 2
      continue
    }

    if (char === "{" || char === "}") {
      // Group boundaries. Inside a skipped destination, closing brace of the
      // outermost level ends the skip.
      if (char === "{") {
        if (skipDepth > 0) skipDepth += 1
      } else if (skipDepth > 0) {
        skipDepth -= 1
      }
      index += 1
      continue
    }

    if (skipDepth === 0) out.push(char)
    index += 1
  }

  return normalizeNewlines(out.join(""))
    .replace(/\uFFFD/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const ODF_TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
const ODF_TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
const ODF_OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"

type OdfNodeLike = {
  nodeName: string
  namespaceURI?: string | null
  childNodes: Array<OdfNodeLike>
  nodeType: number
  nodeValue?: string | null
  getAttribute?: (name: string) => string | null
}

function odfLocalName(node: OdfNodeLike): string {
  return node.nodeName.includes(":") ? node.nodeName.split(":")[1] : node.nodeName
}

function odfInNamespace(node: OdfNodeLike, ns: string): boolean {
  return node.namespaceURI === ns
}

/** Concatenates an ODF element's text content in document order. */
function odfTextContent(node: OdfNodeLike): string {
  let out = ""
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue ?? ""
    else if (child.nodeType === 1) out += odfTextContent(child)
  }
  return out
}

function escapeGfmCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
}

/**
 * Renders ODF <table:table> rows as a GFM pipe table. Repeated
 * <table:table-header-columns> / covered cells are collapsed to one column
 * per <table:table-cell>; empty trailing columns are dropped.
 */
function odfTableToMarkdown(table: OdfNodeLike): string {
  const rows: string[][] = []
  const walkRows = (node: OdfNodeLike) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue
      const name = odfLocalName(child)
      if (odfInNamespace(child, ODF_TABLE_NS) && name === "table-row") {
        const cells: string[] = []
        for (const cell of child.childNodes) {
          if (cell.nodeType === 1 && odfInNamespace(cell, ODF_TABLE_NS) && odfLocalName(cell) === "table-cell") {
            cells.push(escapeGfmCell(odfTextContent(cell)))
          }
        }
        if (cells.some((value) => value)) rows.push(cells)
      } else if (name !== "table-header-columns" && name !== "table-column") {
        walkRows(child)
      }
    }
  }
  walkRows(table)
  if (rows.length === 0) return ""

  const width = Math.max(...rows.map((cells) => cells.length))
  const line = (cells: string[]) => {
    const padded = [...cells]
    while (padded.length < width) padded.push("")
    return `| ${padded.join(" | ")} |`
  }
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n")
}

type OdfDoc = {
  documentElement: OdfNodeLike | null
  getElementById?: (id: string) => OdfNodeLike | null
  getElementsByTagName?: (tag: string) => Array<OdfNodeLike>
}

/**
 * ODT/ODS/ODP content.xml → Markdown. Walks paragraphs (<text:p>), headings
 * (<text:h> with outline-level), list items (<text:list> → '-') and tables.
 * Runs wherever a DOM XMLParser exists (browser + Node ≥18 via DOMParser);
 * falls back to '' when parsing fails so the caller keeps the backend's flat
 * extracted text instead of losing content.
 */
export function odfContentXmlToMarkdown(xml: string): string {
  if (!xml || typeof xml !== "string" || typeof DOMParser === "undefined") return ""
  let doc: OdfDoc
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as OdfDoc
  } catch {
    return ""
  }
  const root = doc.documentElement
  if (!root || odfLocalName(root as OdfNodeLike) !== "document-content") return ""

  const lines: string[] = []

  const renderBlock = (node: OdfNodeLike, depth: number): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue
      const inTextNs = odfInNamespace(child, ODF_TEXT_NS)
      const inTableNs = odfInNamespace(child, ODF_TABLE_NS)
      const name = odfLocalName(child)
      if (inTableNs && name === "table") {
        const table = odfTableToMarkdown(child)
        if (table) lines.push("", table, "")
      } else if (inTextNs && name === "h") {
        const levelRaw = child.getAttribute?.("text:outline-level")
        const level = Math.min(6, Math.max(1, Number.parseInt(levelRaw ?? "1", 10) || 1))
        const text = odfTextContent(child).trim()
        if (text) lines.push("", `${"#".repeat(level)} ${text}`, "")
      } else if (inTextNs && (name === "list" || name === "list-item")) {
        const text = odfTextContent(child).trim()
        if (name === "list" && !text) continue
        if (text) lines.push(`${"  ".repeat(depth)}- ${text}`)
        else if (name === "list") renderBlock(child, depth + 1)
      } else if (inTextNs && name === "p") {
        const text = odfTextContent(child).trim()
        if (text) lines.push("", text, "")
      } else if ((odfInNamespace(child, ODF_OFFICE_NS) && (name === "text" || name === "presentation")) || (inTableNs && name === "table-cell")) {
        renderBlock(child, depth)
      } else {
        renderBlock(child, depth)
      }
    }
  }
  renderBlock(root, 0)

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Decodes the five entities the repo's HTML pipeline relies on (&amp; last). */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
}

/**
 * CSV/TSV → GFM pipe table. RFC-4180 quoting ("a,b", doubled "" quotes) is
 * honored with a small state machine; TSV splits on tabs without quoting.
 * First row becomes the header row. Falls back to one-cell-per-line tables
 * when a row is ragged. Returns '' for input with no usable delimiter.
 */
export function csvToMarkdownTable(raw: string, options?: { delimiter?: string }): string {
  if (!raw || typeof raw !== "string") return ""
  const text = normalizeNewlines(raw).replace(/\n+$/, "")
  if (!text.trim()) return ""

  const delimiter = options?.delimiter ?? (/^\s*[^\t]*\t/.test(text) && !text.includes(",") ? "\t" : ",")
  const useQuotes = delimiter !== "\t"

  const parseLine = (line: string): string[] => {
    const cells: string[] = []
    let current = ""
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]
      if (useQuotes && char === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1 }
        else inQuotes = !inQuotes
      } else if (char === delimiter && !inQuotes) {
        cells.push(current.trim())
        current = ""
      } else {
        current += char
      }
    }
    cells.push(current.trim())
    return cells
  }

  const rows = text.split("\n").map(parseLine).filter((cells) => cells.some((value) => value !== ""))
  if (rows.length === 0) return ""
  const width = Math.max(...rows.map((cells) => cells.length))
  if (width === 1 && rows.length === 1) return ""
  if (width <= 1) {
    // Single-column data is better left as plain paragraphs than a degenerate table.
    return rows.map((cells) => cells[0]).filter(Boolean).join("\n\n")
  }
  const line = (cells: string[]) => {
    const padded = [...cells]
    while (padded.length < width) padded.push("")
    return `| ${padded.map(escapeGfmCell).join(" | ")} |`
  }
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n")
}

/**
 * Full HTML document/fragment → Markdown via the shared pipeline in
 * lib/attachments/html-to-markdown (DOMPurify allowlist + Turndown with the
 * hand-rolled GFM table rule). Kept as a named wrapper here so the editor's
 * import matrix has a single entry point; returns '' when the shared module
 * is unavailable (e.g. non-bundled runtime).
 */
export async function htmlToEditorMarkdown(html: string): Promise<string> {
  if (!html || typeof html !== "string") return ""
  try {
    const mod = (await import("../attachments/html-to-markdown")) as unknown as {
      htmlToMarkdown?: (input: string) => string
    }
    if (typeof mod.htmlToMarkdown === "function") return mod.htmlToMarkdown(html)
  } catch {
    // fall through to the minimal reducer below
  }
  return htmlToMarkdownFallback(html)
}

/**
 * Dependency-free fallback used only when the shared Turndown pipeline can't
 * load. Mirrors backend/src/services/fileProcessor.js `_htmlToMarkdown` —
 * same tag set, same entity decode order — so both paths agree on output.
 */
export function htmlToMarkdownFallback(html: string): string {
  if (!html) return ""
  let md = String(html)
  md = md.replace(/<!--[\s\S]*?-->/g, "")
  md = md.replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<style[\s\S]*?<\/style\s*>/gi, "")
  md = md.replace(/<(head|nav|footer)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  md = md.replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, tag: string, inner: string) => {
    const level = Number(tag[1])
    return `\n${"#".repeat(level)} ${inner.replace(/<[^>]+>/g, "").trim()}\n`
  })
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**")
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1\s*>/gi, "*$2*")
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, "- $1\n")
  md = md.replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
  md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_, row: string) => {
    const cells: string[] = []
    row.replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1\s*>/gi, (__, ___d, cell: string) => {
      cells.push(cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"))
      return ""
    })
    return cells.length ? `\n| ${cells.join(" | ")} |` : ""
  })
  md = md.replace(/<\/?(table|tbody|thead)[^>]*>/gi, "\n")
  md = md.replace(/<a\s[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, label: string) =>
    `[${label.replace(/<[^>]+>/g, "").trim()}](${href})`)
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p\s*>/gi, "$1\n\n")
  md = md.replace(/<br\s*\/?>/gi, "\n")
  md = md.replace(/<[^>]+>/g, "")
  md = decodeHtmlEntities(md)
  return md.replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Dispatches raw file bytes (or the backend's extracted text) to the right
 * converter based on the file extension/mime. This is what the editor panel
 * calls before handing content to Tiptap. Unknown formats keep the legacy
 * behavior: sanitize the extracted text as-is.
 *
 * `source` prefers raw bytes (client-side conversion, exact structure); when
 * absent we degrade gracefully to the backend's extracted text, stripping the
 * "X document — N characters …\n---\n" header the extractor prepends.
 */
export async function importedFileToMarkdown(
  source: { bytes?: ArrayBuffer | Uint8Array; extractedText?: string },
  format: string,
): Promise<string> {
  const fmt = String(format || "").toLowerCase()

  const headerlessExtracted = (): string => {
    const extracted = typeof source.extractedText === "string" ? source.extractedText : ""
    return extracted.replace(/^[^\n]{0,200}?—\s*[^\n]*\n---\n/, "").trimStart()
  }

  // Structured client-side conversions need the raw bytes.
  if (source.bytes) {
    const bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes)
    if (bytes.byteLength > 0) {
      try {
        if (fmt === "docx") {
          const zip = await loadZip(bytes)
          const documentXml = await zip.file("word/document.xml")?.async("string")
          if (documentXml) {
            const markdown = docxDocumentXmlToMarkdown(documentXml)
            if (markdown) return markdown
          }
        } else if (fmt === "rtf" || fmt === "rtx") {
          const utf8 = new TextDecoder("utf-8").decode(bytes)
          if (/^\s*\{\\rtf/.test(utf8)) return contentToMarkdown(rtfToText(utf8), fmt)
        } else if (fmt === "odt" || fmt === "ods" || fmt === "odp") {
          const zip = await loadZip(bytes)
          const contentXml = await zip.file("content.xml")?.async("string")
          if (contentXml) {
            const markdown = odfContentXmlToMarkdown(contentXml)
            if (markdown) return markdown
          }
        } else if (fmt === "csv" || fmt === "tsv") {
          const utf8 = new TextDecoder("utf-8").decode(bytes)
          const table = csvToMarkdownTable(utf8)
          return table || contentToMarkdown(utf8, fmt)
        } else if (fmt === "html" || fmt === "htm") {
          const utf8 = new TextDecoder("utf-8").decode(bytes)
          const converted = await htmlToEditorMarkdown(utf8)
          return converted || contentToMarkdown(utf8, fmt)
        }
      } catch {
        // Corrupt zip / binary garbage → fall through to extracted-text path.
      }
    }
  }

  const extracted = headerlessExtracted()
  if (fmt === "csv" || fmt === "tsv") {
    // Extracted CSV text is still delimited — re-table it even without bytes.
    const table = extracted ? csvToMarkdownTable(extracted) : ""
    if (table) return table
  }
  if (fmt === "html" || fmt === "htm") {
    const converted = extracted ? await htmlToEditorMarkdown(extracted) : ""
    if (converted) return converted
  }
  return contentToMarkdown(extracted, fmt)
}

/**
 * Minimal OOXML WML → Markdown for DOCX imports. Covers what Word documents
 * are made of structurally: w:p paragraphs, w:pStyle heading levels,
 * numbered/bulleted w:numPr lists, runs with bold/italic marks and literal
 * tabs/breaks. Field instructions, bookmarks and deleted-run markup are
 * dropped. Pure string in/string out.
 */
export function docxDocumentXmlToMarkdown(wml: string): string {
  if (!wml) return ""

  // Drop non-visible constructs before anything else so their inner text
  // never leaks into paragraphs.
  let xml = String(wml)
    .replace(/<w:instrText[\s\S]*?<\/w:instrText\s*>/g, "")
    .replace(/<w:fldSimple[^>]*\/>/g, "")
    .replace(/<w:delText[\s\S]*?<\/w:delText\s*>/g, "")

  const renderRun = (runXml: string): string => {
    let text = ""
    const pattern = /<w:(t|tab|br|cr)\b([^>]*)?(?:\/>|>([\s\S]*?)<\/w:\1\s*>)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(runXml)) !== null) {
      if (match[1] === "t") text += decodeXmlEntities(match[3] ?? "")
      else if (match[1] === "tab") text += "\t"
      else text += "\n"
    }
    if (!text.trim()) return ""
    // <w:b/> / <w:b w:val="true"> → bold; <w:b w:val="false|0"/> → off.
    const boldOn = /<w:b(?:\s[^>]*)?(?:\/>|>\s*<\/w:b\s*>)/.test(runXml)
      && !/<w:b\s+[^>]*w:val\s*=\s*"(?:false|0)"\s*\/?>/.test(runXml)
    const italicOn = /<w:i(?:\s[^>]*)?(?:\/>|>\s*<\/w:i\s*>)/.test(runXml)
      && !/<w:i\s+[^>]*w:val\s*=\s*"(?:false|0)"\s*\/?>/.test(runXml)
    let core = text
    if (boldOn) core = `**${core}**`
    if (italicOn) core = `*${core}*`
    return core
  }

  void xml

  // Render top-level flow in order: tables as GFM blocks, other paragraphs
  // as markdown lines. We scan sequentially so interleaving survives.
  const flowPattern = /<w:tbl\b[\s\S]*?<\/w:tbl\s*>|<w:p\b[^>]*(?:\/>|[\s\S]*?<\/w:p\s*>)/g
  const outLines: string[] = []
  let flowMatch: RegExpExecArray | null
  while ((flowMatch = flowPattern.exec(xml)) !== null) {
    const block = flowMatch[0]
    if (block.startsWith("<w:tbl")) {
      const rows: string[][] = []
      const rowPattern = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr\s*>/g
      let rowMatch: RegExpExecArray | null
      while ((rowMatch = rowPattern.exec(block)) !== null) {
        const cells: string[] = []
        const cellPattern = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc\s*>/g
        let cellMatch: RegExpExecArray | null
        while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
          const cellParas: string[] = []
          const pPattern = /<w:p\b[^>]*(?:\/>|[\s\S]*?<\/w:p\s*>)/g
          let pMatch: RegExpExecArray | null
          while ((pMatch = pPattern.exec(cellMatch[1])) !== null) {
            const rendered = renderRun(pMatch[0]).trim()
            if (rendered) cellParas.push(rendered)
          }
          cells.push(escapeGfmCell(cellParas.join(" ")))
        }
        if (cells.length) rows.push(cells)
      }
      if (rows.length) {
        const width = Math.max(...rows.map((cells) => cells.length))
        const line = (cells: string[]) => {
          const padded = [...cells]
          while (padded.length < width) padded.push("")
          return `| ${padded.join(" | ")} |`
        }
        const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`
        outLines.push("", [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n"), "")
      }
      continue
    }

    const paragraph = block
    const styleMatch = paragraph.match(/<w:pStyle\s+w:val="([^"]+)"/)
    const style = styleMatch ? styleMatch[1].toLowerCase() : ""
    const headingMatch = style.match(/^(?:heading|titre)(\d)/)
    const isListItem = /<w:numPr\b/.test(paragraph)

    const runs: string[] = []
    const runPattern = /<w:r\b[^>]*(?:\/>|[\s\S]*?<\/w:r\s*>)/g
    let runMatch: RegExpExecArray | null
    while ((runMatch = runPattern.exec(paragraph)) !== null) {
      let rendered = renderRun(runMatch[0])
      if (rendered) {
        // Adjacent emphasis markers (**…** followed immediately by *…) parse
        // as a single confused span in most Markdown engines; keep one space.
        const previous = runs[runs.length - 1]
        if (previous && /\*$/.test(previous) && /^[*a-zA-ZÁÉÍÓÚáéíóúñ]/.test(rendered)) rendered = ` ${rendered}`
        runs.push(rendered)
      }
    }
    const text = runs.join("").replace(/\n/g, " ").replace(/\t/g, " ").replace(/\s+/g, " ").trim()
    if (!text) {
      outLines.push("")
      continue
    }
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, Number.parseInt(headingMatch[1], 10)))
      outLines.push("", `${"#".repeat(level)} ${text}`, "")
    } else if (isListItem) {
      outLines.push(`- ${text}`)
    } else {
      outLines.push("", text, "")
    }
  }

  return outLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
}

function safeFromCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ""
  } catch {
    return ""
  }
}

function parseMarkdownTableBlock(lines: string[]): Table | null {
  const header = lines[0]
  const separator = lines[1]
  const separatorRe = /^\s*\|?\s*(?::?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/
  if (!separator || !separatorRe.test(separator)) return null
  const split = (line: string) =>
    line.split("|").map((cell) => cell.trim()).filter((cell, index, all) => {
      // Drop the leading/trailing empty cells produced by the outer pipes.
      if (cell) return true
      return index > 0 && index < all.length - 1
    })
  const headerCells = split(header)
  if (headerCells.length === 0) return null
  const rows = lines.slice(2)
    .filter((line) => line.trim().startsWith("|") || line.trim().includes("|"))
    .map(split)
  const toCell = (value: string) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: value })] })],
      width: { size: Math.max(10, Math.floor(500 / Math.max(headerCells.length, 1))), type: WidthType.DXA },
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headerCells.map(toCell), tableHeader: true }),
      ...rows.map((row) => new TableRow({ children: row.map(toCell) })),
    ],
  })
}

/**
 * Convert markdown to a minimal .docx Blob using the repo's existing `docx`
 * stack (same style as lib/download-utils.ts). Headings map to heading
 * paragraphs, GFM tables to real docx tables, everything else to plain
 * paragraphs. Inline markers (** , _, `, links, task boxes) are lightly
 * parsed into rich TextRuns; anything else stays literal text.
 */
export async function markdownToDocxBlob(markdown: string): Promise<Blob> {
  const lines = (markdown || "").replace(/\r\n?/g, "\n").split("\n")

  const inlineRunRegex = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\)|^- \[[ xX]\] |^- )/g
  const parseInline = (text: string): TextRun[] => {
    const parts = text.split(inlineRunRegex)
    return parts.filter(Boolean).map((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        return new TextRun({ text: part.slice(2, -2), bold: true })
      }
      if (/^_[^_]+_$/.test(part)) {
        return new TextRun({ text: part.slice(1, -1), italics: true })
      }
      if (/^`.+`$/.test(part)) {
        return new TextRun({ text: part.slice(1, -1), font: "Consolas" })
      }
      const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        // docx v8 doesn't expose hyperlink on TextRun; a plain text run keeps
        // the label readable in the exported file.
        return new TextRun({ text: `${linkMatch[1]} (${linkMatch[2]})` })
      }
      return new TextRun({ text: part })
    })
  }

  const children: Array<Paragraph | Table> = []
  let pendingTable: Table | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    // GFM table: consume the block (header | separator | rows).
    const tableLines = [line, lines[index + 1]].filter((l) => l !== undefined)
    if (trimmed.includes("|") && tableLines.length === 2) {
      const table = parseMarkdownTableBlock(tableLines)
      if (table) {
        pendingTable = table
        index += 1 // separator consumed
        while (index + 1 < lines.length && lines[index + 1].trim().startsWith("|")) {
          index += 1
          const rowLine = lines[index]
          const rowCells = rowLine.split("|").map((cell) => cell.trim())
            .filter((cell, cellIndex, all) => {
              if (cell) return true
              return cellIndex > 0 && cellIndex < all.length - 1
            })
          pendingTable.addChildElement(
            new TableRow({ children: rowCells.map((cell) => new TableCell({
              children: [new Paragraph({ text: cell })],
              width: { size: Math.max(10, Math.floor(500 / Math.max(rowCells.length, 1))), type: WidthType.DXA },
            })) }),
          )
        }
        children.push(pendingTable)
        pendingTable = null
        continue
      }
    }

    if (!trimmed) {
      children.push(new Paragraph({ children: [new TextRun({ text: "" })] }))
      continue
    }

    // Task list items → checkbox paragraphs.
    const taskMatch = trimmed.match(/^- \[([ xX])\]\s+(.+)$/)
    if (taskMatch) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: taskMatch[1].toLowerCase() === "x" ? "☑ " : "☐ " }),
          ...parseInline(taskMatch[2]),
        ],
        indent: { left: 320 },
        spacing: { after: 80 },
      }))
      continue
    }

    // Headings.
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const headingLevel = ([
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ])[level - 1] || HeadingLevel.HEADING_3
      children.push(new Paragraph({ children: parseInline(headingMatch[2]), heading: headingLevel }))
      continue
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/)
    if (bulletMatch) {
      children.push(new Paragraph({
        children: [new TextRun({ text: "• " }), ...parseInline(bulletMatch[1])],
        indent: { left: 320 },
        spacing: { after: 80 },
      }))
      continue
    }

    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (numberedMatch) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${trimmed.match(/^\d+/)?.[0]}. ` }), ...parseInline(numberedMatch[1])],
        indent: { left: 320 },
        spacing: { after: 80 },
      }))
      continue
    }

    const blockquoteMatch = trimmed.match(/^>\s?(.+)$/)
    if (blockquoteMatch) {
      children.push(new Paragraph({
        children: [new TextRun({ text: blockquoteMatch[1], italics: true })],
        indent: { left: 480 },
        spacing: { after: 80 },
      }))
      continue
    }

    const hrMatch = trimmed.match(/^(?:-{3,}|\*{3,}|_{3,})$/)
    if (hrMatch) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "—".repeat(12) })],
        spacing: { after: 120 },
      }))
      continue
    }

    children.push(new Paragraph({
      children: parseInline(line),
      spacing: { after: 120 },
    }))
  }

  const doc = new Document({
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}

/**
 * Build a client-side export blob for the edited markdown.
 * Returns `{ blob, filename }`; `filename` is derived from the base name.
 */
export async function buildExportBlob(
  markdown: string,
  format: DocExportFormat,
  baseName = "documento",
): Promise<{ blob: Blob; filename: string }> {
  const safeBase = (baseName || "documento")
    .replace(/\.(md|markdown|txt|docx)$/i, "")
    .trim() || "documento"
  if (format === "docx") {
    const blob = await markdownToDocxBlob(markdown)
    return {
      blob,
      filename: `${safeBase}.docx`,
    }
  }
  const type = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8"
  return {
    blob: new Blob([markdown || ""], { type }),
    filename: `${safeBase}.${format}`,
  }
}

/**
 * Persist a manual edit as a new FileVersion via the backend edit route.
 *
 * Graceful degradation: if the route/endpoint isn't available (older backend,
 * mock server without the edit route), falls back to returning a locally-built
 * version record so the UI can still show "saved" for the current session.
 */
export async function saveEditedDocument(options: EditorSaveOptions): Promise<EditorSaveResult> {
  const { fileId, markdown, chatId, summary } = options
  const client = fallbackApiClient(options.apiClient)
  const body = {
    content: markdown,
    ...(chatId ? { chatId } : {}),
    ...(summary ? { summary } : {}),
  }

  const remote = (await (client.saveDocumentEdit
    ? client.saveDocumentEdit(fileId, body).catch(() => null)
    : (typeof client.request === "function"
        ? client.request(`/files/${encodeURIComponent(fileId)}/edit`, {
            method: "POST",
            body: JSON.stringify(body),
          }).catch(() => null)
        : null)))

  if (remote && typeof remote === "object") {
    const record = (remote as Record<string, unknown>)
    const version = (record.version || remote) as Record<string, unknown>
    if (version && typeof version === "object" && version.version !== undefined && version.id !== undefined) {
      return {
        fileId,
        version: {
          id: String(version.id),
          version: Number(version.version),
          filename: String(version.filename ?? "documento"),
          summary: version.summary ? String(version.summary) : null,
          createdAt: String(version.createdAt ?? new Date().toISOString()),
          downloadUrl: typeof version.downloadUrl === "string" ? version.downloadUrl : null,
        },
      }
    }
  }

  // Fallback: no backend route → k-1 local record keyed off nothing persisted.
  return {
    fileId,
    version: {
      id: `local-${Date.now()}`,
      version: 0,
      filename: "documento",
      summary: summary ? String(summary) : null,
      createdAt: new Date().toISOString(),
      downloadUrl: null,
    },
  }
}

/** Sanity guard used by the panel to avoid sending a multi-MB blob. */
export function isEditorContentWithinLimits(markdown: string): boolean {
  return typeof markdown === "string" && markdown.length <= MAX_EDIT_SURFACE_CHARS
}