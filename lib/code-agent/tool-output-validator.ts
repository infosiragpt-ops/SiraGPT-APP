/**
 * code-agent · tool-output-validator.
 *
 * Deterministic post-tool-call validation — the complement of stream-validator.
 * stream-validator guards what the MODEL streamed; this module guards what a
 * TOOL CALL returned before the next plan step chains on top of it. Corrupt,
 * truncated or empty tool output is the classic silent killer of agent loops:
 * the step "succeeds", the loop keeps going, and the corruption surfaces much
 * later as a broken preview or a wrong patch. Validating at the chaining point
 * fails fast, cheaply and deterministically (regex / JSON.parse / brace
 * balance only — never an LLM call).
 *
 * Pure and stdlib-only so both the panel and `node --test` can import it.
 */

/** Severity taxonomy for a validated tool output. */
export type ToolOutputSeverity = "empty" | "truncated" | "corrupt" | "ok"

export interface ToolOutputValidation {
  /** true = safe to chain the next step on this result. */
  ok: boolean
  severity: ToolOutputSeverity
  /** Human-readable reason when !ok (first issue found). */
  reason?: string
  /** Targeted instruction to re-run the tool/step that produced this output. */
  retryInstruction?: string
}

export interface ToolOutputValidatorOptions {
  /**
   * Tool names whose EMPTY result is legitimate (e.g. a search that found
   * nothing). Defaults to DEFAULT_EMPTY_OK_TOOLS. Unknown tools keep strict
   * empty detection unless listed here.
   */
  allowEmptyTools?: string[]
  /** Extra tool names treated as content-promising (merged with defaults). */
  expectContentTools?: string[]
  /** Minimum plausible length for a file write (default MIN_FILE_WRITE_LENGTH). */
  minFileWriteLength?: number
}

/**
 * Tools where an empty result is a legitimate answer, not a failure. A search
 * that finds nothing legitimately returns [] or "".
 */
export const DEFAULT_EMPTY_OK_TOOLS: readonly string[] = [
  "search",
  "web_search",
  "search_files",
  "list",
  "grep",
  "glob",
  "find",
]

/**
 * Tool-name fragments that promise real content in their result. An empty
 * string/array/object from one of these is flagged as "empty".
 */
const CONTENT_TOOL_FRAGMENTS: readonly string[] = [
  "read",
  "fetch",
  "get",
  "load",
  "download",
  "cat",
  "open",
  "pull",
  "write",
  "create",
  "generate",
  "build",
  "edit",
  "patch",
  "apply",
]

/** Default minimum plausible length for a file-write tool result. */
export const MIN_FILE_WRITE_LENGTH = 40

// ---- helpers ---------------------------------------------------------------

function normalizeToolName(toolName: string | null | undefined): string {
  return String(toolName == null ? "" : toolName)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function isEmptyValue(output: unknown): boolean {
  if (output == null) return true
  if (typeof output === "string") return output.trim().length === 0
  if (Array.isArray(output)) return output.length === 0
  if (typeof output === "object") {
    const record = output as Record<string, unknown>
    // { content: ... } wrappers are empty iff their inner payload is empty.
    if ("content" in record) return isEmptyValue(record.content)
    if ("text" in record) return isEmptyValue(record.text)
    if ("result" in record) return isEmptyValue(record.result)
    return Object.keys(record).length === 0
  }
  return false
}

/**
 * True when the tool is expected to produce substantive content, so emptiness
 * is a failure rather than a legitimate "no results" answer.
 */
function expectsContent(toolName: string, options?: ToolOutputValidatorOptions): boolean {
  const name = normalizeToolName(toolName)
  if (!name) return false
  if ((options?.allowEmptyTools || []).some((t) => normalizeToolName(t) === name)) return false
  if ((options?.expectContentTools || []).some((t) => normalizeToolName(t) === name)) return true

  const fragment = CONTENT_TOOL_FRAGMENTS.find((f) => name.includes(f))
  if (!fragment) return false
  // "write_file" promises content; "write" alone does not. Require the
  // fragment to be followed by a separator (or end) so e.g. "getx" does not
  // count as a read while "read_file"/"file_get" do.
  const afterFragment = name.slice(name.indexOf(fragment) + fragment.length, name.indexOf(fragment) + fragment.length + 1)
  return afterFragment === "" || afterFragment === "_" || afterFragment === "-"
}

// ---- embedded-error markers -------------------------------------------------

/** Markers that mean the tool's own error leaked into its output field. */
const ERROR_MARKERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^\s*Error:/, label: 'marcador de error "Error:"' },
  { re: /\n\s*at [A-Za-z0-9_$.<>/[\]]+\s*\([^)]*\)/, label: "stack trace embebido" },
  { re: /^\s*(\w*(?:Error|Exception|Failure)\w*)\s*:/, label: "excepción como único contenido" },
  { re: /^(?:Traceback \(most recent call last\)|npm ERR!|yarn error|ERR_PNPM)/m, label: "log de fallo de ejecución" },
  { re: /^\s*(?:Uncaught|UnhandledPromiseRejection|FATAL(?: ERROR)?):/, label: "error fatal en runtime" },
  // Runtime error class OPENING a line ("TypeError: Cannot read…"), not merely
  // mentioned mid-sentence inside useful prose ("…el SyntaxError previo se
  // corrigió…").
  { re: /^\s*(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|EvalError|AssertionError)\s*:/m, label: "error de runtime embebido" },
]

