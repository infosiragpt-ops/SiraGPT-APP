/**
 * Pure helpers for the /code workspace. Kept side-effect-free so the
 * context provider can stay declarative and tests (or future tests)
 * can exercise these in isolation.
 */

export type CodeFile = {
  path: string
  language: string
  content: string
  /** Last update timestamp (ms). Used for tab ordering hints. */
  updatedAt: number
}

export type CodeFiles = Record<string, CodeFile>

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  txt: "plaintext",
}

export function joinWorkspacePath(...parts: string[]): string {
  const joined = parts.map((p) => String(p || "").replace(/\\/g, "/")).filter(Boolean).join("/")
  const normalized = joined.replace(/\/+/g, "/")
  if (!normalized) return ""
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("workspace_path_absolute")
  }
  const segs: string[] = []
  for (const seg of normalized.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") throw new Error("workspace_path_escape")
    segs.push(seg)
  }
  return segs.join("/")
}

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXT_LANG[ext] || "plaintext"
}

/**
 * Normalise path separators, strip a leading slash, and resolve `.` / `..`
 * segments so the result always stays INSIDE the workspace root. Leftover
 * `..` with no parent to pop are dropped: a workspace key can never escape
 * the root (Zip Slip guard for exportWorkspaceAsZip).
 */
export function normalizePath(input: string): string {
  if (!input) return ""
  const raw = input.replace(/\\/g, "/").replace(/^\/+/, "").trim()
  if (!raw) return ""
  const segs: string[] = []
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") segs.pop()
    else segs.push(seg)
  }
  return segs.join("/")
}

/**
 * Detect whether the current browser exposes the File System Access API
 * (Chromium-only at the time of writing). Useful to render a banner
 * + visible export option for Safari/Firefox users whose changes only
 * persist in localStorage and can't sync to a real folder on disk.
 */
export function browserSupportsLocalFolderSync(): boolean {
  if (typeof window === "undefined") return false
  return typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
}

/**
 * Bundle the entire workspace into a downloadable ZIP. The jszip
 * import is dynamic on purpose: it's ~250 KB minified, and most users
 * never click "Export" — keeping it out of the initial /code chunk
 * avoids paying that cost on first paint.
 */
export async function exportWorkspaceAsZip(files: CodeFiles): Promise<Blob> {
  const JSZipModule = await import("jszip")
  const JSZip = (JSZipModule as { default?: typeof import("jszip") }).default
    ?? (JSZipModule as unknown as typeof import("jszip"))
  const zip = new JSZip()
  for (const file of Object.values(files)) {
    const path = normalizePath(file.path) || file.path
    if (!path) continue
    zip.file(path, file.content ?? "")
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" })
}

/** Build a stable filename for the exported ZIP. */
export function workspaceExportFilename(label = "siragpt-code-workspace"): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")
  return `${label}-${stamp}.zip`
}

export type CodeBlock = {
  language: string
  /** Optional path inferred from the block (// path: foo.tsx, language=foo.tsx, etc.). */
  path: string | null
  content: string
  /** Block index inside the source string. Kept for stable keys. */
  index: number
}

/** A fence line: up to 3 spaces of indent, 3+ backticks, optional info string. */
const FENCE_LINE_RE = /^ {0,3}(`{3,})([^`]*)$/

