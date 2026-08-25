/**
 * Agents home is `/` (the current /chat experience). `/chat` is a
 * compatibility alias that must redirect here, preserving query/hash/id.
 */

export const AGENTS_HOME_PATH = "/"

export function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname) return AGENTS_HOME_PATH
  const clean = String(pathname).split("?")[0].split("#")[0]
  if (clean.length > 1 && clean.endsWith("/")) return clean.slice(0, -1)
  return clean || AGENTS_HOME_PATH
}

export function isAgentsHomePath(pathname: string | null | undefined): boolean {
  const clean = normalizePathname(pathname)
  return clean === "/" || clean === "/chat"
}

export function agentsHomeHref(query?: string | null, hash?: string | null): string {
  const qs = String(query || "").replace(/^\?/, "")
  const rawHash = String(hash || "")
  const h = !rawHash ? "" : rawHash.startsWith("#") ? rawHash : `#${rawHash}`
  return `${qs ? `/?${qs}` : AGENTS_HOME_PATH}${h}`
}

export function chatSearchToAgentsHome(
  search: string | URLSearchParams | null | undefined,
  hash?: string | null,
): string {
  if (search instanceof URLSearchParams) {
    const qs = search.toString()
    return agentsHomeHref(qs, hash)
  }
  return agentsHomeHref(search, hash)
}
