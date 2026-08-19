export const LONG_PASTE_MIN_CHARS = 1200
export const LONG_PASTE_MIN_WORDS = 200
export const LONG_PASTE_MIN_LINES = 20
export const INFORMATION_PASTE_MIN_CHARS = 180
export const INFORMATION_PASTE_MIN_WORDS = 35
export const INFORMATION_PASTE_MIN_LINES = 3
// Lower threshold for research/academic content with strong structure
export const LONG_PASTE_STRUCTURAL_MIN_CHARS = 350
export const LONG_PASTE_STRUCTURAL_SIGNALS = 2

// Canonical content kinds the classifier can detect from raw paste.
// Anything outside this set falls back to "prose".
export type PastedContentKind =
  | "prose"
  | "markdown"
  | "json"
  | "jsonl"
  | "yaml"
  | "csv"
  | "tsv"
  | "html"
  | "xml"
  | "sql"
  | "log"
  | "stack_trace"
  | "code"
  | "shell_session"
  | "diff"
  | "ini"
  | "dockerfile"
  | "ssh_key"
  | "pem_certificate"
  | "transcript"
  | "email_thread"
  | "jupyter_notebook"
  | "mermaid_diagram"
  | "kubernetes_manifest"
  | "openapi_spec"
  | "graphql_schema"
  | "bibtex"
  | "latex"
  | "makefile"
  | "env_file"

export type ContentKindDetection = {
  kind: PastedContentKind
  /** 0..1 — how strongly the heuristics matched. */
  confidence: number
  /** Best-effort programming language (only for kind === "code"). */
  language?: string
  /** File extension (without dot) appropriate for the detected kind. */
  extension: string
  /** MIME type that downstream pipelines should treat the paste as. */
  mime: string
  /** Short signals fired during detection (for telemetry). */
  signals: string[]
}

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
  // ── New rich-content metadata ────────────────────────────────────
  /** Canonical content kind detected from the paste body. */
  contentKind?: PastedContentKind
  /** Confidence (0..1) the kind detector assigned. */
  contentKindConfidence?: number
  /** Programming language when contentKind === "code". */
  programmingLanguage?: string
  /** MIME type that best matches the detected content. */
  detectedMime?: string
  /** Best-effort natural language ("es", "en", "pt", "fr", or undefined). */
  detectedLanguage?: string
  /** Short signals for telemetry / debugging. */
  detectionSignals?: string[]
  /** Token-budget hint (rough OpenAI tokenizer estimate). */
  estimatedTokens?: number
  /** Reading time in minutes for prose content. */
  estimatedReadingMinutes?: number
  /** Hash of the normalized text — enables cross-message dedup downstream. */
  contentHash?: string
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
  const detection = detectPastedContentKind(text)
  const sentenceCount = (text.match(/[.!?。！？]\s+/g) || []).length + (/[.!?。！？]$/.test(text) ? 1 : 0)

  // Primary thresholds
  if (charCount >= LONG_PASTE_MIN_CHARS) return true
  if (wordCount >= LONG_PASTE_MIN_WORDS) return true
  if (lineCount >= LONG_PASTE_MIN_LINES) return true

  // Structured pasted information should become an attachment even when
  // short. This is what makes copy/paste feel document-native instead of
  // dumping source material into the composer as prompt text.
  if (charCount >= 80 && detection.kind !== "prose" && detection.confidence >= 0.72) return true

  // Professional note/email/report snippets are often only a few paragraphs.
  // Keep normal one-line prompts in the textarea, but compile any pasted
  // information that has enough body or structure to be worth auditing.
  if (
    charCount >= INFORMATION_PASTE_MIN_CHARS
    && (
      wordCount >= INFORMATION_PASTE_MIN_WORDS
      || lineCount >= INFORMATION_PASTE_MIN_LINES
      || structuralSignals >= 1
      || sentenceCount >= 2
    )
  ) {
    return true
  }

  // Structural threshold (academic/research/code content with fewer chars)
  if (charCount >= LONG_PASTE_STRUCTURAL_MIN_CHARS && structuralSignals >= LONG_PASTE_STRUCTURAL_SIGNALS) return true

  // High-signal short content (very structured, e.g. academic abstracts, code + comments, reference lists)
  if (charCount >= 300 && structuralSignals >= 4) return true

  return false
}

// ─── Content kind detection ──────────────────────────────────────────
// Pure-function classifier that examines the first ~16 KB of the paste
// and decides whether it's prose, code, structured data, a log, etc.
// The detection is deterministic, dependency-free, and runs in <1 ms
// for typical clipboard payloads.