function looksLikeSourcePath(value: string): boolean {
  const cleaned = String(value || "").replace(/^["'`]+|["'`]+$/g, "").trim()
  if (!cleaned || cleaned.length > 180 || /\s/.test(cleaned)) return false
  if (cleaned.includes("://")) return false
  return /(?:^|\/)[\w.-]+\.[a-z0-9]{1,8}$/i.test(cleaned)
}

function extractPathComment(line: string): string | null {
  const m =
    line.match(/^\s*\/\/\s*(?:path|filepath|file)\s*:\s*(.+?)\s*$/i) ||
    line.match(/^\s*#\s*(?:path|file)\s*:\s*(.+?)\s*$/i) ||
    line.match(/^\s*\{\s*filename\s*=\s*["']([^"']+)["']\s*\}\s*$/i) ||
    line.match(/^\s*\/\/\s+((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8})\s*$/i)
  if (!m) return null
  const candidate = m[1].replace(/^["'`]+|["'`]+$/g, "").trim()
  return looksLikeSourcePath(candidate) ? normalizePath(candidate) : null
}

function extractPathHeading(line: string): string | null {
  const stripped = String(line || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^(?:file|archivo)\s*:\s*/i, "")
    .trim()
  return looksLikeSourcePath(stripped) ? normalizePath(stripped) : null
}

/**
 * Extract fenced code blocks from a markdown-ish string and best-effort
 * infer the target file path. We support three signal styles common in
 * coding-assistant outputs:
 *
 *   1. Fence info string includes a path:
 *      ```tsx app/code/page.tsx
 *   2. Fence info string is the path itself:
 *      ```app/code/page.tsx
 *   3. First content line is `// path:`, `// filepath:`, `// File:`,
 *      `# path:`, `{filename="..."}`, or a lone `// src/App.tsx`.
 *   4. The markdown heading immediately above the fence is a file path.
 *
 * Anything else falls back to language-only and `path: null`, which the
 * UI renders as "no apply target".
 *
 * Nesting-aware: a generated README.md often embeds ```bash blocks. The old
 * regex closed the outer block at the FIRST ``` it found, truncating the file
 * and turning the leftover text into phantom blocks. This line-based parser:
 *
 *   - Supports 4+ backtick outer fences (CommonMark): only a bare fence at
 *     least as long as the opener closes the block; inner ``` are content.
 *   - For 3-backtick fences, tracks inner open fences: a fence line WITH an
 *     info string opens an inner block (content), and a bare ``` first closes
 *     any open inner block before it can close the outer one.
 *
 * A block left unclosed at EOF is dropped, matching the previous regex
 * behaviour (streaming callers rely on incomplete trailing blocks not
 * producing partial files).
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  if (!text) return []
  const blocks: CodeBlock[] = []
  const lines = text.split("\n")
  let lineNo = 0
  let i = 0
  while (lineNo < lines.length) {
    const open = lines[lineNo].match(FENCE_LINE_RE)
    const fenceLineIndex = lineNo
    lineNo++
    if (!open) continue

    const fenceLen = open[1].length
    const info = (open[2] || "").trim()

    const bodyLines: string[] = []
    let innerOpen = 0
    let closed = false
    while (lineNo < lines.length) {
      const line = lines[lineNo]
      const fence = line.match(FENCE_LINE_RE)
      if (fence) {
        const len = fence[1].length
        const innerInfo = (fence[2] || "").trim()
        if (!innerInfo && len >= fenceLen && innerOpen === 0) {
          // Bare fence, long enough, no inner block pending → closes the block.
          closed = true
          lineNo++
          break
        }
        if (fenceLen === 3) {
          // Track 3-backtick nesting so a README with ```bash blocks doesn't
          // close at the first inner ```.
          if (innerInfo) innerOpen++
          else if (innerOpen > 0) innerOpen--
        }
      }
      bodyLines.push(line)
      lineNo++
    }
    if (!closed) break

    let body = bodyLines.join("\n")

    let language = "plaintext"
    let path: string | null = null

    if (info) {
      const parts = info.split(/\s+/).filter(Boolean)
      const first = parts[0]
      const named = info.match(/\b(?:file(?:name)?|path)\s*=\s*["']?([^\s"']+)/i)?.[1]
      if (named && looksLikeSourcePath(named)) {
        path = normalizePath(named)
        language = first && /^[a-z0-9+\-]+$/i.test(first) ? first : languageForPath(path)
      } else if (first && /[./]/.test(first) && !/^[a-z0-9+\-]+$/.test(first)) {
        // Fence info is a path (style 2).
        path = normalizePath(first)
        language = languageForPath(path)
        if (parts[1]) language = parts[1]
      } else if (first) {
        language = first
        const candidate = parts.slice(1).join(" ").trim()
        // Style 1 must look like a real path, same bar as the other
        // styles — otherwise prose after the language ("```ts aquí va
        // la explicación") becomes an apply target.
        if (candidate && looksLikeSourcePath(candidate)) path = normalizePath(candidate)
      }
    }

    if (!path) {
      const firstLine = body.split("\n", 1)[0] || ""
      const fromComment = extractPathComment(firstLine)
      if (fromComment) {
        path = fromComment
        body = body.split("\n").slice(1).join("\n")
        if (language === "plaintext") language = languageForPath(path)
      }
    }

    if (!path) {
      const heading = lines[fenceLineIndex - 1] || ""
      const fromHeading = extractPathHeading(heading)
      if (fromHeading) path = fromHeading
    }

    if (path && language === "plaintext") language = languageForPath(path)

    blocks.push({
      language,
      path,
      content: body.replace(/\n+$/, ""),
      index: i++,
    })
  }
  return blocks
}

/**
 * Tiny line-based diff for the apply/diff UI. Not a full Myers diff —
 * we only need to flag added / removed / kept lines so the user can
 * preview a change before accepting it. We pair lines by index up to
 * the shared length and emit added/removed for the tail.
 */
export type DiffLine = {
  kind: "added" | "removed" | "kept"
  text: string
  oldNumber?: number
  newNumber?: number
}

export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")

  // Trivial common-prefix / common-suffix shortcut so identical files
  // do not produce noise. The remaining middle is matched with a real
  // LCS over lines so a single edited function inside a large file no
  // longer renders as "delete everything + re-add everything".
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const result: DiffLine[] = []
  let oldNo = 1
  let newNo = 1

  for (let i = 0; i < prefix; i++) {
    result.push({ kind: "kept", text: a[i], oldNumber: oldNo++, newNumber: newNo++ })
  }

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)

  // LCS DP table over the middle. Guarded by a cell budget: past it the
  // table alone would be hundreds of MB, so we fall back to the old
  // remove-all-then-add-all pairing (still correct, just coarser).
  const cells = aMid.length * bMid.length
  if (cells > MAX_DIFF_CELLS || cells === 0) {
    emitFallback(aMid, bMid, result, () => oldNo++, () => newNo++)
  } else {
    emitLcs(aMid, bMid, result, () => oldNo++, () => newNo++)
  }

  for (let i = a.length - suffix; i < a.length; i++) {
    result.push({ kind: "kept", text: a[i], oldNumber: oldNo++, newNumber: newNo++ })
  }

  return result
}

/** Above this many DP cells the LCS falls back to coarse remove/add. */
const MAX_DIFF_CELLS = 4_000_000

function emitLcs(a: string[], b: string[], out: DiffLine[], nextOld: () => number, nextNew: () => number) {
  const n = a.length
  const m = b.length
  // lcs[i][m] = 0 and lcs[n][j] = 0; stored row-major with m+1 columns.
  const width = m + 1
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "kept", text: a[i], oldNumber: nextOld(), newNumber: nextNew() })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ kind: "removed", text: a[i], oldNumber: nextOld() })
      i++
    } else {
      out.push({ kind: "added", text: b[j], newNumber: nextNew() })
      j++
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++], oldNumber: nextOld() })
  while (j < m) out.push({ kind: "added", text: b[j++], newNumber: nextNew() })
}

