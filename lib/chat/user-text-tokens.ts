/**
 * Tokeniser for what the user typed: links, e-mails, file names, timecodes
 * and inline code are recognised so the bubble can render them as what they
 * are (a celeste link, a mono file chip, a tabular timecode) instead of flat
 * text. Pure and deterministic — the renderer lives in
 * components/chat/rich-user-text.tsx.
 */

export type UserTextToken =
  | { type: "text"; value: string }
  | { type: "url"; value: string; href: string; display: string }
  | { type: "email"; value: string; href: string }
  | { type: "file"; value: string; ext: string }
  | { type: "timecode"; value: string }
  | { type: "code"; value: string }

const FILE_EXTENSIONS =
  "docx|doc|dotx|pptx|ppt|potx|xlsx|xlsm|xls|csv|tsv|pdf|txt|md|rtf|odt|ods|odp|epub|png|jpe?g|gif|webp|svg|heic|bmp|tiff?|mp3|mp4|m4a|m4v|wav|ogg|opus|flac|aac|mov|mkv|webm|avi|zip|rar|7z|tar|gz|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|mjs|cjs|py|ipynb|sql|sh|bat|ps1|java|kt|swift|go|rs|rb|php|c|cpp|h|hpp|cs|sav|dta|parquet|ics|vcf|srt|vtt"

// One alternation so tokens never overlap; order = precedence.
const TOKEN_RE = new RegExp(
  [
    "(?<code>`[^`\\n]{1,200}`)",
    "(?<url>https?:\\/\\/[^\\s<>\"'`]+|(?<![\\w@/.])www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+(?:\\/[^\\s<>\"'`]*)?)",
    "(?<email>[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+)",
    // No spaces inside a name: «informe final.docx» chips «final.docx», which
    // beats swallowing the sentence before it.
    `(?<file>(?<![\\w/.\\-])[\\w\\-]+(?:\\.[\\w\\-]+)*\\.(?:${FILE_EXTENSIONS})(?![\\w/]))`,
    "(?<timecode>(?<![\\d:])\\d{1,2}:\\d{2}(?::\\d{2})?(?![\\d:]))",
  ].join("|"),
  "giu",
)

/** A link pasted inside a sentence often drags the closing punctuation along. */
function trimUrl(raw: string): { url: string; rest: string } {
  let url = raw
  let rest = ""
  // Peel one trailing character at a time; a ")" that balances a "(" inside
  // the URL (wikipedia-style) belongs to the link and stops the peeling.
  while (url.length) {
    const ch = url[url.length - 1]
    if (!/[.,;:!?»"'”’)\]}]/.test(ch)) break
    if (ch === ")" && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break
    url = url.slice(0, -1)
    rest = ch + rest
  }
  return { url, rest }
}

/** «upn.class.com/player/recording/1d17…» — host plus a bounded path. */
export function displayUrl(href: string, maxLength = 56): string {
  let host = ""
  let path = ""
  try {
    const parsed = new URL(href.startsWith("http") ? href : `https://${href}`)
    host = parsed.hostname.replace(/^www\./, "")
    path = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/$/, "")
  } catch {
    return href.length > maxLength ? `${href.slice(0, maxLength - 1)}…` : href
  }
  if (!path || path === "/") return host
  const room = Math.max(12, maxLength - host.length)
  if (path.length <= room) return `${host}${path}`
  return `${host}${path.slice(0, room - 1)}…`
}

export function tokenizeUserText(input: string): UserTextToken[] {
  const text = String(input ?? "")
  if (!text) return []
  const tokens: UserTextToken[] = []
  let last = 0
  const pushText = (value: string) => {
    if (!value) return
    const prev = tokens[tokens.length - 1]
    if (prev && prev.type === "text") prev.value += value
    else tokens.push({ type: "text", value })
  }
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0
    const groups = match.groups || {}
    pushText(text.slice(last, index))
    const raw = match[0]
    if (groups.code) {
      tokens.push({ type: "code", value: raw.slice(1, -1) })
    } else if (groups.url) {
      const { url, rest } = trimUrl(raw)
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`
      tokens.push({ type: "url", value: url, href, display: displayUrl(href) })
      pushText(rest)
    } else if (groups.email) {
      tokens.push({ type: "email", value: raw, href: `mailto:${raw}` })
    } else if (groups.file) {
      const ext = (raw.match(/\.([A-Za-z0-9]+)$/) || [])[1] || ""
      tokens.push({ type: "file", value: raw, ext: ext.toLowerCase() })
    } else if (groups.timecode) {
      tokens.push({ type: "timecode", value: raw })
    } else {
      pushText(raw)
    }
    last = index + raw.length
  }
  pushText(text.slice(last))
  return tokens
}

/** True when the text holds anything beyond plain words (cheap gate for the renderer). */
export function hasRichUserTokens(input: string): boolean {
  return tokenizeUserText(input).some((token) => token.type !== "text")
}
