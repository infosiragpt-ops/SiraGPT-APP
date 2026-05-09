export const LONG_PASTE_MIN_CHARS = 1200
export const LONG_PASTE_MIN_WORDS = 200
export const LONG_PASTE_MIN_LINES = 20
// Lower threshold for research/academic content with strong structure
export const LONG_PASTE_STRUCTURAL_MIN_CHARS = 350
export const LONG_PASTE_STRUCTURAL_SIGNALS = 2

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
  // Enhanced metadata for hierarchical processing
  structuralScore?: number
  hasCodeBlocks?: boolean
  hasCitations?: boolean
  estimatedPages?: number
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
  return (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+(?:[''.-][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+)*/g) || []).length
}

function countStructuralSignals(text: string): number {
  const lines = text.split("\n")
  const nonEmptyLines = lines.filter(line => line.trim().length > 0)
  
  // Existing signals
  const bulletLines = nonEmptyLines.filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length
  const headingLines = nonEmptyLines.filter(line => {
    const clean = line.trim()
    return /^#{1,6}\s+/.test(clean) || (/^[A-ZÁÉÍÓÚÑ0-9\s.,:;()/-]{8,}$/.test(clean) && clean.length <= 90)
  }).length
  const tableLikeLines = nonEmptyLines.filter(line => /\t| {2,}\S|\|/.test(line)).length
  const citations = (text.match(/\([A-ZÁÉÍÓÚÑ][^)]*,\s*(?:19|20)\d{2}\)|doi:|https?:\/\//gi) || []).length
  const denseParagraphs = text.split(/\n{2,}/).filter(block => countWords(block) >= 80).length
  
  // NEW: Academic/research signals
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length
  const inlineCode = (text.match(/`[^`]+`/g) || []).length
  const equations = (text.match(/\$[^$]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g) || []).length
  const referenceLines = nonEmptyLines.filter(line => /^\[\d+\]/.test(line.trim()) || /^[A-ZÁÉÍÓÚÑ][^)]+\(\d{4}\)/.test(line.trim())).length
  const numberedSections = nonEmptyLines.filter(line => /^\d+\.\d+\s/.test(line)).length
  
  // NEW: Academic keywords (titles, abstracts, keywords, references, methodology)
  const academicHeaders = nonEmptyLines.filter(line => {
    const clean = line.trim().toLowerCase()
    return [
      'abstract', 'resumen', 'introduction', 'introducción', 'methodology',
      'metodología', 'method', 'methods', 'results', 'resultados', 
      'discussion', 'discusión', 'conclusion', 'conclusiones',
      'references', 'referencias', 'bibliography', 'bibliografía',
      'acknowledgments', 'agradecimientos', 'appendix', 'apéndice',
      'keywords', 'palabras clave', 'key words',
      'background', 'antecedentes', 'related work', 'trabajo relacionado',
      'experimental', 'experimental setup', 'implementation', 'implementación',
    ].includes(clean)
  }).length

  // NEW: Indentation-based structure (multi-level outlines)
  const indentedLines = nonEmptyLines.filter(line => /^\s{2,}[-*•\d]/.test(line)).length
  
  return [
    bulletLines >= 2,
    headingLines >= 2,
    tableLikeLines >= 2,
    citations >= 2,
    denseParagraphs >= 2,
    codeBlocks >= 1,
    inlineCode >= 3,
    equations >= 1,
    referenceLines >= 2,
    numberedSections >= 2,
    academicHeaders >= 1,
    indentedLines >= 3,
  ].filter(Boolean).length
}

/**
 * Estimate "document pages" for pasted text, roughly equivalent to
 * how many printed PDF pages the content would fill.
 */
function estimatePages(text: string): number {
  const chars = text.length
  const words = countWords(text)
  // ~350 words per page, ~2000 chars per page
  const fromChars = Math.max(1, Math.round(chars / 2000))
  const fromWords = Math.max(1, Math.round(words / 350))
  return Math.round((fromChars + fromWords) / 2)
}

export function shouldCompilePastedTextAsDocument(input: string): boolean {
  const text = normalizePastedText(input)
  if (!text) return false

  const charCount = text.length
  const wordCount = countWords(text)
  const lineCount = text.split("\n").filter(line => line.trim().length > 0).length
  const structuralSignals = countStructuralSignals(text)

  // Primary thresholds
  if (charCount >= LONG_PASTE_MIN_CHARS) return true
  if (wordCount >= LONG_PASTE_MIN_WORDS) return true
  if (lineCount >= LONG_PASTE_MIN_LINES) return true

  // Structural threshold (academic/research/code content with fewer chars)
  if (charCount >= LONG_PASTE_STRUCTURAL_MIN_CHARS && structuralSignals >= LONG_PASTE_STRUCTURAL_SIGNALS) return true

  // High-signal short content (very structured, e.g. academic abstracts, code + comments, reference lists)
  if (charCount >= 300 && structuralSignals >= 4) return true

  return false
}

function deriveTitle(text: string): string {
  // Try first meaningful heading first
  const headingMatch = text.match(/^#{1,6}\s+(.+)$/m)
  if (headingMatch) {
    const title = headingMatch[1].trim()
    return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title
  }

  // Try all-caps title line (common in academic papers)
  const allCapsMatch = text.split("\n").find(line => {
    const trimmed = line.trim()
    return trimmed.length >= 10 && trimmed.length <= 80 && 
           trimmed === trimmed.toUpperCase() && 
           /[A-ZÁÉÍÓÚÑ]{4,}/.test(trimmed)
  })
  if (allCapsMatch) return allCapsMatch.trim()

  // Fall back to first meaningful line
  const firstMeaningfulLine = text
    .split("\n")
    .map(line => line.replace(/^#{1,6}\s+/, "").trim())
    .find(line => line.length > 0)

  const title = (firstMeaningfulLine || "Texto pegado")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9\s.,:;()/-]/g, "")
    .trim()

  return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title
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

  const structuralScore = countStructuralSignals(text)
  const hasCodeBlocks = (text.match(/```[\s\S]*?```/g) || []).length > 0
  const hasCitations = (text.match(/\([A-ZÁÉÍÓÚÑ][^)]*,\s*(?:19|20)\d{2}\)/g) || []).length > 0

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
    structuralScore,
    hasCodeBlocks,
    hasCitations,
    estimatedPages: estimatePages(text),
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

  // Enhanced prompt with document metadata for better agent context
  if (longPasteDocs.length === 1) {
    const meta = longPasteDocs[0]
    const pages = meta.estimatedPages ? ` (~${meta.estimatedPages} páginas)` : ''
    const structure = meta.structuralScore && meta.structuralScore > 3 ? ' (texto con estructura jerárquica detectada)' : ''
    return `Analiza el documento de texto adjunto "${meta.title}"${pages}${structure} y responde según el contexto del hilo.`
  }

  if (longPasteDocs.length > 1) {
    return `Analiza los ${longPasteDocs.length} documentos de texto adjuntos y responde según el contexto del hilo.`
  }

  return "Analiza los archivos adjuntos y responde según el contexto del hilo."
}
