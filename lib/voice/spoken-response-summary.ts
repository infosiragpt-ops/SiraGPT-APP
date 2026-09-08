const DEFAULT_MAX_CHARS = 640
const SHORT_RESPONSE_CHARS = 520

function normalizeLine(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_~`>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function clampSentence(value: string, max = 180): string {
  const chars = Array.from(value.trim())
  if (chars.length <= max) return value.trim()
  const clipped = chars.slice(0, max).join("")
  const boundary = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf(";"),
    clipped.lastIndexOf(","),
    clipped.lastIndexOf(" "),
  )
  return `${clipped.slice(0, boundary > max * 0.55 ? boundary : max).trim()}…`
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLocaleLowerCase("es")
    if (!value || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Produces a concise spoken rendering from an already-generated answer.
 *
 * This is intentionally extractive: it only reuses sentences and bullets from
 * the response, so playing an audio summary can never introduce a new claim.
 */
export function buildSpokenResponseSummary(
  markdown: string,
  { maxChars = DEFAULT_MAX_CHARS }: { maxChars?: number } = {},
): string {
  const source = String(markdown || "").trim()
  if (!source) return ""

  const withoutCode = source
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`[^`\n]+`/g, " código ")
  const lines = withoutCode
    .split(/\r?\n/)
    .map((line) => ({
      raw: line.trim(),
      text: normalizeLine(line),
      bullet: /^\s*(?:[-+*]|\d+[.)])\s+/.test(line),
      heading: /^\s*#{1,6}\s+/.test(line),
    }))
    .filter((line) => line.text)

  const full = normalizeLine(withoutCode)
  if (full.length <= SHORT_RESPONSE_CHARS) return full

  const paragraphs = unique(
    lines
      .filter((line) => !line.heading && !line.bullet)
      .map((line) => clampSentence(line.text, 210)),
  )
  const bullets = unique(
    lines
      .filter((line) => line.bullet)
      .map((line) => clampSentence(line.text.replace(/^\d+[.)]\s*/, ""), 135)),
  )

  const selected = [
    paragraphs[0],
    ...bullets.slice(0, 3),
    paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : null,
  ].filter((value): value is string => Boolean(value))

  const spoken = `Resumen de la respuesta. ${unique(selected).join(". ")}`
    .replace(/\.\s*\./g, ".")
    .trim()
  const bounded = clampSentence(spoken, Math.max(220, Math.min(900, maxChars)))
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`
}
