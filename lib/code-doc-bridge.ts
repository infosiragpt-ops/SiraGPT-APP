/**
 * code-doc-bridge — pure logic for the bidirectional /chat ↔ /code document
 * bridge (Frente 6).
 *
 * Two flows, both built so the network seam is injected and every decision
 * here is unit-testable without jsdom or a backend:
 *
 *   1. Doc → Code ("Enviar a tarea /code"): the /chat document editor pushes
 *      the current Markdown into a Codex project as `docs/<nombre>.md` via
 *      the existing importFiles endpoint.
 *
 *   2. Code → Doc ("Abrir en editor de documentos"): a workspace file is read
 *      back from the Codex project and materialised as an editable File in
 *      the /chat documents surface through POST /files/documents.
 *
 * Everything mirrors the backend budgets it must respect:
 *   - codex importFiles: 500 chars/path, 500 KB/file, 5 MB/request total
 *     (backend/src/routes/codex.js IMPORT_MAX_*).
 *   - files edit route: 2 MB content ceiling (backend/src/routes/files.js
 *     POST /:id/edit), reused as the create-document ceiling.
 */

/** Default directory inside the Codex project where pushed docs land. */
export const DOC_IMPORT_DIR = "docs"

/** Backend budget mirrors — kept in one place so UI copy can quote them. */
export const CODEX_IMPORT_MAX_FILE_BYTES = 500 * 1024
export const CODEX_IMPORT_MAX_TOTAL_BYTES = 5 * 1024 * 1024
export const DOC_CONTENT_MAX_CHARS = 2_000_000

export type BridgeErrorCode =
  | "empty_content"
  | "too_large"
  | "no_project"
  | "no_path"
  | "network_error"
  | "unknown_error"

const ERROR_MESSAGES: Record<BridgeErrorCode, string> = {
  empty_content: "El documento está vacío.",
  too_large: "El contenido excede el tamaño máximo permitido.",
  no_project: "No hay un proyecto activo del Agente.",
  no_path: "No se pudo resolver la ruta del documento.",
  network_error: "No se pudo contactar al servidor.",
  unknown_error: "Error desconocido.",
}

/** Single error type both flows throw, so callers branch on `.code`. */
export class DocBridgeError extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, detail?: string) {
    const message = detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code]
    super(message)
    this.name = "DocBridgeError"
    this.code = code
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * UTF-8 byte length of a string. Uses TextEncoder when available (browsers,
 * Node ≥ 11) and falls back to a manual UTF-8 walk so the pure core also runs
 * in runtimes without the global.
 */
