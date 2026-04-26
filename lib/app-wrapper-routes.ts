const CHAT_PAGES = ['/chat', '/gpts', '/parafraseo', '/projects', '/design', '/plan', '/profile', '/library', '/billing', '/settings', '/thesis', '/documents'] as const
// /admin owns its full layout (own SidebarProvider + AdminSidebar in
// app/admin/layout.tsx), so AppWrapper must render children as-is.
// Injecting AppShell here would pull in AppSidebar, which calls
// useChat() and crashes outside a ChatProvider.
const SIDEBAR_ONLY_PAGES = ['/profile'] as const

function matchesPrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function needsChatContext(pathname: string) {
  return matchesPrefix(pathname, CHAT_PAGES)
}

export function needsSidebar(pathname: string) {
  return matchesPrefix(pathname, [...CHAT_PAGES, ...SIDEBAR_ONLY_PAGES])
}
