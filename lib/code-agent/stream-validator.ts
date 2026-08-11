/**
 * code-agent · stream-validator.
 *
 * Deterministic post-stream validation. After the LLM streams a file, this
 * module checks the content for common structural errors that would break the
 * preview: broken code fences, invalid JSON, unclosed JSX tags, truncated
 * output. When an issue is found it returns a retry instruction so the caller
 * can auto-retry with a targeted fix prompt instead of surfacing the broken
 * file to the user.
 */

export interface StreamValidationResult {
  valid: boolean
  /** When invalid, a targeted instruction for the retry prompt. */
  retryInstruction?: string
  /** Human-readable summary of what was wrong. */
  issue?: string
}

/** Check for broken/unclosed code fences in streamed content. */
function checkCodeFences(content: string): string | null {
  const fenceCount = (content.match(/^```/gm) || []).length
  if (fenceCount % 2 !== 0) {
    const openFences = content.match(/^```[a-zA-Z]*\s*$/gm) || []
    const closeFences = content.match(/^```\s*$/gm) || []
    if (openFences.length > closeFences.length) {
      return "El contenido tiene code fences abiertos sin cerrar (```). Verifica que cada bloque de código cierre con ```."
    }
    return "El contenido tiene code fences desbalanceados. Revisa que cada ``` de apertura tenga su ``` de cierre."
  }
  return null
}

/** Check for obviously truncated JSON content. */
function checkJson(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
  if (!trimmed.endsWith("}") && !trimmed.endsWith("]")) {
    return "El JSON está truncado — no termina con } o ]. Completa el objeto JSON."
  }
  try {
    JSON.parse(trimmed)
    return null
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err)
    return `JSON inválido: ${msg}. Corrige la sintaxis y devuelve JSON válido completo.`
  }
}

/** Check for unclosed JSX tags (very common in streamed React components). */
function checkUnclosedJsx(content: string): string | null {
  const opens = content.match(/<[A-Z][A-Za-z0-9]*(?:\s[^>]*?)?(?<!\/)>/g) || []
  const selfClosing = content.match(/<[A-Z][A-Za-z0-9]*(?:\s[^>]*?)?\/>/g) || []
  const closes = content.match(/<\/[A-Z][A-Za-z0-9]*>/g) || []
  const expectedCloses = opens.length
  const actualCloses = closes.length
  if (expectedCloses > actualCloses + selfClosing.length) {
    const unclosed = opens.slice(actualCloses)
    const firstUnclosed = unclosed[0]?.match(/<([A-Z][A-Za-z0-9]*)/)?.[1]
    return firstUnclosed
      ? `Hay etiquetas JSX sin cerrar. La primera es <${firstUnclosed}>. Cierra todas las etiquetas JSX abiertas con su </${firstUnclosed}> correspondiente.`
      : "Hay etiquetas JSX sin cerrar. Verifica que cada componente tenga su etiqueta de cierre."
  }
  return null
}

/** Check for obvious truncation: file ends mid-expression. */
function checkTruncation(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  const lastChar = trimmed[trimmed.length - 1]
  const last30 = trimmed.slice(-30)
  // Ends mid-statement without proper closure
  if (
    lastChar === "," ||
    lastChar === "{" ||
    lastChar === "[" ||
    lastChar === "(" ||
    lastChar === "=" ||
    lastChar === "+" ||
    lastChar === "|"
  ) {
    return `El contenido parece truncado (termina con "${lastChar}"). Completa el archivo hasta su cierre natural. Últimos caracteres: ...${last30}`
  }
  // Ends mid-string
  if (
    (trimmed.endsWith('"') && (trimmed.match(/"/g) || []).length % 2 !== 0) ||
    (trimmed.endsWith("'") && (trimmed.match(/'/g) || []).length % 2 !== 0) ||
    (trimmed.endsWith("`") && (trimmed.match(/`/g) || []).length % 2 !== 0)
  ) {
    return `El contenido termina con un string sin cerrar. Completa el string y el resto del archivo. Últimos caracteres: ...${last30}`
  }
  return null
}

/**
 * Validate a streamed file's content. Returns { valid: true } when the content
 * passes all checks, or a retry instruction when an issue is found.
 */
export function validateStreamedFile(filePath: string, content: string): StreamValidationResult {
  if (!content || content.trim().length === 0) {
    return {
      valid: false,
      issue: "Archivo vacío",
      retryInstruction: `El archivo ${filePath} está vacío. Genera el contenido completo del archivo.`,
    }
  }

  const ext = filePath.split(".").pop()?.toLowerCase()

  const fenceIssue = checkCodeFences(content)
  if (fenceIssue) {
    return { valid: false, issue: fenceIssue, retryInstruction: fenceIssue }
  }

  const truncationIssue = checkTruncation(content)
  if (truncationIssue) {
    return { valid: false, issue: truncationIssue, retryInstruction: truncationIssue }
  }

  if (ext === "json") {
    const jsonIssue = checkJson(content)
    if (jsonIssue) {
      return { valid: false, issue: jsonIssue, retryInstruction: jsonIssue }
    }
  }

  if (ext === "tsx" || ext === "jsx" || ext === "ts" || ext === "js") {
    const jsxIssue = checkUnclosedJsx(content)
    if (jsxIssue) {
      return { valid: false, issue: jsxIssue, retryInstruction: jsxIssue }
    }
  }

  return { valid: true }
}

/**
 * Validate a batch of streamed files. Returns the first failure found, or
 * { valid: true } if all files pass.
 */
export function validateStreamedFiles(
  files: Array<{ path: string; content: string }>,
): StreamValidationResult {
  for (const file of files) {
    const result = validateStreamedFile(file.path, file.content)
    if (!result.valid) return result
  }
  return { valid: true }
}

/** Max auto-retry attempts per file to prevent infinite loops. */
export const MAX_STREAM_RETRIES = 2
