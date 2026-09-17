type RenderableChatMessage = {
  role?: unknown
  content?: unknown
  files?: unknown
  error?: unknown
  progressStage?: unknown
}

function asRenderableMessage(message: unknown): RenderableChatMessage | null {
  return message && typeof message === "object" ? message as RenderableChatMessage : null
}

export function parseMessageFilesForRender(files: unknown): unknown[] {
  if (!files) return []
  const hidden = (item: unknown) => Boolean(item && typeof item === 'object' && (item as { deletedAt?: unknown }).deletedAt)
  const visible = (items: unknown[]) => items.some(hidden) ? items.filter(item => !hidden(item)) : items
  if (Array.isArray(files)) return visible(files)
  if (typeof files !== "string") return []

  try {
    const parsed: unknown = JSON.parse(files)
    return Array.isArray(parsed) ? visible(parsed) : []
  } catch {
    return []
  }
}

/** Hiding an attachment must also hide its own inline preview/download link. */
export function contentWithoutHiddenImages(content: unknown, files: unknown): string {
  const source = typeof content === 'string' ? content : content == null ? '' : String(content)
  let entries = files
  try { if (typeof entries === 'string') entries = JSON.parse(entries) } catch { return source }
  if (!Array.isArray(entries)) return source
  const assetKey = (value: string) => {
    const raw = value.replace(/&amp;/g, '&').trim()
    // Local assets can appear with a legacy backend origin or a filename query.
    // Their entire path, never a substring/prefix, identifies the saved asset.
    try {
      const url = new URL(raw, 'https://siragpt.local')
      if (/^\/(?:uploads\/|api\/agent\/artifact\/)/.test(url.pathname)) return url.pathname
    } catch { /* non-URL values are compared exactly */ }
    return raw
  }
  const hidden = new Set<string>()
  for (const file of entries) {
    if (!file?.deletedAt || !(file.type === 'image' || /^image\//.test(file.mimeType || file.mime || file.type || ''))) continue
    for (const value of [file.url, file.imageUrl, file.downloadUrl, file.download_url, file.preview, file.thumbnailUrl]) {
      if (typeof value === 'string' && value.trim()) hidden.add(assetKey(value))
    }
    const artifact = String(file.fileId || file.id || '').match(/^artifact:([a-f0-9]{6,64})$/i)?.[1]
    if (artifact) hidden.add(`/api/agent/artifact/${artifact}`)
  }
  if (!hidden.size) return source
  const isHidden = (value: string) => hidden.has(assetKey(value))
  const references = new Set<string>()
  const referenceKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  let result = source.replace(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))[^\n]*$/gm, (match, label, angled, raw) => {
    if (!isHidden(angled || raw)) return match
    references.add(referenceKey(label))
    return ''
  })
  // Destination matching includes parentheses in generated filenames.
  result = result.replace(/(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s()]*(?:\([^\s()]*\)[^\s()]*)*))(?:\s+["'][^\n]*?["'])?\s*\)/g, (match, image, label, angled, raw) => isHidden(angled || raw) ? (image ? '' : label) : match)
  result = result.replace(/(!?)\[([^\]\n]*)\]\[([^\]\n]*)\]/g, (match, image, label, ref) => references.has(referenceKey(ref || label)) ? (image ? '' : label) : match)
  result = result.replace(/!\[([^\]\n]+)\]/g, (match, ref) => references.has(referenceKey(ref)) ? '' : match)
  result = result.replace(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (match, double, single, raw) => isHidden(double || single || raw) ? '' : match)
  result = result.replace(/<(https?:\/\/[^>\s]+|\/(?:uploads|api\/agent\/artifact)\/[^>\s]+)>/g, (match, url) => isHidden(url) ? '' : match)
  result = result.replace(/https?:\/\/[^\s<>"']+|\/(?:uploads|api\/agent\/artifact)\/[^\s<>"']+/g, (url) => {
    if (isHidden(url)) return ''
    const bare = url.replace(/[.,;!?]+$/, '')
    return isHidden(bare) ? url.slice(bare.length) : url
  })
  return result
}

export function hasMessageTextForRender(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  if (content == null) return false
  return String(content).trim().length > 0
}

export function shouldRenderChatMessage(
  message: unknown,
  allowEmptyStreamingAssistant = false,
): boolean {
  const candidate = asRenderableMessage(message)
  if (!candidate) return false

  const role = String(candidate.role || "").toUpperCase()
  if (role === "USER") return true
  if (candidate.error || candidate.progressStage) return true
  if (hasMessageTextForRender(contentWithoutHiddenImages(candidate.content, candidate.files))) return true
  if (parseMessageFilesForRender(candidate.files).length > 0) return true
  return allowEmptyStreamingAssistant && role === "ASSISTANT"
}

export function isAssistantMessage(message: unknown): boolean {
  const candidate = asRenderableMessage(message)
  return String(candidate?.role || "").toUpperCase() === "ASSISTANT"
}


/** OLA200_WAVE_G FE-069 — memoize markdown parse so a long chat does not freeze on scroll. */
const _mdCache = new Map<string, string>()
const MD_CACHE_MAX = 128
export function markdownParseCacheKey(source: string): string {
  const text = String(source || "")
  return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`
}
export function memoizedParseMarkdown(source: string, parse: (input: string) => string = (input) => input): string {
  const key = markdownParseCacheKey(source)
  const hit = _mdCache.get(key)
  if (hit !== undefined) return hit
  const value = parse(String(source || ""))
  if (_mdCache.size >= MD_CACHE_MAX) { const first = _mdCache.keys().next().value; if (first !== undefined) _mdCache.delete(first) }
  _mdCache.set(key, value)
  return value
}
