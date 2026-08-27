/**
 * Real /conexiones Conectar — first-party OAuth only.
 *
 * First-party cards (LinkedIn / X / Facebook / GitHub / Google) start the
 * existing backend OAuth. Catalog cards without a connector stay available
 * to browse but cannot be marked Conectada and must not open Chrome or the
 * isolated computer. Nothing is marked connected from localStorage alone.
 */

export type ConnectableApp = {
  id: string
  name: string
  domain: string
}

export type FirstPartyProvider =
  | "linkedin"
  | "x"
  | "facebook"
  | "github"
  | "gmail"
  | "google-services"

export type ConnectPlan =
  | { kind: "oauth"; provider: FirstPartyProvider; startPath: string }
  | { kind: "unavailable" }

export type ConnectStatus = "oauth_started" | "unavailable" | "login_required" | "error"

export type ConnectResult = {
  status: ConnectStatus
  markConnected: boolean
  message: string
  conversationId?: string
  redirectUrl?: string
}

export type ComputerSession = {
  sessionId?: string
  conversationId?: string | null
  conversationBound?: boolean
}

export type FetchJsonResult = {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

export type ConnectGptStoreAppDeps = {
  isAuthenticated: boolean
  defaultModel?: string | null
  currentConversationId?: string | null
  loginNext?: string
  requireLogin: (next?: string) => void
  fetchJson: (path: string, init?: RequestInit) => Promise<FetchJsonResult>
  ensureComputer: (conversationId: string) => Promise<ComputerSession>
  navigateComputer: (conversationId: string, url: string) => Promise<unknown>
  createConversation: (title: string, model: string) => Promise<{ id: string }>
  openComputerOverlay: (conversationId: string, url: string) => void
  assignLocation?: (url: string) => void
}

export const CONNECT_COPY = {
  connect: "Conectar",
  connecting: "Conectando…",
  connected: "Conectada",
  reconnect: "Reconectar",
  remove: "Quitar",
  computerOpened: "Abierta en la computadora",
  loginRequired: "Inicia sesión para conectar esta app.",
  oauthMissing: (name: string) =>
    `No se pudo conectar ${name}: faltan las credenciales OAuth en el servidor.`,
  oauthFailed: (name: string) => `No se pudo iniciar la conexión con ${name}.`,
  oauthStarted: (name: string) => `Abriendo la autorización de ${name}…`,
  disconnectFailed: (name: string) => `No se pudo quitar ${name}.`,
  disconnected: (name: string) => `${name} desconectada`,
  unavailable: (name: string) =>
    `${name} todavía no se puede conectar. No abre el navegador ni queda marcada como Conectada.`,
  computerFailed: "No se pudo abrir la computadora.",
  isolationFailed: "No se pudo aislar la computadora de esta conversación.",
  navigateFailed: (domain: string) => `No se pudo abrir ${domain} en la computadora.`,
} as const

export function isHealthConnected(status: string | null | undefined): boolean {
  return String(status || "").toLowerCase() === "connected"
}

const FIRST_PARTY_START: Record<FirstPartyProvider, string> = {
  linkedin: "/social-posts/connect/linkedin",
  x: "/social-posts/connect/x",
  facebook: "/social-posts/connect/facebook",
  github: "/github/connect",
  gmail: "/auth/gmail",
  "google-services": "/auth/google-services",
}

function normalizeHost(domain: string): string {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "")
}

function hostMatches(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`)
}

export function catalogNavigateUrl(app: ConnectableApp): string {
  const host = normalizeHost(app.domain)
  if (!host || /[^a-z0-9.-]/i.test(host)) {
    throw new Error(CONNECT_COPY.computerFailed)
  }
  return `https://${host}`
}

