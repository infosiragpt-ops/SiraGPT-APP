export type GuardUser = {
  isAdmin?: boolean
  isSuperAdmin?: boolean
} | null

export type GuardOptions = {
  requireAdmin?: boolean
  requireSuperAdmin?: boolean
}

export function getAuthRedirect(
  user: GuardUser,
  { requireAdmin = false, requireSuperAdmin = false }: GuardOptions = {}
): "/auth/login" | "/chat" | null {
  if (!user) return "/auth/login"
  if (requireSuperAdmin && !user.isSuperAdmin) return "/chat"
  if (requireAdmin && !user.isAdmin && !user.isSuperAdmin) return "/chat"
  return null
}