export function utf8ByteLength(text: string): number {
  if (!text) return 0
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length
  }
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.codePointAt(i) as number
    if (codePoint > 0xffff) i += 1 // surrogate pair consumed as one
    if (codePoint < 0x80) bytes += 1
    else if (codePoint < 0x800) bytes += 2
    else if (codePoint < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * Normalize any user/attachment name to a safe markdown filename:
 * drops a trailing document extension (.md / .markdown / .txt / .docx) and
 * always appends `.md`, strips path separators and control characters, and
 * yields a non-empty basename.
 *
 *   "Informe Q3.docx"  → "Informe Q3.md"      (docx source becomes md)
 *   "notas.markdown"   → "notas.md"
 *   "../../etc/passwd" → "....etcpasswd.md"   (separators removed)
 *   ""                 → "documento.md"
 */
export function docFileNameForImport(rawName: string): string {
  const cleaned = String(rawName || "")
    .replace(/[\\/]+/g, "") // no path traversal — basename only
    .replace(/[\u0000-\u001f<>:"|?*]/g, "") // control + reserved chars
    .trim()
  const base = cleaned.replace(/\.(md|markdown|txt|docx)$/i, "").trim()
  const safeBase = base || "documento"
  return `${safeBase.slice(0, 120)}.md`
}

/** Join a relative subdirectory with a filename into a project-relative path. */
function joinDocPath(fileName: string, dir: string): string {
  // Segment-wise sanitation: drop empty / "." / ".." segments so neither
  // traversal nor absolute-looking paths survive.
  const segments = String(dir || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && !/^\.+$/.test(segment))
  return segments.length ? `${segments.join("/")}/${fileName}` : fileName
}

// ── Flow 1: Document editor → Codex project ──────────────────────────────

export type ImportableFile = { path: string; content: string }

export type DocToCodeDeps = {
  /** Active Codex project id, resolved by the caller (event singleton or picker). */
  projectId: string | null
  /** Human/attachment name of the edited document. */
  fileName: string
  /** Current editor Markdown. */
  markdown: string
  /**
   * Optional override of the target subdirectory (defaults to `docs`).
   * Exposed for tests; production callers keep the default.
   */
  directory?: string
  /** Transport seam — mirrors projectsCodexApi.importFiles. */
  importFiles: (projectId: string, files: ImportableFile[]) => Promise<{ ok?: boolean; written?: number }>
}

export type DocToCodeResult = { path: string; projectId: string }

/** Build (and validate) the import payload without sending anything. */
export function buildDocImportPayload(options: {
  fileName: string
  markdown: string
  directory?: string
}): ImportableFile {
  const content = typeof options.markdown === "string" ? options.markdown : ""
  if (!content.trim()) throw new DocBridgeError("empty_content")
  if (content.length > DOC_CONTENT_MAX_CHARS) throw new DocBridgeError("too_large")
  const fileName = docFileNameForImport(options.fileName)
  return { path: joinDocPath(fileName, options.directory ?? DOC_IMPORT_DIR), content }
}

/**
 * Push the current document Markdown into a Codex project. Throws
 * DocBridgeError("no_project") when there is no active project so callers can
 * open their picker instead.
 */
export async function sendDocumentToCode(deps: DocToCodeDeps): Promise<DocToCodeResult> {
  const projectId = String(deps.projectId || "").trim()
  if (!projectId) throw new DocBridgeError("no_project")

  const file = buildDocImportPayload({
    fileName: deps.fileName,
    markdown: deps.markdown,
    directory: deps.directory,
  })

  try {
    await deps.importFiles(projectId, [file])
  } catch (error) {
    if (error instanceof DocBridgeError) throw error
    const message = error instanceof Error ? error.message : undefined
    throw new DocBridgeError(
      message && /fetch|network|timeout/i.test(message) ? "network_error" : "unknown_error",
      message,
    )
  }
  return { path: file.path, projectId }
}

// ── Flow 2: Codex project file → /chat editable document ──────────────────

export type CreateDocumentInput = {
  name: string
  content: string
}

export type CreatedDocument = {
  fileId: string
  filename: string
  versionId: string | null
}

export type CodeToDocDeps = {
  projectId: string
  /** Workspace-relative path of the file inside the Codex project. */
  filePath: string
  /** Transport seams mirroring codexApi.readFileContent / apiClient.createDocument. */
  readFileContent: (projectId: string, path: string) => Promise<{ content?: string | null }>
  createDocument: (input: CreateDocumentInput) => Promise<CreatedDocument>
}

export type CodeToDocResult = CreatedDocument & { path: string }

/** Map a workspace path to the human document title used by the File row. */
export function docTitleFromWorkspacePath(filePath: string): string {
  const raw = String(filePath || "").trim()
  if (!raw) throw new DocBridgeError("no_path")
  const base = raw.split("/").filter(Boolean).pop() as string
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim()
  return safe || "documento.md"
}

/**
 * Read a file from the Codex project and persist it as an editable document
 * in the /chat files surface. Only text-ish files make sense as documents;
 * the caller's menu should gate on the extension, but the size/content guard
 * here is the hard stop.
 */
export async function openCodeFileInEditor(deps: CodeToDocDeps): Promise<CodeToDocResult> {
  const projectId = String(deps.projectId || "").trim()
  const filePath = String(deps.filePath || "").trim()
  if (!filePath) throw new DocBridgeError("no_path")

  let content: string
  try {
    const result = await deps.readFileContent(projectId, filePath)
    content = typeof result?.content === "string" ? result.content : ""
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined
    throw new DocBridgeError(
      message && /fetch|network|timeout/i.test(message) ? "network_error" : "unknown_error",
      message,
    )
  }
  if (!content.trim()) throw new DocBridgeError("empty_content")
  if (content.length > DOC_CONTENT_MAX_CHARS || utf8ByteLength(content) > DOC_CONTENT_MAX_CHARS) {
    throw new DocBridgeError("too_large")
  }

  try {
    const created = await deps.createDocument({ name: docTitleFromWorkspacePath(filePath), content })
    return { ...created, path: filePath }
  } catch (error) {
    if (error instanceof DocBridgeError) throw error
    const message = error instanceof Error ? error.message : undefined
    throw new DocBridgeError(
      message && /fetch|network|timeout/i.test(message) ? "network_error" : "unknown_error",
      message,
    )
  }
}