export function resolveFirstPartyProvider(app: ConnectableApp): FirstPartyProvider | null {
  const id = String(app.id || "").trim().toLowerCase()
  const host = normalizeHost(app.domain)

  if (id === "linkedin" || hostMatches(host, "linkedin.com")) return "linkedin"
  if (id === "x" || id === "twitter" || hostMatches(host, "x.com") || hostMatches(host, "twitter.com")) {
    return "x"
  }
  if (id === "facebook" || hostMatches(host, "facebook.com")) return "facebook"
  if (id === "github" || hostMatches(host, "github.com")) return "github"
  if (id === "gmail" || host === "gmail.com" || host === "mail.google.com") return "gmail"
  if (
    id === "gcalendar"
    || id === "gdrive"
    || id === "google"
    || id === "google-services"
    || host === "google.com"
    || host === "calendar.google.com"
    || host === "drive.google.com"
  ) {
    return "google-services"
  }
  return null
}

export function firstPartyOAuthStartPath(app: ConnectableApp): string | null {
  const provider = resolveFirstPartyProvider(app)
  return provider ? FIRST_PARTY_START[provider] : null
}

export function resolveConnectPlan(app: ConnectableApp): ConnectPlan {
  const provider = resolveFirstPartyProvider(app)
  if (provider) {
    return { kind: "oauth", provider, startPath: FIRST_PARTY_START[provider] }
  }
  return { kind: "unavailable" }
}

function readOAuthStartUrl(body: Record<string, unknown>): string {
  const candidates = [body.url, body.authUrl, body.authorizationUrl]
  for (const value of candidates) {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim()
  }
  const nested = body.authorization
  if (nested && typeof nested === "object") {
    const url = (nested as { url?: unknown }).url
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim()
  }
  return ""
}

function oauthErrorMessage(app: ConnectableApp, result: FetchJsonResult): string {
  const code = String(result.body.code || "")
  if (
    result.status === 503
    || code === "social_provider_not_configured"
    || /not configured/i.test(String(result.body.error || result.body.message || ""))
  ) {
    return CONNECT_COPY.oauthMissing(app.name)
  }
  return CONNECT_COPY.oauthFailed(app.name)
}

export async function connectGptStoreApp(
  app: ConnectableApp,
  deps: ConnectGptStoreAppDeps,
): Promise<ConnectResult> {
  const loginNext = deps.loginNext || "/conexiones"
  if (!deps.isAuthenticated) {
    deps.requireLogin(loginNext)
    return {
      status: "login_required",
      markConnected: false,
      message: CONNECT_COPY.loginRequired,
    }
  }

  const plan = resolveConnectPlan(app)
  if (plan.kind === "unavailable") {
    return {
      status: "unavailable",
      markConnected: false,
      message: CONNECT_COPY.unavailable(app.name),
    }
  }
  if (plan.kind === "oauth") {
    try {
      const response = await deps.fetchJson(plan.startPath)
      if (response.status === 401) {
        deps.requireLogin(loginNext)
        return {
          status: "login_required",
          markConnected: false,
          message: CONNECT_COPY.loginRequired,
        }
      }
      if (!response.ok) {
        return {
          status: "error",
          markConnected: false,
          message: oauthErrorMessage(app, response),
        }
      }
      const redirectUrl = readOAuthStartUrl(response.body)
      if (!redirectUrl) {
        return {
          status: "error",
          markConnected: false,
          message: CONNECT_COPY.oauthFailed(app.name),
        }
      }
      return {
        status: "oauth_started",
        markConnected: false,
        message: CONNECT_COPY.oauthStarted(app.name),
        redirectUrl,
      }
    } catch {
      return {
        status: "error",
        markConnected: false,
        message: CONNECT_COPY.oauthFailed(app.name),
      }
    }
  }

  return {
    status: "unavailable",
    markConnected: false,
    message: CONNECT_COPY.unavailable(app.name),
  }
}

export function connectButtonLabel(opts: {
  connected: boolean
  connecting: boolean
}): string {
  if (opts.connecting) return CONNECT_COPY.connecting
  if (opts.connected) return CONNECT_COPY.reconnect
  return CONNECT_COPY.connect
}
