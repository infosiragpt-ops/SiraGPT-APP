import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { sanitizeNavigateUrl } from "@/lib/computer-navigate"

export { browserUrlFromPrompt, DEFAULT_BROWSER_HOME } from "@/lib/computer-navigate"

function apiRoot() {
  return getSameOriginApiBaseUrl().replace(/\/+$/, "")
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function ensureComputerSession(conversationId?: string | null): Promise<void> {
  const chatId = String(conversationId || "").trim()
  const qs = chatId ? `?conversationId=${encodeURIComponent(chatId)}` : ""
  const res = await authenticatedFetch(`${apiRoot()}/agent-computer/sessions${qs}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: chatId ? JSON.stringify({ conversationId: chatId }) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status === 409 && !chatId) return
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string }
    throw new Error(body.message || body.error || "No se pudo abrir el navegador.")
  }
}

export async function postComputerNavigate(
  conversationId: string | null | undefined,
  rawUrl: string,
): Promise<string> {
  const parsed = sanitizeNavigateUrl(rawUrl)
  if (!parsed.ok) throw new Error(parsed.error)
  const chatId = String(conversationId || "").trim()
  await ensureComputerSession(chatId || null)
  const res = await authenticatedFetch(`${apiRoot()}/agent-computer/navigate`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({
      url: parsed.url,
      ...(chatId ? { conversationId: chatId } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({})) as { message?: string; error?: string; ok?: boolean }
  if (!res.ok || body.ok === false) {
    throw new Error(body.message || body.error || "No se pudo abrir la página")
  }
  await authenticatedFetch(`${apiRoot()}/agent-computer/action`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({
      focus: "browser",
      ...(chatId ? { conversationId: chatId } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined)
  return parsed.url
}