/** Old behaviour: all removed lines first, then all added lines. */
function emitFallback(a: string[], b: string[], out: DiffLine[], nextOld: () => number, nextNew: () => number) {
  for (const line of a) out.push({ kind: "removed", text: line, oldNumber: nextOld() })
  for (const line of b) out.push({ kind: "added", text: line, newNumber: nextNew() })
}

/** Shallow check used by the chat to decide if "Apply" would be a no-op. */
export function isSameContent(a: string, b: string): boolean {
  return a === b
}

/**
 * Default starter project shipped on first visit. Three small files
 * showcase the three pillars of the workspace: HTML preview (apply
 * + ArtifactPanel), TypeScript code, and a README. The model can
 * also reseed by replacing every entry from chat.
 */
export function defaultStarterFiles(): CodeFile[] {
  const now = Date.now()
  return [
    {
      path: "README.md",
      language: "markdown",
      updatedAt: now,
      content: [
        "# Cursor workspace",
        "",
        "Este es un workspace inspirado en Cursor para programar con IA.",
        "",
        "- Edita archivos en el centro.",
        "- Pide cambios al chat de IA a la izquierda; cuando devuelva código,",
        "  podrás aplicarlo a un archivo y revisar el diff antes de aceptar.",
        "- Usa `index.html` para previsualizar HTML directamente.",
        "",
        "Atajos:",
        "",
        "- Cmd/Ctrl+S guarda el archivo activo localmente.",
        "- Cmd/Ctrl+L pone el foco en el chat de IA.",
        "- Cmd/Ctrl+Shift+P abre la paleta de comandos.",
      ].join("\n"),
    },
    {
      path: "index.html",
      language: "html",
      updatedAt: now,
      content: [
        "<!DOCTYPE html>",
        "<html lang=\"es\">",
        "  <head>",
        "    <meta charset=\"utf-8\" />",
        "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
        "    <title>Hola desde el workspace</title>",
        "    <style>",
        "      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 32px; }",
        "      h1 { font-size: 28px; margin-bottom: 8px; }",
        "      p { color: #555; }",
        "    </style>",
        "  </head>",
        "  <body>",
        "    <h1>Hola, mundo</h1>",
        "    <p>Edita este archivo y pulsa el ojo en la pestaña para previsualizarlo.</p>",
        "  </body>",
        "</html>",
      ].join("\n"),
    },
    {
      path: "app.tsx",
      language: "typescript",
      updatedAt: now,
      content: [
        "// path: app.tsx",
        "import * as React from \"react\"",
        "",
        "export function HelloCard({ name }: { name: string }) {",
        "  return (",
        "    <div style={{ padding: 16, borderRadius: 12, background: \"#f4f4f5\" }}>",
        "      <strong>Hola, {name}</strong>",
        "      <p>Pide al chat que mejore este componente o agregue tests.</p>",
        "    </div>",
        "  )",
        "}",
        "",
        "// El preview en vivo renderiza el componente `App` (o el export default).",
        "export default function App() {",
        "  return (",
        "    <div style={{ padding: 24, fontFamily: \"Inter, system-ui, sans-serif\" }}>",
        "      <h1 style={{ fontSize: 24, marginBottom: 12 }}>👋 Tu app en vivo</h1>",
        "      <HelloCard name=\"mundo\" />",
        "      <p style={{ color: \"#71717a\", marginTop: 16 }}>",
        "        Edita este archivo o pídele cambios al chat — el preview se actualiza solo.",
        "      </p>",
        "    </div>",
        "  )",
        "}",
      ].join("\n"),
    },
  ]
}
