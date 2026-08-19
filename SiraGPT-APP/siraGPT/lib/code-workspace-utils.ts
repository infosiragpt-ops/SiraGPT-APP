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

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXT_LANG[ext] || "plaintext"
}

/** Normalise path separators and strip a leading slash. */
export function normalizePath(input: string): string {
  if (!input) return ""
  return input.replace(/\\/g, "/").replace(/^\/+/, "").trim()
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

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g

/**
 * Extract fenced code blocks from a markdown-ish string and best-effort
 * infer the target file path. We support three signal styles common in
 * coding-assistant outputs:
 *
 *   1. Fence info string includes a path:
 *      ```tsx app/code/page.tsx
 *   2. Fence info string is the path itself:
 *      ```app/code/page.tsx
 *   3. First content line is `// path: app/code/page.tsx` (or `# path:` for shells).
 *
 * Anything else falls back to language-only and `path: null`, which the
 * UI renders as "no apply target".
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  if (!text) return []
  const blocks: CodeBlock[] = []
  let match: RegExpExecArray | null
  let i = 0
  FENCE_RE.lastIndex = 0
  while ((match = FENCE_RE.exec(text)) !== null) {
    const info = (match[1] || "").trim()
    let body = match[2] || ""

    let language = "plaintext"
    let path: string | null = null

    if (info) {
      const parts = info.split(/\s+/).filter(Boolean)
      const first = parts[0]
      if (first && /[./]/.test(first) && !/^[a-z0-9+\-]+$/.test(first)) {
        // Fence info is a path (style 2).
        path = normalizePath(first)
        language = languageForPath(path)
        if (parts[1]) language = parts[1]
      } else if (first) {
        language = first
        const candidate = parts.slice(1).join(" ").trim()
        if (candidate) path = normalizePath(candidate)
      }
    }

    if (!path) {
      const firstLine = body.split("\n", 1)[0] || ""
      const m =
        firstLine.match(/^\s*\/\/\s*path:\s*(.+)\s*$/i) ||
        firstLine.match(/^\s*#\s*path:\s*(.+)\s*$/i)
      if (m) {
        path = normalizePath(m[1])
        body = body.replace(/^.*\n/, "")
        if (language === "plaintext") language = languageForPath(path)
      }
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
  // do not produce noise. The middle is rendered as a series of
  // removed-then-added pairs which is good enough for short files.
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

  for (const line of aMid) {
    result.push({ kind: "removed", text: line, oldNumber: oldNo++ })
  }
  for (const line of bMid) {
    result.push({ kind: "added", text: line, newNumber: newNo++ })
  }

  for (let i = a.length - suffix; i < a.length; i++) {
    result.push({ kind: "kept", text: a[i], oldNumber: oldNo++, newNumber: newNo++ })
  }

  return result
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
      ].join("\n"),
    },
  ]
}
