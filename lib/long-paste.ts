export const LONG_PASTE_MIN_CHARS = 1600
export const LONG_PASTE_MIN_WORDS = 260
// Threshold is "more than 8 lines" (>= 9 non-empty lines) — product
// rule: any multi-line paste deeper than a short snippet should be
// chipped as a document instead of dumped into the textarea.
export const LONG_PASTE_MIN_LINES = 9

export type LongPasteMetadata = {
  kind: "long_paste_document"
  title: string
  filename: string
  text: string
  preview: string
  originalCharCount: number
  originalWordCount: number
  originalLineCount: number
  createdAt: string
}

type FileWithLongPaste = File & {
  __siraLongPaste?: LongPasteMetadata
}

export function normalizePastedText(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length
}

function countStructuralSignals(text: string): number {
  const lines = text.split("\n")
  const nonEmptyLines = lines.filter(line => line.trim().length > 0)
  const bulletLines = nonEmptyLines.filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length
  const headingLines = nonEmptyLines.filter(line => {
    const clean = line.trim()
    return /^#{1,6}\s+/.test(clean) || (/^[A-ZÁÉÍÓÚÑ0-9\s.,:;()/-]{8,}$/.test(clean) && clean.length <= 90)
  }).length
  const tableLikeLines = nonEmptyLines.filter(line => /\t| {2,}\S|\|/.test(line)).length
  const citations = (text.match(/\([A-ZÁÉÍÓÚÑ][^)]*,\s*(?:19|20)\d{2}\)|doi:|https?:\/\//gi) || []).length
  const denseParagraphs = text.split(/\n{2,}/).filter(block => countWords(block) >= 80).length

  return [
    bulletLines >= 3,
    headingLines >= 2,
    tableLikeLines >= 3,
    citations >= 3,
    denseParagraphs >= 2,
  ].filter(Boolean).length
}

export function shouldCompilePastedTextAsDocument(input: string): boolean {
  const text = normalizePastedText(input)
  if (!text) return false

  const charCount = text.length
  const wordCount = countWords(text)
  const lineCount = text.split("\n").filter(line => line.trim().length > 0).length
  const structuralSignals = countStructuralSignals(text)

  return (
    charCount >= LONG_PASTE_MIN_CHARS ||
    wordCount >= LONG_PASTE_MIN_WORDS ||
    lineCount >= LONG_PASTE_MIN_LINES ||
    (charCount >= 900 && structuralSignals >= 3)
  )
}

function deriveTitle(text: string): string {
  const firstMeaningfulLine = text
    .split("\n")
    .map(line => line.replace(/^#{1,6}\s+/, "").trim())
    .find(line => line.length > 0)

  const title = (firstMeaningfulLine || "Texto pegado")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,:;()/-]/gu, "")
    .trim()

  return title.length > 42 ? `${title.slice(0, 39).trim()}...` : title
}

function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "texto-pegado"
}

export function buildLongPasteMetadata(input: string, now: Date = new Date()): LongPasteMetadata {
  const text = normalizePastedText(input)
  const title = deriveTitle(text)
  const timestamp = now.toISOString()
  const safeTimestamp = timestamp.replace(/[:.]/g, "-").slice(0, 19)

  return {
    kind: "long_paste_document",
    title,
    filename: `${slugifyTitle(title)}-${safeTimestamp}.txt`,
    text,
    preview: text.slice(0, 700),
    originalCharCount: text.length,
    originalWordCount: countWords(text),
    originalLineCount: text.split("\n").filter(line => line.trim().length > 0).length,
    createdAt: timestamp,
  }
}

export function createLongPasteDocumentFile(input: string, now: Date = new Date()): FileWithLongPaste {
  const metadata = buildLongPasteMetadata(input, now)
  const file = new File([metadata.text], metadata.filename, {
    type: "text/plain",
    lastModified: now.getTime(),
  }) as FileWithLongPaste

  Object.defineProperty(file, "__siraLongPaste", {
    value: metadata,
    enumerable: false,
    configurable: true,
  })

  return file
}

export function getLongPasteMetadata(source: any): LongPasteMetadata | null {
  const metadata =
    source?.longPasteMeta ||
    source?.longPasteMetadata ||
    source?.__siraLongPaste ||
    source?.file?.__siraLongPaste

  if (!metadata || metadata.kind !== "long_paste_document") return null
  if (typeof metadata.text !== "string" || typeof metadata.title !== "string") return null
  return metadata as LongPasteMetadata
}

export function buildFileOnlyPrompt(files: any[]): string {
  const longPasteDocs = files
    .map(file => getLongPasteMetadata(file))
    .filter((metadata): metadata is LongPasteMetadata => Boolean(metadata))

  if (longPasteDocs.length === 1) {
    return `Analiza el documento de texto adjunto "${longPasteDocs[0].title}" y responde según el contexto del hilo.`
  }

  if (longPasteDocs.length > 1) {
    return `Analiza los ${longPasteDocs.length} documentos de texto adjuntos y responde según el contexto del hilo.`
  }

  return "Analiza los archivos adjuntos y responde según el contexto del hilo."
}
