/**
 * Product noun is «agentes», not «chat». Canonical home is `/agentes`
 * (same chrome as the former /chat surface). `/chat` and authenticated
 * `/` only redirect here.
 */

export const AGENTS_HOME_PATH = "/agentes"

const HOME_ALIASES = new Set(["/agentes", "/chat"])

export function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname) return AGENTS_HOME_PATH
  const clean = String(pathname).split("?")[0].split("#")[0]
  if (clean.length > 1 && clean.endsWith("/")) return clean.slice(0, -1)
  return clean || AGENTS_HOME_PATH
}

export function isAgentsHomePath(pathname: string | null | undefined): boolean {
  const clean = normalizePathname(pathname)
  if (HOME_ALIASES.has(clean)) return true
  return clean.startsWith("/agentes/") || clean.startsWith("/chat/")
}

function firstSearchValue(
  search: string | URLSearchParams | null | undefined,
  key: string,
): string {
  if (search instanceof URLSearchParams) return String(search.get(key) || "").trim()
  const raw = String(search || "").replace(/^\?/, "")
  if (!raw) return ""
  return String(new URLSearchParams(raw).get(key) || "").trim()
}

export function conversationIdFromPath(pathname: string | null | undefined): string {
  const clean = normalizePathname(pathname)
  for (const prefix of ["/agentes/", "/chat/"] as const) {
    if (!clean.startsWith(prefix)) continue
    const rest = clean.slice(prefix.length)
    const id = rest.split("/")[0]
    if (!id || id === "pending") return ""
    try {
      return decodeURIComponent(id)
    } catch {
      return id
    }
  }
  return ""
}

export function conversationIdFromLocation(
  pathname?: string | null,
  search?: string | URLSearchParams | null,
): string {
  const fromQuery = firstSearchValue(search, "id")
  if (fromQuery && fromQuery !== "pending") return fromQuery
  return conversationIdFromPath(pathname)
}

export function agentsHomeHref(
  query?: string | URLSearchParams | null,
  hash?: string | null,
  conversationId?: string | null,
): string {
  const params = query instanceof URLSearchParams
    ? new URLSearchParams(query.toString())
    : new URLSearchParams(String(query || "").replace(/^\?/, ""))
  const pathId = String(conversationId || "").trim()
  if (pathId && pathId !== "pending") {
    params.delete("id")
    const qs = params.toString()
    const rawHash = String(hash || "")
    const h = !rawHash ? "" : rawHash.startsWith("#") ? rawHash : `#${rawHash}`
    return `${AGENTS_HOME_PATH}/${encodeURIComponent(pathId)}${qs ? `?${qs}` : ""}${h}`
  }
  const qs = params.toString()
  const rawHash = String(hash || "")
  const h = !rawHash ? "" : rawHash.startsWith("#") ? rawHash : `#${rawHash}`
  return `${qs ? `${AGENTS_HOME_PATH}?${qs}` : AGENTS_HOME_PATH}${h}`
}

export function chatSearchToAgentsHome(
  search: string | URLSearchParams | null | undefined,
  hash?: string | null,
  pathname?: string | null,
): string {
  const pathId = conversationIdFromPath(pathname)
  const queryId = firstSearchValue(search, "id")
  return agentsHomeHref(search, hash, queryId ? null : pathId || null)
}

/** Post-login destination. Authenticated `/` is not a second chat copy. */
export function postAuthAgentsHref(next?: string | null): string {
  const value = String(next || "").trim()
  if (!value || !value.startsWith("/") || value.startsWith("//")) return AGENTS_HOME_PATH
  try {
    const url = new URL(value, "https://siragpt.local")
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) return AGENTS_HOME_PATH
    if (url.pathname === "/" || isAgentsHomePath(url.pathname)) {
      return chatSearchToAgentsHome(url.search, url.hash, url.pathname)
    }
    return `${url.pathname}${url.search}${url.hash}` || AGENTS_HOME_PATH
  } catch {
    return AGENTS_HOME_PATH
  }
}
