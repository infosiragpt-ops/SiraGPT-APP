export const GITHUB_CONNECTION_REQUIRED_EVENT = "siragpt:github-connection-required"
export const GITHUB_CONNECTION_TURN_SETTLED_EVENT = "siragpt:github-connection-turn-settled"
export const GITHUB_CONNECTION_CANCEL_EVENT = "siragpt:github-connection-cancel"
export type GithubConnectionPayload = { chatId: string; handoffId: string }
export type GithubConnectionDetail = GithubConnectionPayload & { userId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseGithubConnectionPayload(value: unknown): GithubConnectionPayload | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const chatId = typeof row.chatId === "string" ? row.chatId.trim() : ""
  const handoffId = typeof row.handoffId === "string" ? row.handoffId : ""
  return /^[\w-]{1,64}$/.test(chatId) && UUID.test(handoffId) ? { chatId, handoffId } : null
}

export function emitGithubConnectionRequired(value: unknown, userId: string, chatId: string): boolean {
  const payload = parseGithubConnectionPayload(value)
  if (!payload || !userId || payload.chatId !== chatId || typeof window === "undefined") return false
  window.dispatchEvent(new CustomEvent<GithubConnectionDetail>(GITHUB_CONNECTION_REQUIRED_EVENT, { detail: { ...payload, userId } }))
  return true
}

/** A browser gesture reserves a tab only for an unambiguous login request. */
export function isExplicitGithubConnectRequest(text: string): boolean {
  const value = String(text || "").replace(/```[\s\S]*?```/g, " ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
  if (!/\bgithub\b/.test(value) || value.length > 1500) return false
  if (/\b(?:do not|don['’]t|never)\s+(?:connect|open|authoriz|log ?in|sign ?in)|\b(?:no|nunca|sin)\s+(?:(?:quiero|deseo)\s+(?:que\s+)?|me\s+|debes?\s+)*(?:conect|abr|inici|autoriz)|\b(?:desconect\w*|disconnect\w*|revoca\w*)\b/.test(value)) return false
  if (/\b(?:como (?:puedo |se |hago para )?(?:conect|inici|acced|autoriz)\w*|explica\w*|(?:para )?que (?:es|significa|sirve)|how (?:do|can|to))\b/.test(value)) return false
  const accountAccess = /\b(?:cuenta|sesion|loguear\w*|log ?in|sign ?in|oauth|autoriz\w*|acceder|acceso)\b/.test(value)
  if (!accountAccess && /github\.com\/|\b(?:repositorio|repo|pull request|pr|codigo)\b/.test(value)) return false
  return /\b(?:conecta(?:r|me)?|connect|inicia(?:r)? sesion|iniciar sesion|loguea(?:r|me)?|loguearme|log ?in|sign ?in|accede(?:r)?|autoriza(?:r)?)\b/.test(value)
    || /\b(?:abre|abrir|abrirme|open|dame|pasame|pasa|envia)\b.{0,100}\b(?:github|link|enlace|acceso)\b/.test(value)
}

/** URL is issued by our authenticated backend, never supplied by the model. */
export function isGithubAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize"
      && !url.username && !url.password && !url.hash
      && Boolean(url.searchParams.get("client_id")) && Boolean(url.searchParams.get("state"))
  } catch { return false }
}

export const GITHUB_RESUME_TEXT = "Continúa con la tarea pendiente. GitHub ya está conectado y verificado. Conserva mis instrucciones y permisos anteriores. Esta conexión no autoriza por sí sola publicar, fusionar, pagar ni borrar."
