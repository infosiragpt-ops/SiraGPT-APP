import {
  detectPastedContentKind,
  detectNaturalLanguage,
  type PastedContentKind,
  type ContentKindDetection,
} from "./long-paste"

export type PasteCaptureAction =
  | "attach_document"
  | "insert_text"
  | "cancel"

export type PasteCaptureResult = {
  rawText: string
  normalizedText: string
  contentKind: PastedContentKind
  contentKindDetection: ContentKindDetection
  naturalLanguage: string | undefined
  charCount: number
  wordCount: number
  lineCount: number
  sentenceCount: number
  paragraphCount: number
  structuralScore: number
  estimatedTokens: number
  estimatedReadingMinutes: number
  estimatedPages: number
  contentHash: string
  preview: string
  previewTruncated: boolean
  title: string
  suggestedFilename: string
  suggestedMime: string
  suggestedAction: PasteCaptureAction
  isLongPaste: boolean
  detectedAt: string
  processingMs: number
}

const PARAGRAPH_SEPARATOR = /\n{2,}/

function countSentences(text: string): number {
  return (text.match(/[.!?。！？]\s+/g) || []).length + (/[.!?。！？]$/.test(text) ? 1 : 0)
}

function countWords(text: string): number {
  return (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+(?:[''.-][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+)*/g) || []).length
}

