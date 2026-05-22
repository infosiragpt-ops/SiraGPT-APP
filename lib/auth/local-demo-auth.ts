export interface LocalDemoUser {
  id: string
  name: string
  email: string
  avatar?: string
  plan: string
  isAdmin: boolean
  isSuperAdmin?: boolean
  apiUsage: number
  monthlyLimit: number
  createdAt: string
  updatedAt: string
}

export const LOCAL_DEMO_TOKEN = "local-demo-auth-token"
export const LOCAL_DEMO_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export const LOCAL_DEMO_USER: LocalDemoUser = {
  id: "admin-1",
  name: "Admin User",
  email: "admin@example.com",
  avatar: "/placeholder.svg?height=32&width=32",
  plan: "Enterprise",
  isAdmin: true,
  isSuperAdmin: true,
  apiUsage: 15420,
  monthlyLimit: 100000,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
}

export function normalizeLocalDemoHostname(hostname: string): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
}

export function isLocalDemoHostname(hostname: string): boolean {
  const normalizedHostname = normalizeLocalDemoHostname(hostname)

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]" ||
    normalizedHostname.endsWith(".local")
  )
}

export function localDemoAuthEnabled(hostname?: string): boolean {
  if (hostname !== undefined) return isLocalDemoHostname(hostname)
  if (typeof window === "undefined") return false

  return isLocalDemoHostname(window.location.hostname)
}

export function normalizeLocalDemoEmail(email: string): string {
  return String(email || "").trim().toLowerCase()
}

export function normalizeLocalDemoPassword(password: string): string {
  return String(password || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2028\u2029\r\n\t]/g, "")
    .trim()
}

export function isLocalDemoLogin(email: string, password: string, hostname?: string): boolean {
  return (
    localDemoAuthEnabled(hostname) &&
    normalizeLocalDemoEmail(email) === LOCAL_DEMO_USER.email &&
    normalizeLocalDemoPassword(password) === "password"
  )
}