/**
 * The whole output IS the failure report (starts with the marker, or consists
 * almost entirely of stack frames) → corrupt, not just annotated by it.
 */
function isWholeOutputAnError(text: string): string | null {
  for (const { re, label } of ERROR_MARKERS) {
    if (re.test(text)) return label
  }
  // Body made mostly of JS stack frames ("    at fn (file:1:2)") with no
  // other substantial prose — a raw dump, not a usable result.
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length > 0) {
    const frameLines = lines.filter((l) => /^\s{2,}at\s/.test(l)).length
    if (frameLines >= Math.max(2, Math.ceil(lines.length * 0.6))) {
      return "volcado de stack trace"
    }
  }
  return null
}

// ---- binary noise ----------------------------------------------------------

/** NUL bytes or long runs of non-printable characters inside a text field. */
function binaryNoiseReason(text: string): string | null {
  if (/\u0000/.test(text)) return "bytes NUL (binario) dentro del campo de texto"
  const controlRun = text.match(/[\u0001-\u0008\u000e-\u001f]{8,}/)
  if (controlRun) return "secuencia larga de bytes no imprimibles (binario)"
  return null
}

// ---- truncation --------------------------------------------------------------

/**
 * Structural truncation check for text that looks like JSON. Cheap first:
 * balanced braces/brackets outside strings, then JSON.parse as the authority.
 */
function truncatedJsonReason(text: string): string | null {
  const trimmed = text.trim()
  const opensObject = trimmed.startsWith("{") || trimmed.startsWith("[")
  const fencedJson = /^```(?:json)?\s*\{[\s\S]*$/.test(trimmed) || /^```(?:json)?\s*\[[\s\S]*$/.test(trimmed)
  if (!opensObject && !fencedJson) return null

  let balance = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") balance += 1
    else if (ch === "}" || ch === "]") balance -= 1
  }
  if (balance > 0 || inString) {
    const detail = inString ? "termina en mitad de un string" : `${balance} llave(s)/corchete(s) sin cerrar`
    return `La salida JSON está truncada (${detail}).`
  }
  try {
    JSON.parse(stripLeadingFence(trimmed))
  } catch (err) {
    void err
    return "La salida JSON está corrupta y no se puede parsear."
  }
  return null
}

function stripLeadingFence(text: string): string {
  return text.replace(/^```(?:json|js|javascript|ts)?\s*/m, "").replace(/```\s*$/m, "").trim()
}

