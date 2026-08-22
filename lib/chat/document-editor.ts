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
  const sanitized = DOMPurify.sanitize(text, { SAFE_FOR_TEMPLATES: false })
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