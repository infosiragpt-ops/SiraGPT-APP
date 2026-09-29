/**
 * Admin → Logs: shared copy formats for every tab («Fallos de respuesta»,
 * «Errores del sistema», «Registros en vivo», «Auditoría»).
 *
 * Each tab maps its rows to a `CopyRecord` (headline + labelled fields + the
 * raw row) and every format is rendered from that one shape, so a selection
 * copies the same way wherever the operator is.
 */

export type CopyFormat = "texto" | "mensaje" | "markdown" | "json" | "tabla"

export const COPY_FORMATS: ReadonlyArray<{ value: CopyFormat; label: string; hint: string }> = [
  { value: "texto", label: "Texto", hint: "Legible, con todos los campos" },
  { value: "mensaje", label: "Solo mensaje", hint: "Una línea por elemento" },
  { value: "markdown", label: "Markdown", hint: "Para pegar en un chat o un ticket" },
  { value: "json", label: "JSON", hint: "Datos completos, sin recortar" },
  { value: "tabla", label: "Tabla (Excel)", hint: "Columnas separadas por tabulador" },
]

export const DEFAULT_COPY_FORMAT: CopyFormat = "texto"

export function isCopyFormat(value: unknown): value is CopyFormat {
  return typeof value === "string" && COPY_FORMATS.some((f) => f.value === value)
}

export type CopyField = readonly [label: string, value: unknown]

export type CopyRecord = {
  id: string
  /** ISO timestamp (or anything Date can parse). */
  at?: string | number | null
  headline: string
  fields: CopyField[]
  /** Full untruncated row for the JSON format. */
  raw?: unknown
}

function formatAt(at: CopyRecord["at"]): string {
  if (at == null || at === "") return ""
  const d = new Date(at)
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(at)
}

export function fieldText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(", ")
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function presentFields(record: CopyRecord): Array<[string, string]> {
  return record.fields
    .map(([label, value]) => [label, fieldText(value).trim()] as [string, string])
    .filter(([, value]) => value.length > 0)
}

function indent(text: string, pad: string): string {
  return text.replace(/\n/g, `\n${pad}`)
}

function tableCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim()
}

function markdownInline(value: string): string {
  return value.replace(/\|/g, "\\|")
}

export function formatRecords(records: CopyRecord[], format: CopyFormat): string {
  if (!records.length) return ""
  switch (format) {
    case "mensaje":
      return records.map((r) => r.headline.replace(/\s*\n\s*/g, " ").trim()).join("\n")
    case "json": {
      const payload = records.map((r) => (r.raw !== undefined ? r.raw : { id: r.id, at: formatAt(r.at), headline: r.headline, ...Object.fromEntries(presentFields(r)) }))
      try {
        return JSON.stringify(payload.length === 1 ? payload[0] : payload, null, 2)
      } catch {
        return String(payload)
      }
    }
    case "tabla": {
      const labels: string[] = []
      for (const r of records) {
        for (const [label] of r.fields) if (!labels.includes(label)) labels.push(label)
      }
      const header = ["Fecha", "Resumen", ...labels].join("\t")
      const rows = records.map((r) => {
        const byLabel = new Map(r.fields.map(([label, value]) => [label, fieldText(value)]))
        return [formatAt(r.at), r.headline, ...labels.map((l) => byLabel.get(l) ?? "")].map(tableCell).join("\t")
      })
      return [header, ...rows].join("\n")
    }
    case "markdown":
      return records
        .map((r) => {
          const when = formatAt(r.at)
          const lines = [`### ${r.headline.replace(/\s*\n\s*/g, " ").trim()}`]
          if (when) lines.push(`- **Fecha:** ${when}`)
          for (const [label, value] of presentFields(r)) {
            if (value.includes("\n") || value.length > 160) {
              lines.push(`- **${label}:**`, "", "```", value.replace(/```/g, "ʼʼʼ"), "```")
            } else {
              lines.push(`- **${label}:** ${markdownInline(value)}`)
            }
          }
          return lines.join("\n")
        })
        .join("\n\n")
    case "texto":
    default:
      return records
        .map((r) => {
          const when = formatAt(r.at)
          const head = when ? `[${when}] ${r.headline}` : r.headline
          const body = presentFields(r).map(([label, value]) => `  ${label}: ${indent(value, "    ")}`)
          return [head, ...body].join("\n")
        })
        .join("\n\n")
  }
}

/**
 * Shift+click range selection over an ordered id list. Toggling the target
 * decides the direction: a range that ends on an unselected id selects it,
 * one that ends on a selected id clears it. Pure — returns a new set.
 */
export function toggleSelection(
  orderedIds: string[],
  prev: ReadonlySet<string>,
  id: string,
  anchor: string | null,
  range: boolean,
): Set<string> {
  const next = new Set(prev)
  if (range && anchor && anchor !== id) {
    const a = orderedIds.indexOf(anchor)
    const b = orderedIds.indexOf(id)
    if (a >= 0 && b >= 0) {
      const select = !prev.has(id)
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        if (select) next.add(orderedIds[i])
        else next.delete(orderedIds[i])
      }
      return next
    }
  }
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * Clipboard write that survives the browsers and contexts where the async
 * Clipboard API is missing or refuses (http origins, embedded frames,
 * permission denied): falls back to a hidden textarea + execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  if (typeof document === "undefined") return false
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.top = "-9999px"
  area.style.opacity = "0"
  document.body.appendChild(area)
  const previous = document.activeElement as HTMLElement | null
  try {
    area.select()
    return typeof document.execCommand === "function" ? document.execCommand("copy") : false
  } catch {
    return false
  } finally {
    area.remove()
    try { previous?.focus?.() } catch { /* ignore */ }
  }
}

/** True while the operator has highlighted text with the mouse. */
export function hasTextSelection(): boolean {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return false
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
}

export function downloadText(text: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  if (!text || typeof document === "undefined") return
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function fileExtensionFor(format: CopyFormat): string {
  if (format === "json") return "json"
  if (format === "markdown") return "md"
  if (format === "tabla") return "tsv"
  return "log"
}
