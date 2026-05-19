/**
 * Deep link router.
 *
 * Maps `siragpt://` (custom scheme) and `https://siragpt.com/...` (universal
 * link / app link) URLs to internal app routes. Designed to be wired to
 * Capacitor's `App.addListener('appUrlOpen')` event but works just as well
 * for web `window.open` handoffs.
 *
 * Supported schemes:
 *   siragpt://chat/:id          → /chat/:id
 *   siragpt://artifact/:id      → /artifact/:id
 *   siragpt://document/:id      → /documents/:id
 *   siragpt://settings          → /settings
 *   siragpt://?path=/foo        → /foo  (escape hatch)
 *
 * Query parameters are forwarded; unknown hosts produce `null` so the
 * caller can decide whether to no-op or surface an error.
 */

export type DeepLinkRoute = {
  /** Internal app path (always starts with "/"). */
  path: string
  /** Parsed query string (without leading `?`). */
  query: string
  /** Optional anchor (without leading `#`). */
  hash?: string
  /** Raw URL we resolved. */
  raw: string
}

export type DeepLinkHandler = (route: DeepLinkRoute) => void | Promise<void>

const CUSTOM_SCHEME = "siragpt:"
const WEB_HOSTS = new Set(["siragpt.com", "www.siragpt.com"])

/**
 * Parse a deep-link URL into an internal route. Returns null when the URL
 * doesn't belong to this app or cannot be mapped to a known internal route.
 */
export function parseDeepLink(input: string): DeepLinkRoute | null {
  if (typeof input !== "string" || input.length === 0) return null

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }

  // Custom scheme: siragpt://<host>/<rest>
  if (url.protocol === CUSTOM_SCHEME) {
    return parseCustomScheme(url, input)
  }

  // HTTPS web URLs (universal link / app link)
  if ((url.protocol === "https:" || url.protocol === "http:") && WEB_HOSTS.has(url.hostname)) {
    return {
      path: url.pathname || "/",
      query: url.search.replace(/^\?/, ""),
      hash: url.hash ? url.hash.replace(/^#/, "") : undefined,
      raw: input,
    }
  }

  return null
}

function parseCustomScheme(url: URL, raw: string): DeepLinkRoute | null {
  // For custom schemes, URL semantics put the first segment in `hostname`
  // (e.g. siragpt://chat/abc → hostname "chat", pathname "/abc").
  const host = (url.hostname || "").toLowerCase()
  const tail = url.pathname.replace(/^\/+/, "")
  const query = url.search.replace(/^\?/, "")
  const hash = url.hash ? url.hash.replace(/^#/, "") : undefined

  const explicitPath = url.searchParams.get("path")
  if (host === "" && explicitPath) {
    return { path: ensureLeadingSlash(explicitPath), query: stripPathParam(query), hash, raw }
  }

  switch (host) {
    case "chat":
      return { path: tail ? `/chat/${tail}` : "/chat", query, hash, raw }
    case "artifact":
    case "artifacts":
      return { path: tail ? `/artifact/${tail}` : "/artifacts", query, hash, raw }
    case "document":
    case "documents":
      return { path: tail ? `/documents/${tail}` : "/documents", query, hash, raw }
    case "settings":
      return { path: tail ? `/settings/${tail}` : "/settings", query, hash, raw }
    case "home":
    case "":
      return { path: tail ? `/${tail}` : "/", query, hash, raw }
    default:
      return null
  }
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith("/") ? p : `/${p}`
}

function stripPathParam(query: string): string {
  if (!query) return ""
  const params = new URLSearchParams(query)
  params.delete("path")
  return params.toString()
}

/**
 * Build a fully-qualified internal href (path + query + hash) suitable for
 * router.push() in Next.js.
 */
export function routeToHref(route: DeepLinkRoute): string {
  const q = route.query ? `?${route.query}` : ""
  const h = route.hash ? `#${route.hash}` : ""
  return `${route.path}${q}${h}`
}

/**
 * Wire the parser into Capacitor's `App.addListener('appUrlOpen')`. Returns a
 * disposer that removes the listener. Safe to call on web — when Capacitor
 * isn't present we simply return a no-op disposer.
 */
export async function attachCapacitorDeepLinks(
  handler: DeepLinkHandler,
): Promise<() => void> {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    if (!g.Capacitor?.isNativePlatform?.()) return () => {}
    const spec = "@capacitor/app"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    const App = mod?.App
    if (!App?.addListener) return () => {}

    const listener = await App.addListener("appUrlOpen", async (event: { url?: string }) => {
      const route = parseDeepLink(event?.url ?? "")
      if (route) await handler(route)
    })

    return () => {
      try {
        listener?.remove?.()
      } catch {
        /* ignore */
      }
    }
  } catch {
    return () => {}
  }
}

/**
 * Convenience: run a default Next.js router push when a deep link arrives.
 * Caller provides the push function (e.g. `router.push` from `next/navigation`)
 * so we don't import Next.js at module scope (keeps this file SSR-safe).
 */
export function makeRouterHandler(push: (href: string) => void): DeepLinkHandler {
  return (route) => {
    push(routeToHref(route))
  }
}
