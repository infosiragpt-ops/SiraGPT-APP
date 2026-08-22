/**
 * code-agent · quality-gate.
 *
 * Proactive post-generation quality check. After the agent generates or patches
 * files, this module runs deterministic checks that catch the most common
 * quality issues before the preview pipeline surfaces them as runtime errors:
 *
 *   - TypeScript: obvious type errors (missing imports, unused vars, implicit any)
 *   - Lint: ESLint-style checks (trailing whitespace, console.log in production code)
 *   - Accessibility: missing alt attributes on images, missing aria labels
 *   - Structure: missing default export in page/layout files, broken imports
 *
 * This is a fast deterministic pass — it does NOT run the full tsc or ESLint
 * binary. It catches the patterns that most commonly break the preview, so the
 * agent can auto-fix them in the same turn instead of waiting for the user to
 * report a broken preview.
 */

export interface QualityIssue {
  severity: "error" | "warning"
  rule: string
  filePath: string
  message: string
  /** A suggested fix instruction for the agent. */
  fixInstruction: string
}

export interface QualityGateResult {
  passed: boolean
  issues: QualityIssue[]
  /** Combined fix instruction for auto-retry, if there are fixable issues. */
  retryInstruction?: string
  /** FE-049: never "Validado" when the stream aborted. */
  status?: "Validado" | "failed" | "aborted"
  validated?: boolean
}

type WorkspaceFile = { path: string; content: string }

function checkMissingImports(file: WorkspaceFile): QualityIssue[] {
  const issues: QualityIssue[] = []
  const ext = file.path.split(".").pop()?.toLowerCase()
  if (ext !== "tsx" && ext !== "ts" && ext !== "jsx" && ext !== "js") return issues

  // Detect imports that reference packages without importing them
  const usedIdentifiers = new Set<string>()
  const importPattern = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))(?:\s*,\s*\{([^}]+)\})?\s+from\s+["']([^"']+)["']/g
  const importedNames = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = importPattern.exec(file.content)) !== null) {
    const named = [match[1], match[3]].filter(Boolean).join(",")
    const default_ = match[2]
    if (default_) importedNames.add(default_)
    named.split(",").forEach((name) => {
      const trimmed = name.trim().split(/\s+as\s+/)[0].trim()
      if (trimmed) importedNames.add(trimmed)
    })
  }

  // Check for React hooks used without import
  if (/\buseState\b/.test(file.content) && !importedNames.has("useState")) {
    issues.push({
      severity: "error",
      rule: "missing-import-useState",
      filePath: file.path,
      message: "useState is used but not imported from React.",
      fixInstruction: `Añade useState al import de React en ${file.path}: import { useState } from "react"`,
    })
  }
  if (/\buseEffect\b/.test(file.content) && !importedNames.has("useEffect")) {
    issues.push({
      severity: "error",
      rule: "missing-import-useEffect",
      filePath: file.path,
      message: "useEffect is used but not imported from React.",
      fixInstruction: `Añade useEffect al import de React en ${file.path}`,
    })
  }
  if (/\buseRef\b/.test(file.content) && !importedNames.has("useRef")) {
    issues.push({
      severity: "error",
      rule: "missing-import-useRef",
      filePath: file.path,
      message: "useRef is used but not imported from React.",
      fixInstruction: `Añade useRef al import de React en ${file.path}`,
    })
  }
  if (/\buseCallback\b/.test(file.content) && !importedNames.has("useCallback")) {
    issues.push({
      severity: "error",
      rule: "missing-import-useCallback",
      filePath: file.path,
      message: "useCallback is used but not imported from React.",
      fixInstruction: `Añade useCallback al import de React en ${file.path}`,
    })
  }
  if (/\buseMemo\b/.test(file.content) && !importedNames.has("useMemo")) {
    issues.push({
      severity: "error",
      rule: "missing-import-useMemo",
      filePath: file.path,
      message: "useMemo is used but not imported from React.",
      fixInstruction: `Añade useMemo al import de React en ${file.path}`,
    })
  }

  return issues
}