/** Code that stops mid-block: more opening than closing delimiters. */
function unclosedCodeBlockReason(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length < 20) return null

  // Unclosed markdown/code fence anywhere in the output (not only at the very
  // start): an odd number of ``` lines means the last block never closed.
  const fenceLines = (trimmed.match(/^[ \t]*```/gm) || []).length
  if (fenceLines % 2 !== 0) {
    return "El bloque de código termina sin cerrar su fence ```."
  }

  if (/^```/.test(trimmed)) {
    return null // fenced block is complete; inner balance is not our job here
  }

  // Strip line comments and string literals so braces inside them don't count.
  const stripped = trimmed
    .replace(/\\./g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\/[^\n]*/g, "")
    /* eslint-disable-next-line no-useless-escape -- clearer regex intent for block comments */
    .replace(/\/\*[\s\S]*?\*\//g, "")

  const braces = countChar(stripped, "{") - countChar(stripped, "}")
  const parens = countChar(stripped, "(") - countChar(stripped, ")")
  if (braces > 0) {
    return `El código parece truncado: ${braces} bloque(s) {...} sin cerrar.`
  }
  if (parens > 0) {
    return `El código parece truncado: ${parens} paréntesis sin cerrar.`
  }
  return null
}

function countChar(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

/** Text cut mid-expression: ends on a dangling operator/comma/open bracket. */
function danglingTailReason(text: string): string | null {
  const last = text[text.length - 1]
  if ([",", "{", "[", "(", "=", "+", "|", ":", ";"].includes(last)) {
    return `La salida termina con "${last}", lo que indica un corte a mitad de contenido.`
  }
  return null
}

// ---- main entry point --------------------------------------------------------

/**
 * Validate the RESULT of a tool call before the agent chains the next step.
 * Deterministic and cheap: regexes, length checks, delimiter balancing and
 * JSON.parse. Never calls a model.
 *
 * Severity contract:
 *   - "ok"        → output passes, chain freely ({ ok: true })
 *   - "empty"     → promised content is missing entirely
 *   - "truncated" → output exists but is structurally cut/corrupted JSON/code
 *   - "corrupt"   → output is present but is an error artifact (stack trace,
 *                   embedded error markers, binary noise in a text field)
 */
export function validateToolOutput(
  toolName: string,
  output: unknown,
  options?: ToolOutputValidatorOptions,
): ToolOutputValidation {
  const name = normalizeToolName(toolName)

  // ---- 1) Empty detection ----------------------------------------------------
  if (isEmptyValue(output)) {
    if (expectsContent(name, options)) {
      return {
        ok: false,
        severity: "empty",
        reason: `La herramienta "${toolName}" devolvió un resultado vacío cuando se esperaba contenido.`,
        retryInstruction: `La herramienta "${toolName}" devolvió un resultado vacío. Repite el paso asegurándote de devolver el contenido completo.`,
      }
    }
    return { ok: true, severity: "ok" }
  }

  // Non-string payloads that are neither empty nor strings pass through:
  // structured results (numbers, booleans, arrays of rows) are valid answers.
  if (typeof output !== "string") return { ok: true, severity: "ok" }

  const text = output.trim()

  // ---- 2) Binary noise -------------------------------------------------------
  const binary = binaryNoiseReason(text)
  if (binary) {
    return {
      ok: false,
      severity: "corrupt",
      reason: `La salida contiene ${binary}.`,
      retryInstruction: `La salida de "${toolName}" contiene datos binarios donde se esperaba texto. Repite el paso devolviendo texto limpio.`,
    }
  }

  // ---- 3) Embedded error artifacts ------------------------------------------
  const errorLabel = isWholeOutputAnError(text)
  if (errorLabel) {
    return {
      ok: false,
      severity: "corrupt",
      reason: `La salida es un artefacto de error (${errorLabel}), no un resultado utilizable.`,
      retryInstruction: `La salida de "${toolName}" es un reporte de error (${errorLabel}) en vez del resultado esperado. Repite el paso resolviendo la causa del error.`,
    }
  }

  // ---- 4) Truncation ---------------------------------------------------------
  const jsonTrunc = truncatedJsonReason(text)
  if (jsonTrunc) {
    return {
      ok: false,
      severity: "truncated",
      reason: jsonTrunc,
      retryInstruction: `La salida de "${toolName}" parece cortada o corrupta (${jsonTrunc.replace(/^La salida JSON está /, "")}) Repite el paso devolviendo la salida completa.`,
    }
  }

  const minWrite = options?.minFileWriteLength ?? MIN_FILE_WRITE_LENGTH
  // Length plausibility applies ONLY to tools whose output IS the produced
  // artifact (file/code writes). Build/exec tools legitimately answer with a
  // one-line log ("Build completed in 4.2s"), so they stay out of this gate.
  const outputIsArtifact =
    name.includes("write") || name.includes("create") || name.includes("generate")
  if (outputIsArtifact && text.length < minWrite) {
    return {
      ok: false,
      severity: "empty",
      reason: `El archivo escrito es demasiado corto: ${text.length} caracteres (mínimo plausible: ${minWrite}).`,
      retryInstruction: `La salida de "${toolName}" es demasiado corta para ser un archivo real (${text.length} caracteres). Repite el paso escribiendo el archivo completo.`,
    }
  }

  const unclosed = unclosedCodeBlockReason(text)
  if (unclosed) {
    return {
      ok: false,
      severity: "truncated",
      reason: unclosed,
      retryInstruction: `La salida de "${toolName}" parece incompleta: ${unclosed} Repite el paso devolviendo el contenido completo.`,
    }
  }

  const dangling = danglingTailReason(text)
  if (dangling) {
    return {
      ok: false,
      severity: "truncated",
      reason: dangling,
      retryInstruction: `La salida de "${toolName}" parece truncada. ${dangling} Repite el paso devolviendo el contenido completo.`,
    }
  }

  return { ok: true, severity: "ok" }
}

// ---- sequence chaining -------------------------------------------------------

/** One step of a tool sequence, as consumed by validateAndChain. */
export interface ToolStep {
  /** Tool that ran (or will run). */
  toolName: string
  /** Result it produced. */
  output?: unknown
}

export interface ChainStepResult extends ToolOutputValidation {
  /** Index into the input steps array (present only on failure). */
  index?: number
}

/**
 * Validate a sequence of tool outputs BEFORE each subsequent step runs.
 * Returns the index of the first failed step and its verdict, or
 * { ok: true } when every step is safe to chain. Pure — no side effects.
 */
export function validateAndChain(
  steps: ReadonlyArray<ToolStep>,
  options?: ToolOutputValidatorOptions,
): ChainStepResult {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (!step) continue
    const verdict = validateToolOutput(step.toolName, step.output, options)
    if (!verdict.ok) {
      return { ...verdict, index }
    }
  }
  return { ok: true, severity: "ok" }
}
