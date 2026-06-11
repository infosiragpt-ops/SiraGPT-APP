/**
 * link-preview client — fetches OpenGraph-style metadata for a URL from the
 * backend route `GET /api/link-preview?url=<enc>`.
 *
 * Design goals:
 * - Never throws: ANY failure (network, non-200, invalid JSON, timeout,
 *   external abort) resolves to `null` so callers can degrade silently.
 * - Timeout via an internal AbortController, chained with an optional
 *   caller-provided AbortSignal.
 * - `fetchImpl` injectable for tests.
 */

export interface LinkPreview {
  url: string
  title: string | null
  faviconUrl: string | null
  imageUrl: string | null
}

export interface FetchLinkPreviewOptions {
  /** Abort the request after this many milliseconds (default 6000). */
  timeoutMs?: number
  /** External signal chained with the internal timeout controller. */
  signal?: AbortSignal
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 6000

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Fetch a link preview from the backend. Resolves to `null` on any error —
 * previews are decorative, so failures must never surface to the user.
 */
export async function fetchLinkPreview(
  url: string,
  opts: FetchLinkPreviewOptions = {},
): Promise<LinkPreview | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, fetchImpl } = opts
  // Wrap the global fetch in a lambda so it keeps its expected `this`.
  const doFetch: typeof fetch =
    fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  if (signal?.aborted) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await doFetch(
      `/api/link-preview?url=${encodeURIComponent(url)}`,
      { method: 'GET', signal: controller.signal },
    )
    if (!response || !response.ok) return null

    const data: unknown = await response.json()
    if (!data || typeof data !== 'object') return null

    const record = data as Record<string, unknown>
    return {
      url: coerceString(record.url) ?? url,
      title: coerceString(record.title),
      faviconUrl: coerceString(record.faviconUrl),
      imageUrl: coerceString(record.imageUrl),
    }
  } catch {
    // Timeout, network failure, invalid JSON, abort — all degrade to null.
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Last-resort favicon via Google's public favicon service. Returns `null`
 * only when no hostname can be derived from the input.
 */
export function faviconFallbackUrl(url: string): string | null {
  let host: string | null = null
  try {
    host = new URL(url).hostname
  } catch {
    // Tolerate bare hosts like "example.com" (no scheme).
    try {
      host = new URL(`https://${url}`).hostname
    } catch {
      host = null
    }
  }
  if (!host) return null
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
}