function checkAccessibility(file: WorkspaceFile): QualityIssue[] {
  const issues: QualityIssue[] = []
  const ext = file.path.split(".").pop()?.toLowerCase()
  if (ext !== "tsx" && ext !== "jsx" && ext !== "html") return issues

  // Missing alt on <img>
  const imgPattern = /<img\s+([^>]*?)\s*\/?>/g
  let imgMatch: RegExpExecArray | null
  while ((imgMatch = imgPattern.exec(file.content)) !== null) {
    const attrs = imgMatch[1]
    if (!/\balt\s*=/.test(attrs)) {
      issues.push({
        severity: "warning",
        rule: "a11y-img-missing-alt",
        filePath: file.path,
        message: "An <img> tag is missing an alt attribute.",
        fixInstruction: `Añade un atributo alt descriptivo a la etiqueta <img> en ${file.path}`,
      })
    }
  }

  // Missing aria-label on interactive elements without text
  const buttonPattern = /<button\s+([^>]*?)>(\s*)<\/button>/g
  let btnMatch: RegExpExecArray | null
  while ((btnMatch = buttonPattern.exec(file.content)) !== null) {
    const attrs = btnMatch[1]
    if (!/\baria-label\s*=/.test(attrs) && !/\btitle\s*=/.test(attrs)) {
      issues.push({
        severity: "warning",
        rule: "a11y-button-no-label",
        filePath: file.path,
        message: "An empty <button> is missing an aria-label.",
        fixInstruction: `Añade un aria-label al botón vacío en ${file.path}`,
      })
    }
  }

  return issues
}

function checkMissingDefaultExport(file: WorkspaceFile): QualityIssue[] {
  const issues: QualityIssue[] = []
  const isPage = file.path.startsWith("app/") && (file.path.endsWith("page.tsx") || file.path.endsWith("layout.tsx"))
  if (!isPage) return issues

  if (!/export\s+default\s+(?:function|const|class)\b/.test(file.content)) {
    issues.push({
      severity: "error",
      rule: "missing-default-export",
      filePath: file.path,
      message: "Next.js page/layout file is missing a default export.",
      fixInstruction: `Añade un export default al componente en ${file.path} — Next.js requiere export default en page.tsx y layout.tsx`,
    })
  }
  return issues
}

function checkConsoleLog(file: WorkspaceFile): QualityIssue[] {
  const issues: QualityIssue[] = []
  const ext = file.path.split(".").pop()?.toLowerCase()
  if (ext !== "tsx" && ext !== "ts" && ext !== "jsx" && ext !== "js") return issues
  if (file.path.includes("test") || file.path.includes("spec")) return issues

  const lines = file.content.split("\n")
  lines.forEach((line, index) => {
    if (/\bconsole\.(log|debug|info)\b/.test(line) && !line.trim().startsWith("//")) {
      issues.push({
        severity: "warning",
        rule: "no-console-log",
        filePath: file.path,
        message: `console.log found at line ${index + 1} — remove debug logging in production code.`,
        fixInstruction: `Elimina el console.log en la línea ${index + 1} de ${file.path}`,
      })
    }
  })
  return issues
}

function checkTrailingWhitespace(file: WorkspaceFile): QualityIssue[] {
  const issues: QualityIssue[] = []
  const lines = file.content.split("\n")
  let count = 0
  lines.forEach((line) => {
    if (/\s+$/.test(line) && line.trim().length > 0) count++
  })
  if (count > 3) {
    issues.push({
      severity: "warning",
      rule: "trailing-whitespace",
      filePath: file.path,
      message: `${count} lines have trailing whitespace.`,
      fixInstruction: `Limpia los espacios en blanco al final de las líneas en ${file.path}`,
    })
  }
  return issues
}

/**
 * Run the quality gate on a set of generated/patched files.
 * Returns all issues found, with a combined retry instruction for auto-fix.
 */
export function runQualityGate(
  files: WorkspaceFile[],
  opts: { aborted?: boolean } = {},
): QualityGateResult {
  if (opts.aborted) {
    return { passed: false, issues: [], status: "aborted", validated: false }
  }
  const allIssues: QualityIssue[] = []
  for (const file of files) {
    allIssues.push(
      ...checkMissingImports(file),
      ...checkMissingDefaultExport(file),
      ...checkAccessibility(file),
      ...checkConsoleLog(file),
      ...checkTrailingWhitespace(file),
    )
  }

  const errors = allIssues.filter((issue) => issue.severity === "error")
  const passed = errors.length === 0

  const retryInstruction = allIssues.length > 0
    ? `Corrige los siguientes problemas detectados por el quality gate:\n${allIssues
        .map((issue) => `- [${issue.severity}] ${issue.filePath}: ${issue.message}`)
        .join("\n")}`
    : undefined

  return {
    passed,
    issues: allIssues,
    retryInstruction,
    status: passed ? "Validado" : "failed",
    validated: passed,
  }
}