// Order matters — very specific anchors come FIRST, otherwise generic
// `function …` / `def …` patterns from Python/JS would shadow Scala/Elixir/
// Solidity etc. The list is checked top-down; first match wins.
const PROGRAMMING_LANGUAGE_HINTS: Array<{ lang: string; pattern: RegExp }> = [
  // Tier 1: highly distinctive anchors
  { lang: "solidity", pattern: /(^|\n)\s*pragma\s+solidity\s+[\^~]?\d|(^|\n)\s*contract\s+\w+(?:\s+is\s+[\w,\s]+)?\s*\{|(^|\n)\s*(?:event|modifier)\s+\w+\s*\(/ },
  { lang: "scala", pattern: /(^|\n)\s*(object\s+\w+\s+extends\s+\w+|case\s+class\s+\w+\s*\(|trait\s+\w+\s*\{|sealed\s+(?:trait|class)\s+\w+|implicit\s+(?:val|def)\s+\w+|object\s+\w+\s*\{)/ },
  { lang: "elixir", pattern: /(^|\n)\s*(defmodule\s+[A-Z]\w*(?:\.[A-Z]\w*)*\s+do\b|defp?\s+\w+\s*(?:\([^)]*\))?\s+do\b|@spec\s+\w+|use\s+[A-Z]\w*\s|@moduledoc\s)/ },
  { lang: "haskell", pattern: /(^|\n)\s*(module\s+[A-Z]\w*(?:\.[A-Z]\w*)*\s+where\b|import\s+(?:qualified\s+)?[A-Z]\w*(?:\.[A-Z]\w*)*\s|data\s+[A-Z]\w*\s*=\s+[A-Z]|instance\s+\w+\s+[A-Z]|\w+\s*::\s+[A-Z]\w*\s*->)/ },
  { lang: "dart", pattern: /(^|\n)\s*(import\s+['"](?:dart:|package:)[^'"]+['"];|class\s+\w+\s+extends\s+(?:Stateless|Stateful)Widget|Widget\s+build\s*\(BuildContext|@override\b\s+Widget\b)/ },
  { lang: "julia", pattern: /(^|\n)\s*(using\s+\w+(?:,\s*\w+)+|function\s+\w+\s*\([^)]*\)(?:::\w+)?\s*$|struct\s+\w+\s*$|module\s+\w+\s*$|@inline\s+|@inbounds\s+)/m },
  { lang: "lua", pattern: /(^|\n)\s*(local\s+(?:function\s+)?\w+\s*[=(]|function\s+\w+(?:[.:]\w+)+\s*\(|require\s*\(?["'][\w.]+["']\)?|\.\.\s*["']|--\[\[|--\s*@\w+)/ },
  { lang: "r", pattern: /(^|\n)\s*(library\s*\(\s*\w+\s*\)|\w+\s*<-\s+(?:function|\w)|ggplot\s*\(|data\.frame\s*\(|setwd\s*\(|install\.packages\s*\()/ },
  { lang: "perl", pattern: /(^|\n)\s*(#!\/usr\/bin\/(?:env\s+)?perl|use\s+strict;|sub\s+\w+\s*\{|my\s+[\$@%]\w+\s*=)/ },
  // Tier 2: well-known mainstream languages
  { lang: "typescript", pattern: /(^|\n)\s*(import\s+.+\s+from\s+["'][^"']+["']|export\s+(default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\b|interface\s+\w+\s*\{|: \s*(?:string|number|boolean|Promise<))/ },
  { lang: "javascript", pattern: /(^|\n)\s*(const|let|var|function|class|require\(|module\.exports|console\.log|export\s+(default|const|function))\b/ },
  { lang: "python", pattern: /(^|\n)\s*(def\s+\w+\s*\(|class\s+\w+(?:\s*\([^)]*\))?\s*:|import\s+\w+|from\s+\w+\s+import|if __name__\s*==\s*['"]__main__['"]|print\()/ },
  { lang: "rust", pattern: /(^|\n)\s*(fn\s+\w+\s*\(|let\s+(mut\s+)?\w+\s*[:=]|use\s+\w+::|impl\s+\w+|#\[derive\()/ },
  { lang: "go", pattern: /(^|\n)\s*(package\s+\w+|func\s+\w+\s*\(|import\s+\(|var\s+\w+\s+\w+|type\s+\w+\s+struct\s*\{)/ },
  { lang: "java", pattern: /(^|\n)\s*(public\s+(static\s+)?(class|interface|enum)\s+\w+|@Override\b|System\.out\.println|public\s+static\s+void\s+main)/ },
  { lang: "csharp", pattern: /(^|\n)\s*(using\s+\w+(\.\w+)*;|namespace\s+\w+|public\s+(class|interface|struct|record)\s+\w+|Console\.WriteLine)/ },
  { lang: "cpp", pattern: /(^|\n)\s*(#include\s*<[^>]+>|std::|template\s*<|namespace\s+\w+\s*\{)/ },
  { lang: "php", pattern: /(<\?php|->|\$\w+\s*=)/ },
  { lang: "ruby", pattern: /(^|\n)\s*(def\s+\w+|class\s+\w+(\s*<\s*\w+)?|module\s+\w+|require\s+['"]|puts\s+)/ },
  { lang: "swift", pattern: /(^|\n)\s*(import\s+\w+|func\s+\w+\s*\(|var\s+\w+\s*:|let\s+\w+\s*[:=]|@objc\b|@IBOutlet\b)/ },
  { lang: "kotlin", pattern: /(^|\n)\s*(fun\s+\w+\s*\(|val\s+\w+\s*[:=]|var\s+\w+\s*[:=]|class\s+\w+(\s*\(.*\))?|package\s+\w+(\.\w+)*)/ },
  { lang: "bash", pattern: /(^|\n)\s*(#!\/(?:bin|usr\/bin)\/(?:bash|sh|zsh)|\$\(.+?\)|`.+?`|export\s+\w+=)/ },
  { lang: "sql", pattern: /\b(SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w+|CREATE\s+(TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE)\b/i },
  { lang: "css", pattern: /(^|\n)\s*[.#]?[\w-]+\s*\{[^}]*(?:color|background|margin|padding|font|display|flex|grid)\s*:/ },
  { lang: "scss", pattern: /(^|\n)\s*(@mixin|@include|@extend|@import\s+['"][^'"]+['"];|\$[\w-]+\s*:)/ },
  { lang: "graphql", pattern: /(^|\n)\s*(query|mutation|subscription|fragment)\s+\w+\s*[{(]|type\s+\w+\s*\{[^}]*\w+\s*:/ },
]

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false
  // Cheap structural check before attempting JSON.parse on huge payloads.
  if (trimmed.length > 200_000) return /["{}\[\]]/.test(trimmed) && /:\s*("|\d|true|false|null|\{|\[)/.test(trimmed)
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function looksLikeJsonl(text: string): boolean {
  // JSON Lines: each non-empty line is independently valid JSON.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean)
  if (lines.length < 3) return false
  // Cap parsing cost — only check first 30 lines but require all to be valid
  const sample = lines.slice(0, 30)
  let parsed = 0
  for (const line of sample) {
    if (!/^[{[]/.test(line) || !/[}\]]$/.test(line)) return false
    try { JSON.parse(line); parsed++ } catch { return false }
  }
  return parsed === sample.length
}

function looksLikeJupyterNotebook(text: string): boolean {
  // .ipynb is a JSON document with required top-level keys.
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return false
  // Cheap pre-check before JSON.parse
  if (!/"nbformat"\s*:\s*\d/.test(trimmed) || !/"cells"\s*:\s*\[/.test(trimmed)) return false
  try {
    const obj = JSON.parse(trimmed)
    return Boolean(obj && typeof obj === "object" && Array.isArray(obj.cells) && typeof obj.nbformat === "number")
  } catch {
    return false
  }
}

function looksLikeKubernetesManifest(text: string): boolean {
  // Detect K8s manifests by apiVersion + kind YAML structure. Must NOT
  // already match a more specific YAML purpose (helm values, kustomize, etc).
  if (!/^apiVersion:\s*[\w.\/-]+/m.test(text)) return false
  if (!/^kind:\s*\w+/m.test(text)) return false
  // Common K8s kinds — having one boosts confidence
  const kinds = /(?:^kind:\s*(?:Pod|Deployment|Service|ConfigMap|Secret|Ingress|StatefulSet|DaemonSet|Job|CronJob|Namespace|ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding|PersistentVolumeClaim|HorizontalPodAutoscaler|NetworkPolicy|CustomResourceDefinition))/m
  return kinds.test(text) || /^metadata:\s*$/m.test(text)
}

function looksLikeOpenApiSpec(text: string): boolean {
  // YAML or JSON OpenAPI/Swagger spec
  if (!/(?:^openapi:\s*["']?[23]\.|"openapi"\s*:\s*"[23]\.|^swagger:\s*["']?2\.0|"swagger"\s*:\s*"2\.0")/m.test(text)) return false
  // Need "paths" key as well
  return /(?:^paths:|"paths"\s*:)/m.test(text)
}

function looksLikeGraphqlSchema(text: string): boolean {
  // GraphQL SDL: type/interface/enum/scalar/union/input declarations
  const types = (text.match(/^\s*(?:type|interface|enum|scalar|union|input)\s+\w+/gm) || []).length
  const fieldArrows = (text.match(/^\s+\w+(?:\([^)]*\))?\s*:\s*\w+!?\s*$/gm) || []).length
  // Must have at least 1 type declaration and several field lines
  return types >= 1 && fieldArrows >= 3
}

function looksLikeBibtex(text: string): boolean {
  // @article{key, ...} or @book{key, ...} patterns
  const entries = (text.match(/@(?:article|book|inproceedings|proceedings|incollection|inbook|conference|manual|techreport|phdthesis|mastersthesis|misc|unpublished|booklet)\s*\{[^,}]+,/gi) || []).length
  return entries >= 1
}

function looksLikeLatex(text: string): boolean {
  // LaTeX docs have \documentclass or \begin{document}; intermediate snippets
  // may have multiple \begin/\end pairs or LaTeX math/macros.
  if (/\\documentclass\b/.test(text)) return true
  if (/\\begin\{document\}/.test(text)) return true
  const beginEnd = (text.match(/\\begin\{[\w*]+\}/g) || []).length
  const macros = (text.match(/\\(?:section|subsection|chapter|paragraph|emph|textbf|textit|cite|ref|label|item|usepackage|newcommand|renewcommand|frac|sqrt|sum|int)\b/g) || []).length
  return beginEnd >= 2 || macros >= 5
}

function looksLikeMakefile(text: string): boolean {
  // Targets: dependencies followed by tab-indented recipe lines
  const lines = text.split("\n")
  let targets = 0
  let tabRecipes = 0
  let prevWasTarget = false
  for (const line of lines) {
    if (/^[A-Za-z_][\w.-]*\s*:(?!\s*=)/.test(line) && !line.trim().endsWith(":")) {
      targets++
      prevWasTarget = true
      continue
    }
    // Allow target lines with no deps too
    if (/^[A-Za-z_][\w.-]*:\s*$/.test(line)) { targets++; prevWasTarget = true; continue }
    if (prevWasTarget && /^\t\S/.test(line)) { tabRecipes++ }
    if (line.trim() === "") prevWasTarget = false
  }
  // Need both: at least 2 targets and at least 1 tab-indented recipe line
  if (targets >= 2 && tabRecipes >= 1) return true
  // Or special variable assignments common in Makefiles
  if (targets >= 1 && /^(?:CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|LIBS|PREFIX|DESTDIR|MAKEFLAGS|\.PHONY)\s*[:?+]?=/m.test(text)) return true
  return false
}

function looksLikeMermaidDiagram(text: string): boolean {
  const trimmed = text.trim()
  // First non-comment line must be a diagram type
  const firstLine = trimmed.split("\n").find(l => l.trim() && !l.trim().startsWith("%%"))
  if (!firstLine) return false
  return /^(?:graph\s+[A-Z]{2}|flowchart\s+[A-Z]{2}|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie(?:\s+title)?|mindmap|journey|gitGraph|requirementDiagram|C4Context|timeline)\b/.test(firstLine.trim())
}

function looksLikeEnvFile(text: string): boolean {
  // KEY=value with allowed shell-style export prefix; usually short lines.
  const lines = text.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"))
  if (lines.length < 3) return false
  const envLines = lines.filter(l => /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=(?:["']?[^=]*["']?)?\s*$/.test(l)).length
  // At least 80% of non-comment lines must be KEY=value
  return envLines >= 3 && envLines / lines.length >= 0.8
}

function looksLikeYaml(text: string): boolean {
  const lines = text.split("\n").slice(0, 200)
  const nonEmpty = lines.filter(line => line.trim() && !line.trim().startsWith("#"))
  if (nonEmpty.length < 3) return false
  // YAML signatures: indented "key: value", list items "- ", document separator "---"
  const keyValueLines = nonEmpty.filter(line => /^\s*[\w.-]+\s*:(\s+|$)/.test(line)).length
  const listItems = nonEmpty.filter(line => /^\s*-\s+/.test(line)).length
  const docSeparators = lines.filter(line => /^---\s*$/.test(line)).length
  const hasYamlAnchor = lines.some(line => /^\s*&\w+\b/.test(line) || /^\s*\*\w+\b/.test(line))
  // Reject if it looks more like prose (sentences ending in period dominate)
  const sentenceLines = nonEmpty.filter(line => /[.!?]\s*$/.test(line.trim())).length
  if (sentenceLines > nonEmpty.length * 0.6) return false
  return keyValueLines >= 3 && (keyValueLines / nonEmpty.length) >= 0.4 || docSeparators >= 1 && keyValueLines >= 1 || hasYamlAnchor && keyValueLines >= 1
}

function looksLikeCsv(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 3) return false
  const commaCounts = lines.map(line => (line.match(/,/g) || []).length)
  const firstCommas = commaCounts[0]
  if (firstCommas < 1) return false
  // Most lines should share the same column count (±1 for trailing commas)
  const consistent = commaCounts.filter(n => Math.abs(n - firstCommas) <= 1).length
  return consistent / commaCounts.length >= 0.85
}

function looksLikeTsv(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 3) return false
  const tabCounts = lines.map(line => (line.match(/\t/g) || []).length)
  const firstTabs = tabCounts[0]
  if (firstTabs < 1) return false
  const consistent = tabCounts.filter(n => Math.abs(n - firstTabs) <= 1).length
  return consistent / tabCounts.length >= 0.85
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim()
  if (!/^<(?:!doctype\s+html|html|body|div|head|section|article)[\s>]/i.test(trimmed) && !/<\/(?:html|body|head|div|section|p|span)\s*>/i.test(trimmed)) return false
  // Need a closing tag too — single fragments like "<div>" don't count
  return /<\/\w+>/.test(trimmed)
}

function looksLikeXml(text: string): boolean {
  const trimmed = text.trim()
  if (/<\?xml\s/i.test(trimmed)) return true
  if (!/^<\w+[\s>]/i.test(trimmed)) return false
  // XML must close all tags and have non-HTML root element
  if (looksLikeHtml(trimmed)) return false
  return /<\/\w+>/.test(trimmed) && /\sxmlns(?::\w+)?\s*=/.test(trimmed)
}

function looksLikeSql(text: string): boolean {
  // At least 2 distinct SQL verbs across statements is a strong signal.
  const verbs = (text.toUpperCase().match(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE|WITH|GRANT|REVOKE|EXPLAIN)\b/g) || []).length
  const hasFromOrInto = /\b(FROM|INTO)\s+\w+/i.test(text)
  return verbs >= 2 && hasFromOrInto
}

function looksLikeLog(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 5) return false
  // Common log line shapes: ISO timestamp, syslog, [LEVEL], "ERROR:", journalctl, request log
  const matchers: RegExp[] = [
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
    /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/,
    /^\[(?:DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\]/i,
    /^(?:DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\s*[:[]/i,
    /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s/, // syslog "May 12 10:00:00"
    /^\d+\.\d+\.\d+\.\d+\s+-\s+/, // common access log "127.0.0.1 - -"
  ]
  const matchingLines = lines.filter(line => matchers.some(re => re.test(line))).length
  return matchingLines / lines.length >= 0.5
}

function looksLikeStackTrace(text: string): boolean {
  const lines = text.split("\n").slice(0, 100)
  // Python: "Traceback (most recent call last):" + "  File "..." line N"
  if (/Traceback \(most recent call last\):/.test(text) && /File\s+"[^"]+",\s+line\s+\d+/.test(text)) return true
  // JS/TS: "at fn (file:line:col)"
  const atFrames = lines.filter(line => /^\s*at\s+[\w.<>$]+\s*(?:\([^)]+:\d+:\d+\))?/.test(line)).length
  if (atFrames >= 3) return true
  // Java: "at pkg.Class.method(File.java:NN)"
  const javaFrames = lines.filter(line => /^\s*at\s+[\w.$]+\([\w$]+\.\w+:\d+\)/.test(line)).length
  if (javaFrames >= 3) return true
  // .NET: "   at Namespace.Class.Method() in C:\path:line N"
  const dotnetFrames = lines.filter(line => /^\s+at\s+[\w.]+(\.\w+)+\(\)\s*in\s+/.test(line)).length
  return dotnetFrames >= 2
}

function looksLikeShellSession(text: string): boolean {
  const lines = text.split("\n").filter(l => l.length > 0).slice(0, 100)
  if (lines.length < 4) return false
  // Prompts: "$ ", "% ", "# ", "PS C:\>", "user@host:~$"
  const promptLines = lines.filter(line => /^(?:[\w.@-]+[:@~][\w/~.-]*[$#%>]\s|\$\s|%\s|#\s|PS [A-Z]:\\.*>\s)/.test(line)).length
  return promptLines >= 3
}

function looksLikeDiff(text: string): boolean {
  if (/^diff --git\s+/m.test(text)) return true
  const lines = text.split("\n").slice(0, 200)
  const hunkHeaders = lines.filter(line => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)).length
  if (hunkHeaders >= 1) return true
  const plusMinus = lines.filter(line => /^[+-]/.test(line) && !/^[+-]{3}\s/.test(line)).length
  return hunkHeaders >= 1 && plusMinus >= 4
}

function looksLikeIni(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim() && !l.trim().startsWith(";") && !l.trim().startsWith("#"))
  if (lines.length < 4) return false
  const sections = lines.filter(l => /^\s*\[[^\]]+\]\s*$/.test(l)).length
  const keyValues = lines.filter(l => /^\s*[\w.-]+\s*=/.test(l)).length
  return sections >= 1 && keyValues >= 3 || keyValues >= lines.length * 0.7
}

function looksLikeDockerfile(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim() && !l.trim().startsWith("#")).slice(0, 100)
  if (lines.length < 2) return false
  const dockerVerbs = lines.filter(l => /^\s*(FROM|RUN|CMD|COPY|ADD|ENV|EXPOSE|WORKDIR|VOLUME|ARG|LABEL|ENTRYPOINT|HEALTHCHECK|SHELL|USER|ONBUILD|STOPSIGNAL)\s+/i.test(l)).length
  return /^FROM\s+\S+/im.test(text) && dockerVerbs >= 2
}

function looksLikeSshKey(text: string): boolean {
  const trimmed = text.trim()
  return /^ssh-(?:rsa|ed25519|dss|ecdsa)\s+[A-Za-z0-9+/=]+/.test(trimmed) || /^-----BEGIN\s+(?:OPENSSH\s+)?PRIVATE\s+KEY-----/.test(trimmed)
}

function looksLikePemCertificate(text: string): boolean {
  return /^-----BEGIN\s+CERTIFICATE-----/m.test(text) && /^-----END\s+CERTIFICATE-----/m.test(text)
}

function looksLikeMarkdown(text: string): boolean {
  const headings = (text.match(/^#{1,6}\s+\S/gm) || []).length
  const fencedCode = (text.match(/```[\s\S]*?```/g) || []).length
  const lists = (text.match(/^\s*[-*+]\s+\S/gm) || []).length
  const tables = (text.match(/^\|.+\|.*\n\|[-:|\s]+\|/gm) || []).length
  const links = (text.match(/\[[^\]]+\]\([^)]+\)/g) || []).length
  const inlineCode = (text.match(/(?<!`)`[^`\n]+`(?!`)/g) || []).length
  const score =
    (headings >= 2 ? 2 : headings) +
    (fencedCode >= 1 ? 2 : 0) +
    (lists >= 3 ? 2 : 0) +
    (tables >= 1 ? 2 : 0) +
    (links >= 2 ? 1 : 0) +
    (inlineCode >= 3 ? 1 : 0)
  return score >= 3
}

function looksLikeTranscript(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 6) return false
  // Speaker labels: "Speaker A:", "[10:23] Speaker A —", "Juan: ...", or "00:01:23"
  const speakerLines = lines.filter(line => /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s+)?[A-ZÁÉÍÓÚÑ][\w\s]{0,30}:\s+/.test(line) || /^\d{1,2}:\d{2}(?::\d{2})?\s+[-—]/.test(line)).length
  return speakerLines >= 4 && speakerLines / lines.length >= 0.3
}

function looksLikeEmailThread(text: string): boolean {
  const headerHits = (text.match(/^(?:From|To|Cc|Bcc|Subject|Sent|Date):\s+/gm) || []).length
  const replyMarkers = (text.match(/^>+\s/gm) || []).length
  const reTags = (text.match(/^Subject:\s*(?:Re|Fwd|RE|FW|RV|REF):\s+/gm) || []).length
  return headerHits >= 3 || (headerHits >= 2 && replyMarkers >= 4) || reTags >= 1
}

function detectProgrammingLanguage(text: string): string | undefined {
  const head = text.slice(0, 16_000)
  for (const { lang, pattern } of PROGRAMMING_LANGUAGE_HINTS) {
    if (pattern.test(head)) return lang
  }
  return undefined
}

const KIND_TO_EXT: Record<PastedContentKind, { extension: string; mime: string }> = {
  prose: { extension: "txt", mime: "text/plain" },
  markdown: { extension: "md", mime: "text/markdown" },
  json: { extension: "json", mime: "application/json" },
  jsonl: { extension: "jsonl", mime: "application/x-ndjson" },
  yaml: { extension: "yaml", mime: "text/yaml" },
  csv: { extension: "csv", mime: "text/csv" },
  tsv: { extension: "tsv", mime: "text/tab-separated-values" },
  html: { extension: "html", mime: "text/html" },
  xml: { extension: "xml", mime: "application/xml" },
  sql: { extension: "sql", mime: "application/sql" },
  log: { extension: "log", mime: "text/plain" },
  stack_trace: { extension: "log", mime: "text/plain" },
  code: { extension: "txt", mime: "text/plain" }, // overridden by language-specific ext
  shell_session: { extension: "txt", mime: "text/plain" },
  diff: { extension: "patch", mime: "text/x-diff" },
  ini: { extension: "ini", mime: "text/plain" },
  dockerfile: { extension: "Dockerfile", mime: "text/plain" },
  ssh_key: { extension: "pub", mime: "text/plain" },
  pem_certificate: { extension: "pem", mime: "application/x-pem-file" },
  transcript: { extension: "txt", mime: "text/plain" },
  email_thread: { extension: "eml", mime: "message/rfc822" },
  jupyter_notebook: { extension: "ipynb", mime: "application/x-ipynb+json" },
  mermaid_diagram: { extension: "mmd", mime: "text/vnd.mermaid" },
  kubernetes_manifest: { extension: "yaml", mime: "text/yaml" },
  openapi_spec: { extension: "yaml", mime: "text/yaml" },
  graphql_schema: { extension: "graphql", mime: "application/graphql" },
  bibtex: { extension: "bib", mime: "application/x-bibtex" },
  latex: { extension: "tex", mime: "application/x-latex" },
  makefile: { extension: "Makefile", mime: "text/plain" },
  env_file: { extension: "env", mime: "text/plain" },
}

const UPLOAD_SAFE_DETECTED_MIMES = new Set([
  "application/json",
  "application/xml",
  "message/rfc822",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
])

const EXECUTABLE_CODE_EXTENSIONS = new Set([
  "bat",
  "cmd",
  "com",
  "js",
  "jse",
  "lua",
  "php",
  "pl",
  "ps1",
  "py",
  "rb",
  "sh",
  "zsh",
])

const LANGUAGE_TO_EXT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  go: "go",
  java: "java",
  csharp: "cs",
  cpp: "cpp",
  scala: "scala",
  elixir: "ex",
  haskell: "hs",
  lua: "lua",
  dart: "dart",
  r: "R",
  julia: "jl",
  solidity: "sol",
  perl: "pl",
  php: "php",
  ruby: "rb",
  swift: "swift",
  kotlin: "kt",
  bash: "sh",
  sql: "sql",
  css: "css",
  scss: "scss",
  graphql: "graphql",
}

/**
 * Classify pasted text into one of {@link PastedContentKind}.
 * Detection runs in declared priority order — exact-match heuristics
 * (json, yaml, pem) come first, soft heuristics (prose, markdown) last.
 */
export function detectPastedContentKind(input: string): ContentKindDetection {
  const text = normalizePastedText(input)
  const signals: string[] = []

  // High-confidence exact-match signals first
  if (looksLikePemCertificate(text)) {
    signals.push("pem-markers")
    return { kind: "pem_certificate", confidence: 0.99, ...KIND_TO_EXT.pem_certificate, signals }
  }
  if (looksLikeSshKey(text)) {
    signals.push("ssh-prefix")
    return { kind: "ssh_key", confidence: 0.99, ...KIND_TO_EXT.ssh_key, signals }
  }
  if (looksLikeDockerfile(text)) {
    signals.push("dockerfile-verbs")
    return { kind: "dockerfile", confidence: 0.95, ...KIND_TO_EXT.dockerfile, signals }
  }
  // Jupyter notebook must be checked before JSON — both are valid JSON, but
  // a notebook gets a richer kind label that downstream parsers can use.
  if (looksLikeJupyterNotebook(text)) {
    signals.push("ipynb-cells-nbformat")
    return { kind: "jupyter_notebook", confidence: 0.97, ...KIND_TO_EXT.jupyter_notebook, signals }
  }
  if (looksLikeJson(text)) {
    signals.push("json-parse-ok")
    return { kind: "json", confidence: 0.99, ...KIND_TO_EXT.json, signals }
  }
  if (looksLikeJsonl(text)) {
    signals.push("jsonl-lines-parse")
    return { kind: "jsonl", confidence: 0.92, ...KIND_TO_EXT.jsonl, signals }
  }
  if (looksLikeDiff(text)) {
    signals.push("diff-hunks")
    return { kind: "diff", confidence: 0.95, ...KIND_TO_EXT.diff, signals }
  }
  if (looksLikeStackTrace(text)) {
    signals.push("stack-frames")
    return { kind: "stack_trace", confidence: 0.9, ...KIND_TO_EXT.stack_trace, signals }
  }
  // BibTeX: highly specific @article{...} structure, check before XML/HTML.
  if (looksLikeBibtex(text)) {
    signals.push("bibtex-entries")
    return { kind: "bibtex", confidence: 0.95, ...KIND_TO_EXT.bibtex, signals }
  }
  // LaTeX: \documentclass / \begin{document} are very specific anchors.
  if (looksLikeLatex(text)) {
    signals.push("latex-macros")
    return { kind: "latex", confidence: 0.9, ...KIND_TO_EXT.latex, signals }
  }
  if (looksLikeXml(text)) {
    signals.push("xml-decl-or-namespace")
    return { kind: "xml", confidence: 0.92, ...KIND_TO_EXT.xml, signals }
  }
  if (looksLikeHtml(text)) {
    signals.push("html-tags")
    return { kind: "html", confidence: 0.9, ...KIND_TO_EXT.html, signals }
  }
  // Email threads can look superficially like YAML (lots of "Key: value"
  // header lines), so check email headers FIRST.
  if (looksLikeEmailThread(text)) {
    signals.push("email-headers")
    return { kind: "email_thread", confidence: 0.78, ...KIND_TO_EXT.email_thread, signals }
  }
  // Mermaid diagrams: keyword-anchored. Check before generic yaml/code paths.
  if (looksLikeMermaidDiagram(text)) {
    signals.push("mermaid-diagram-type")
    return { kind: "mermaid_diagram", confidence: 0.93, ...KIND_TO_EXT.mermaid_diagram, signals }
  }
  // OpenAPI / Kubernetes are YAML subspecies — match BEFORE plain yaml.
  if (looksLikeOpenApiSpec(text)) {
    signals.push("openapi-paths")
    return { kind: "openapi_spec", confidence: 0.93, ...KIND_TO_EXT.openapi_spec, signals }
  }
  if (looksLikeKubernetesManifest(text)) {
    signals.push("k8s-apiversion-kind")
    return { kind: "kubernetes_manifest", confidence: 0.9, ...KIND_TO_EXT.kubernetes_manifest, signals }
  }
  // GraphQL SDL & Makefile must come BEFORE generic YAML — both have lots of
  // `field: Type` lines that would otherwise trigger YAML's key/value detector.
  if (looksLikeGraphqlSchema(text)) {
    signals.push("graphql-types")
    return { kind: "graphql_schema", confidence: 0.88, ...KIND_TO_EXT.graphql_schema, signals }
  }
  if (looksLikeMakefile(text)) {
    signals.push("makefile-targets")
    return { kind: "makefile", confidence: 0.85, ...KIND_TO_EXT.makefile, signals }
  }
  if (looksLikeYaml(text)) {
    signals.push("yaml-keys")
    return { kind: "yaml", confidence: 0.85, ...KIND_TO_EXT.yaml, signals }
  }
  // SQL must come BEFORE CSV — a SQL script with INSERT/UPDATE statements
  // can have consistent comma counts per line and trigger CSV detection.
  if (looksLikeSql(text)) {
    signals.push("sql-verbs")
    return { kind: "sql", confidence: 0.85, ...KIND_TO_EXT.sql, signals }
  }
  if (looksLikeCsv(text)) {
    signals.push("csv-columns")
    return { kind: "csv", confidence: 0.88, ...KIND_TO_EXT.csv, signals }
  }
  if (looksLikeTsv(text)) {
    signals.push("tsv-columns")
    return { kind: "tsv", confidence: 0.86, ...KIND_TO_EXT.tsv, signals }
  }
  // .env files — KEY=VALUE on every non-comment line. Must come BEFORE INI
  // because INI's "key=value" branch also matches plain .env files. INI is
  // only the canonical answer when explicit [sections] are present.
  if (looksLikeEnvFile(text)) {
    signals.push("env-key-value")
    return { kind: "env_file", confidence: 0.82, ...KIND_TO_EXT.env_file, signals }
  }
  if (looksLikeIni(text)) {
    signals.push("ini-sections")
    return { kind: "ini", confidence: 0.8, ...KIND_TO_EXT.ini, signals }
  }
  if (looksLikeShellSession(text)) {
    signals.push("shell-prompts")
    return { kind: "shell_session", confidence: 0.8, ...KIND_TO_EXT.shell_session, signals }
  }
  if (looksLikeLog(text)) {
    signals.push("log-timestamps")
    return { kind: "log", confidence: 0.82, ...KIND_TO_EXT.log, signals }
  }
  if (looksLikeTranscript(text)) {
    signals.push("speaker-labels")
    return { kind: "transcript", confidence: 0.72, ...KIND_TO_EXT.transcript, signals }
  }

  // Code detection: programming-language pattern + low prose density
  const detectedLang = detectProgrammingLanguage(text)
  if (detectedLang) {
    const wordCount = countWords(text)
    const codeChars = (text.match(/[{}();=<>]/g) || []).length
    const ratio = codeChars / Math.max(text.length, 1)
    // Code if symbol density > 1.5% OR explicit code-like signal AND not too prose-y
    if (ratio > 0.015 || wordCount < text.length / 12) {
      signals.push(`lang:${detectedLang}`, `symbol-density:${ratio.toFixed(3)}`)
      const ext = LANGUAGE_TO_EXT[detectedLang] || "txt"
      return {
        kind: "code",
        confidence: 0.85,
        language: detectedLang,
        extension: ext,
        mime: detectedLang === "sql" ? "application/sql" : "text/plain",
        signals,
      }
    }
  }

  // Markdown: light heuristic, only when prose is dominant
  if (looksLikeMarkdown(text)) {
    signals.push("markdown-structure")
    return { kind: "markdown", confidence: 0.75, ...KIND_TO_EXT.markdown, signals }
  }

  signals.push("prose-fallback")
  return { kind: "prose", confidence: 0.6, ...KIND_TO_EXT.prose, signals }
}

// ─── Natural-language detection (best-effort) ────────────────────────
// Tiny stoplist-based detector — chooses among es / en / pt / fr / it
// based on the most-frequent function words in the first 4 KB. Returns
// undefined when no language wins by a clear margin.

const LANGUAGE_STOPWORDS: Record<string, RegExp> = {
  es: /\b(?:el|la|los|las|de|que|y|en|un|una|por|con|para|es|son|del|al|este|esta|como|pero|porque|cuando|donde|también|más|sin|sobre|hasta)\b/gi,
  en: /\b(?:the|of|and|to|in|a|is|that|for|on|with|as|at|by|from|this|but|not|are|or|be|have|has|was|were|will|would|can|should|which|when|where|while)\b/gi,
  pt: /\b(?:o|a|os|as|de|que|e|em|um|uma|por|com|para|é|são|do|da|dos|das|este|esta|como|mas|porque|quando|onde|também|mais|sem|sobre|até)\b/gi,
  fr: /\b(?:le|la|les|de|et|à|un|une|que|en|dans|pour|sur|avec|est|sont|du|des|au|aux|ce|cette|ces|comme|mais|pourquoi|quand|où|aussi|plus|sans)\b/gi,
  it: /\b(?:il|la|i|gli|le|di|che|e|in|un|una|per|con|sono|è|del|della|dei|delle|al|alla|come|ma|perché|quando|dove|anche|più|senza|su|fino)\b/gi,
  de: /\b(?:der|die|das|den|dem|des|und|in|zu|auf|von|für|mit|ist|sind|war|waren|wird|werden|sein|hat|haben|nicht|ein|eine|einen|dass|wenn|aber|als|auch|nur|noch|sehr|über|durch|zwischen|gegen|sich|nach|vor)\b/gi,
  ru: /\b(?:и|в|не|на|я|быть|он|с|что|а|по|это|она|к|но|они|мы|как|из|у|вы|за|для|то|так|же|от|или|до|если|или|когда|уже|еще|был|есть|очень|такой|который|при|без|над|после)\b/gi,
}

// Character-class detectors for non-Latin scripts. These do not need
// stopwords because the script itself is a near-perfect language signal.
const SCRIPT_DETECTORS: Array<{ lang: string; pattern: RegExp; minRatio: number }> = [
  // Hiragana + Katakana strongly imply Japanese. Even with kanji-only text,
  // typical Japanese prose has hiragana particles within 200 chars.
  { lang: "ja", pattern: /[぀-ゟ゠-ヿ]/g, minRatio: 0.04 },
  // Hangul → Korean
  { lang: "ko", pattern: /[가-힯ᄀ-ᇿ㄰-㆏]/g, minRatio: 0.05 },
  // CJK Unified Ideographs → Chinese (fallback after Japanese check)
  { lang: "zh", pattern: /[一-鿿]/g, minRatio: 0.05 },
  // Cyrillic → Russian / Ukrainian / etc. (heuristic, ru is most common)
  { lang: "ru", pattern: /[Ѐ-ӿ]/g, minRatio: 0.05 },
  // Arabic
  { lang: "ar", pattern: /[؀-ۿݐ-ݿ]/g, minRatio: 0.05 },
  // Hebrew
  { lang: "he", pattern: /[֐-׿]/g, minRatio: 0.05 },
  // Devanagari (Hindi/Sanskrit/Marathi)
  { lang: "hi", pattern: /[ऀ-ॿ]/g, minRatio: 0.05 },
]

export function detectNaturalLanguage(text: string): string | undefined {
  const sample = text.slice(0, 4000)

  // Script-based detection runs first for non-Latin alphabets. Japanese must
  // win over Chinese when both ideographs and kana coexist.
  const printable = sample.replace(/\s/g, "")
  if (printable.length >= 16) {
    for (const { lang, pattern, minRatio } of SCRIPT_DETECTORS) {
      const matches = sample.match(pattern)
      const count = matches ? matches.length : 0
      if (count / printable.length >= minRatio) return lang
    }
  }

  if (countWords(sample) < 12) return undefined
  let best: { lang: string; score: number } = { lang: "", score: 0 }
  for (const [lang, pattern] of Object.entries(LANGUAGE_STOPWORDS)) {
    const matches = sample.match(pattern)
    const score = matches ? matches.length : 0
    if (score > best.score) best = { lang, score }
  }
  // Require a meaningful margin and absolute hit count
  if (best.score < 4) return undefined
  return best.lang
}

// ─── Cheap content hash for dedup downstream ─────────────────────────
// 32-bit FNV-1a — collisions don't matter for "is this the exact same
// paste we already turned into a doc this minute" use cases. Keep the
// implementation pure and dependency-free so it works in the browser.
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function estimateTokens(text: string): number {
  // Rough heuristic mirroring tiktoken behavior: ~4 chars per token for
  // English/Spanish prose, slightly higher for code with symbols.
  return Math.ceil(text.length / 4)
}

function estimateReadingMinutes(text: string): number {
  const words = countWords(text)
  // Average adult reading speed: 220 wpm for prose. Round up to whole min.
  return Math.max(1, Math.ceil(words / 220))
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

  // Rich-content detection layer — runs on every paste so downstream
  // knows whether the user pasted JSON, code, a stack trace, etc.
  // Filename extension follows the detected kind so the OpenAI Files
  // API and the backend mime-router treat the upload correctly.
  const detection = detectPastedContentKind(text)
  const detectedLanguage = detectNaturalLanguage(text)
  const slug = slugifyTitle(title)
  const filename = buildFilename({ slug, safeTimestamp, detection })

  return {
    kind: "long_paste_document",
    title,
    filename,
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
    contentKind: detection.kind,
    contentKindConfidence: detection.confidence,
    programmingLanguage: detection.language,
    detectedMime: detection.mime,
    detectedLanguage,
    detectionSignals: detection.signals,
    estimatedTokens: estimateTokens(text),
    estimatedReadingMinutes: estimateReadingMinutes(text),
    contentHash: fnv1aHash(text),
  }
}

function buildFilename(args: {
  slug: string
  safeTimestamp: string
  detection: ContentKindDetection
}): string {
  const { slug, safeTimestamp, detection } = args
  // Dockerfile is special — it's the canonical filename, not an extension.
  if (detection.kind === "dockerfile") return `${slug}-${safeTimestamp}.Dockerfile`
  if (detection.kind === "code") {
    const ext = detection.extension || detection.language || "code"
    if (EXECUTABLE_CODE_EXTENSIONS.has(ext.toLowerCase())) {
      return `${slug}-${safeTimestamp}.${ext}.txt`
    }
  }
  // Prose / unknown stays on the historical .txt extension to preserve
  // existing test expectations and downstream mime routing.
  if (detection.kind === "prose") return `${slug}-${safeTimestamp}.txt`
  return `${slug}-${safeTimestamp}.${detection.extension}`
}

export function createLongPasteDocumentFile(input: string, now: Date = new Date()): FileWithLongPaste {
  const metadata = buildLongPasteMetadata(input, now)
  // The File MIME defaults to "text/plain" for backwards-compat, but
  // when the detector is highly confident AND upload-policy-safe we let
  // the detected MIME flow through so the backend pipeline can pick the
  // right parser. Unsupported structured MIME types still travel as
  // text/plain with rich metadata attached, avoiding false upload rejects.
  const mime =
    metadata.detectedMime && (metadata.contentKindConfidence ?? 0) >= 0.85
      && UPLOAD_SAFE_DETECTED_MIMES.has(metadata.detectedMime)
      ? metadata.detectedMime
      : "text/plain"

  const file = new File([metadata.text], metadata.filename, {
    type: mime,
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

const KIND_TO_HUMAN: Record<PastedContentKind, string> = {
  prose: "documento de texto",
  markdown: "documento markdown",
  json: "documento JSON",
  jsonl: "dataset JSON Lines",
  yaml: "documento YAML",
  csv: "dataset CSV",
  tsv: "dataset TSV",
  html: "documento HTML",
  xml: "documento XML",
  sql: "script SQL",
  log: "archivo de log",
  stack_trace: "stack trace",
  code: "fragmento de código",
  shell_session: "sesión de terminal",
  diff: "diff/patch",
  ini: "archivo de configuración INI",
  dockerfile: "Dockerfile",
  ssh_key: "clave SSH",
  pem_certificate: "certificado PEM",
  transcript: "transcripción",
  email_thread: "hilo de correo",
  jupyter_notebook: "Jupyter notebook",
  mermaid_diagram: "diagrama Mermaid",
  kubernetes_manifest: "manifiesto Kubernetes",
  openapi_spec: "especificación OpenAPI",
  graphql_schema: "esquema GraphQL",
  bibtex: "bibliografía BibTeX",
  latex: "documento LaTeX",
  makefile: "Makefile",
  env_file: "archivo .env",
}

export function buildFileOnlyPrompt(files: any[]): string {
  const longPasteDocs = files
    .map(file => getLongPasteMetadata(file))
    .filter((metadata): metadata is LongPasteMetadata => Boolean(metadata))

  if (longPasteDocs.length === 1) {
    const meta = longPasteDocs[0]
    const pages = meta.estimatedPages ? ` (~${meta.estimatedPages} páginas)` : ''
    const structure = meta.structuralScore && meta.structuralScore > 3 ? ' (texto con estructura jerárquica detectada)' : ''
    const kind = meta.contentKind && meta.contentKind !== 'prose'
      ? `${KIND_TO_HUMAN[meta.contentKind]} adjunto "${meta.title}"`
      : `documento de texto adjunto "${meta.title}"`
    const langHint = meta.programmingLanguage ? ` (lenguaje detectado: ${meta.programmingLanguage})` : ''
    return `Analiza el ${kind}${pages}${structure}${langHint} y responde según el contexto del hilo.`
  }

  if (longPasteDocs.length > 1) {
    // Group by kind for a more informative summary
    const counts = new Map<PastedContentKind, number>()
    longPasteDocs.forEach(doc => {
      const k = (doc.contentKind || 'prose') as PastedContentKind
      counts.set(k, (counts.get(k) || 0) + 1)
    })
    const summary = Array.from(counts.entries())
      .map(([k, n]) => `${n} ${KIND_TO_HUMAN[k]}${n > 1 ? 's' : ''}`)
      .join(', ')
    return `Analiza los ${longPasteDocs.length} archivos adjuntos (${summary}) y responde según el contexto del hilo.`
  }

  return "Analiza los archivos adjuntos y responde según el contexto del hilo."
}
