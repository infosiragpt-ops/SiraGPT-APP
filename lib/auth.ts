type JwtPayload = {
  userId?: string
  id?: string
  email?: string
  isAdmin?: boolean
}

export interface AuthUser {
  id: string
  email: string
  isAdmin: boolean
}

export interface ActiveAuthRequest {
  headers?: { get(name: string): string | null }
}

export interface ActiveSessionOptions {
  backendBaseUrl?: string
  fetchImpl?: typeof fetch
}

function getJwtSecret(): string | null {
  const secret = process.env.JWT_SECRET?.trim()
  return secret && secret.length > 0 ? secret : null
}

export async function validateSession(token: string): Promise<AuthUser | null> {
  try {
    const secret = getJwtSecret()
    if (!secret) return null

    const jwt = require("jsonwebtoken")
    const decoded = jwt.verify(token, secret) as JwtPayload
    const id = decoded.userId || decoded.id
    if (!id) return null

    return {
      id,
      email: decoded.email || "",
      isAdmin: Boolean(decoded.isAdmin),
    }
  } catch {
    return null
  }
}

function authMeUrl(rawBaseUrl: string): string | null {
  try {
    const base = new URL(rawBaseUrl)
    const pathname = base.pathname.replace(/\/+$/, "")
    base.pathname = pathname.endsWith("/api") ? `${pathname}/auth/me` : `${pathname}/api/auth/me`
    base.search = ""
    base.hash = ""
    return base.toString()
  } catch {
    return null
  }
}

/**
 * Validate a token against the active backend session authority. JWT
 * signature verification alone is intentionally insufficient here because a
 * revoked/deleted/expired Session row must return 401 immediately.
 */
export async function validateActiveSession(
  token: string,
  request?: ActiveAuthRequest,
  options: ActiveSessionOptions = {},
): Promise<AuthUser | null> {
  if (!token || /[\s\r\n\0]/.test(token)) return null
  const configuredBase = options.backendBaseUrl
    || process.env.BACKEND_INTERNAL_URL
    || process.env.SIRAGPT_INTERNAL_API_URL
    || process.env.NEXT_PUBLIC_API_URL
  if (!configuredBase) return null
  const url = authMeUrl(configuredBase)
  if (!url) return null

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  })
  // Preserve the original client fingerprint while forwarding only the
  // headers the backend's active-session authority consumes.
  for (const name of ["user-agent", "cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"]) {
    const value = request?.headers?.get(name)
    if (value) headers.set(name, value)
  }

  try {
    const fetchImpl = options.fetchImpl || ((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init))
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(2_500),
    })
    if (!response.ok) return null
    const payload = await response.json().catch(() => null) as { user?: Record<string, unknown> } | null
    const user = payload?.user
    const id = typeof user?.id === "string" ? user.id : ""
    if (!id) return null
    return {
      id,
      email: typeof user?.email === "string" ? user.email : "",
      isAdmin: Boolean(user?.isAdmin || user?.isSuperAdmin),
    }
  } catch {
    // The route is protected and must fail closed when the authority is down.
    return null
  }
}
