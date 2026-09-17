const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

export type CodeSegment = { type: "text" | "url"; value: string }

export function looksLikePlainOcrText(language: string, code: string): boolean {
  const lang = String(language || "text").toLowerCase()
  if (lang !== "text" && lang !== "plaintext" && lang !== "plain") return false
  const trimmed = String(code || "").trim()
  if (!trimmed) return true
  const lines = trimmed.split(/\n/).filter(Boolean)
  const hasUrl = /https?:\/\/[^\s<>"'`]+/i.test(trimmed)
  if (lines.length <= 3 && hasUrl) return true
  return lines.length <= 2 && trimmed.length < 240
}

export function splitCodeWithUrls(code: string): CodeSegment[] {
  const text = String(code || "")
  if (!text) return []
  const segments: CodeSegment[] = []
  let last = 0
  const re = new RegExp(URL_RE.source, "gi")
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (match.index > last) {
      segments.push({ type: "text", value: text.slice(last, match.index) })
    }
    const raw = match[0].replace(/[),.;:]+$/, "")
    const trailing = match[0].slice(raw.length)
    segments.push({ type: "url", value: raw })
    if (trailing) segments.push({ type: "text", value: trailing })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) })
  return segments
}

export function hrefForCodeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.toString()
  } catch {
    return null
  }
}
