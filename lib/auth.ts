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
