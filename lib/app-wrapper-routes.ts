const CHAT_PAGES = ['/chat', '/gpts', '/profile', '/library', '/billing', '/settings', '/thesis'] as const
const SIDEBAR_ONLY_PAGES = ['/profile', '/admin'] as const

function matchesPrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function needsChatContext(pathname: string) {
  return matchesPrefix(pathname, CHAT_PAGES)
}

export function needsSidebar(pathname: string) {
  return matchesPrefix(pathname, [...CHAT_PAGES, ...SIDEBAR_ONLY_PAGES])
}