function countStructuralSignals(text: string): number {
  const lines = text.split("\n")
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  const bullets = nonEmpty.filter(l => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length
  const headings = nonEmpty.filter(l => /^#{1,6}\s+/.test(l.trim())).length
  const tables = nonEmpty.filter(l => /\t| {2,}\S|\|/.test(l)).length
  const citations = (text.match(/\([A-ZÁÉÍÓÚÑ][^)]*,\s*(?:19|20)\d{2}\)|doi:|https?:\/\//gi) || []).length
  const denseBlocks = text.split(PARAGRAPH_SEPARATOR).filter(b => countWords(b) >= 80).length
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length
  const equations = (text.match(/\$[^$]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g) || []).length
  return [
    bullets >= 2,
    headings >= 2,
    tables >= 2,
    citations >= 2,
    denseBlocks >= 2,
    codeBlocks >= 1,
    equations >= 1,
  ].filter(Boolean).length
}

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function deriveTitle(text: string): string {
  const headingMatch = text.match(/^#{1,6}\s+(.+)$/m)
  if (headingMatch) {
    const title = headingMatch[1].trim()
    return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title
  }
  const firstLine = text
    .split("\n")
    .map(l => l.replace(/^#{1,6}\s+/, "").trim())
    .find(l => l.length > 0)
  const title = (firstLine || "Contenido pegado")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9\s.,:;()/-]/g, "")
    .trim()
  return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title
}

function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "contenido-pegado"
}

const KIND_LABELS: Record<PastedContentKind, string> = {
  prose: "Texto",
  markdown: "Markdown",
  json: "JSON",
  jsonl: "JSON Lines",
  yaml: "YAML",
  csv: "CSV",
  tsv: "TSV",
  html: "HTML",
  xml: "XML",
  sql: "SQL",
  log: "Log",
  stack_trace: "Stack Trace",
  code: "Código",
  shell_session: "Terminal",
  diff: "Diff",
  ini: "Config INI",
  dockerfile: "Dockerfile",
  ssh_key: "Clave SSH",
  pem_certificate: "Certificado PEM",
  transcript: "Transcripción",
  email_thread: "Correo",
  jupyter_notebook: "Jupyter",
  mermaid_diagram: "Mermaid",
  kubernetes_manifest: "K8s Manifest",
  openapi_spec: "OpenAPI",
  graphql_schema: "GraphQL",
  bibtex: "BibTeX",
  latex: "LaTeX",
  makefile: "Makefile",
  env_file: ".env",
}

const KIND_ICONS: Record<PastedContentKind, string> = {
  prose: "📄",
  markdown: "📝",
  json: "{ }",
  jsonl: "{ }",
  yaml: "⚙️",
  csv: "📊",
  tsv: "📊",
  html: "🌐",
  xml: "🌐",
  sql: "🗃️",
  log: "📋",
  stack_trace: "🔥",
  code: "💻",
  shell_session: "⌨️",
  diff: "🔀",
  ini: "⚙️",
  dockerfile: "🐳",
  ssh_key: "🔑",
  pem_certificate: "🔐",
  transcript: "🎙️",
  email_thread: "📧",
  jupyter_notebook: "📓",
  mermaid_diagram: "🔀",
  kubernetes_manifest: "☸️",
  openapi_spec: "🔌",
  graphql_schema: "◈",
  bibtex: "📚",
  latex: "📐",
  makefile: "🔨",
  env_file: "🔐",
}

export function getKindLabel(kind: PastedContentKind): string {
  return KIND_LABELS[kind] || "Documento"
}

export function getKindIcon(kind: PastedContentKind): string {
  return KIND_ICONS[kind] || "📄"
}

const LANGUAGE_LABELS: Record<string, string> = {
  es: "Español",
  en: "English",
  pt: "Português",
  fr: "Français",
  it: "Italiano",
  de: "Deutsch",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  ar: "العربية",
  he: "עברית",
  hi: "हिन्दी",
}

export function getLanguageLabel(code: string | undefined): string {
  if (!code) return ""
  return LANGUAGE_LABELS[code] || code.toUpperCase()
}

export function analyzePastedContent(rawText: string): PasteCaptureResult {
  const start = performance.now()

  const normalizedText = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()

  const contentKindDetection = detectPastedContentKind(normalizedText)
  const naturalLanguage = detectNaturalLanguage(normalizedText)
  const charCount = normalizedText.length
  const wordCount = countWords(normalizedText)
  const lineCount = normalizedText.split("\n").filter(l => l.trim().length > 0).length
  const sentenceCount = countSentences(normalizedText)
  const paragraphCount = normalizedText.split(PARAGRAPH_SEPARATOR).filter(b => b.trim().length > 0).length
  const structuralScore = countStructuralSignals(normalizedText)
  const estimatedTokens = Math.ceil(charCount / 4)
  const estimatedReadingMinutes = Math.max(1, Math.ceil(wordCount / 220))
  const estimatedPages = Math.round((charCount / 2000 + wordCount / 350) / 2)
  const contentHash = fnv1aHash(normalizedText)

  const PREVIEW_LIMIT = 500
  const preview = normalizedText.slice(0, PREVIEW_LIMIT)
  const previewTruncated = normalizedText.length > PREVIEW_LIMIT

  const title = deriveTitle(normalizedText)
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const slug = slugify(title)

  let suggestedFilename: string
  if (contentKindDetection.kind === "dockerfile") {
    suggestedFilename = `${slug}-${ts}.Dockerfile`
  } else if (contentKindDetection.kind === "code") {
    const ext = contentKindDetection.extension || contentKindDetection.language || "code"
    suggestedFilename = `${slug}-${ts}.${ext}`
  } else if (contentKindDetection.kind === "prose") {
    suggestedFilename = `${slug}-${ts}.txt`
  } else {
    suggestedFilename = `${slug}-${ts}.${contentKindDetection.extension}`
  }

  const suggestedMime =
    contentKindDetection.mime && contentKindDetection.confidence >= 0.85
      ? contentKindDetection.mime
      : "text/plain"

  const isLongPaste =
    charCount >= 1200 ||
    wordCount >= 200 ||
    lineCount >= 20 ||
    (charCount >= 80 && contentKindDetection.kind !== "prose" && contentKindDetection.confidence >= 0.72) ||
    (charCount >= 180 && (wordCount >= 35 || lineCount >= 3 || structuralScore >= 1 || sentenceCount >= 2)) ||
    (charCount >= 350 && structuralScore >= 2) ||
    (charCount >= 300 && structuralScore >= 4)

  let suggestedAction: PasteCaptureAction = "insert_text"
  if (isLongPaste) {
    suggestedAction = "attach_document"
  } else if (contentKindDetection.kind !== "prose" && contentKindDetection.confidence >= 0.72) {
    suggestedAction = "attach_document"
  }

  const processingMs = performance.now() - start

  return {
    rawText,
    normalizedText,
    contentKind: contentKindDetection.kind,
    contentKindDetection,
    naturalLanguage,
    charCount,
    wordCount,
    lineCount,
    sentenceCount,
    paragraphCount,
    structuralScore,
    estimatedTokens,
    estimatedReadingMinutes,
    estimatedPages: Math.max(1, estimatedPages),
    contentHash,
    preview,
    previewTruncated,
    title,
    suggestedFilename,
    suggestedMime,
    suggestedAction,
    isLongPaste,
    detectedAt: new Date().toISOString(),
    processingMs,
  }
}
