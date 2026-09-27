/**
 * transport-security — keep the canonical host on https.
 *
 * Cloudflare serves siragpt.com over plain http as well (there is no
 * "Always Use HTTPS" rule at the edge): a page loaded as http://siragpt.com
 * then calls the API with `Origin: http://siragpt.com`, which the backend
 * CORS allowlist rejects — prod 2026-09-27, /api/users/settings →
 * «CORS: origin not allowed (http://siragpt.com)». The middleware redirects
 * such page loads to https once (308) and pins returning browsers there with
 * Strict-Transport-Security.
 *
 * Only Cloudflare's `CF-Visitor` header is trusted for the visitor scheme:
 * the origin proxy rewrites `X-Forwarded-Proto` to the scheme IT received
 * (always http behind the tunnel). Without CF-Visitor (local dev, CI, direct
 * origin access) nothing changes.
 */

export const DEFAULT_CANONICAL_HOSTS = ['siragpt.com', 'www.siragpt.com'] as const
export const HSTS_HEADER_VALUE = 'max-age=31536000'

type HeaderReader = { get(name: string): string | null }

export function canonicalHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.SIRAGPT_CANONICAL_HOSTS
  const hosts = raw
    ? raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
    : [...DEFAULT_CANONICAL_HOSTS]
  return new Set(hosts)
}

/** Scheme the visitor used at Cloudflare's edge; null when not behind Cloudflare. */
export function visitorScheme(headers: HeaderReader): 'http' | 'https' | null {
  const raw = headers.get('cf-visitor')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { scheme?: unknown }
    const scheme = String(parsed?.scheme ?? '').toLowerCase()
    return scheme === 'http' || scheme === 'https' ? scheme : null
  } catch {
    return null
  }
}

export function requestHost(headers: HeaderReader): string {
  const raw = headers.get('x-forwarded-host') || headers.get('host') || ''
  return raw.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '')
}

/** https URL to redirect to, or null when the request is already safe or not ours. */
export function insecureCanonicalRedirectTarget(
  request: { method: string; headers: HeaderReader; url: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  if (visitorScheme(request.headers) !== 'http') return null
  const host = requestHost(request.headers)
  if (!canonicalHosts(env).has(host)) return null
  const current = new URL(request.url)
  return `https://${host}${current.pathname}${current.search}`
}

/** HSTS value for https responses on the canonical host; null otherwise. */
export function hstsHeaderValueFor(headers: HeaderReader, env: NodeJS.ProcessEnv = process.env): string | null {
  if (visitorScheme(headers) !== 'https') return null
  if (!canonicalHosts(env).has(requestHost(headers))) return null
  return HSTS_HEADER_VALUE
}
