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
  tabId?: string,
  sessionId?: string,
): Promise<string> {
  const parsed = sanitizeNavigateUrl(rawUrl)
  if (!parsed.ok) throw new Error(parsed.error)
  const chatId = String(conversationId || "").trim()
  if (!sessionId) await ensureComputerSession(chatId || null)
  const res = await authenticatedFetch(`${apiRoot()}/agent-computer/navigate`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({
      url: parsed.url,
      ...(tabId ? { tabId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(chatId ? { conversationId: chatId } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({})) as { message?: string; error?: string; ok?: boolean; url?: unknown; sessionId?: unknown; conversationId?: unknown; conversationBound?: unknown } | null
  if (!res.ok || body?.ok !== true) {
    throw new Error(body?.message || body?.error || "No se pudo abrir la página")
  }
  if (sessionId && (body.sessionId !== sessionId || body.conversationId !== (chatId || null) || body.conversationBound !== Boolean(chatId))) {
    throw new Error("No se pudo confirmar la página en esta computadora.")
  }
  const actual = sanitizeNavigateUrl(body.url)
  if (!actual.ok || typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) {
    throw new Error("No se pudo confirmar la página abierta. Inténtalo de nuevo.")
  }
  // The navigation service already brought the selected page to the front.
  // Focusing the first browser window here can hide that page with an old tab.
  return actual.url
}

export type ComputerBrowserTab = { id: string; title: string; url: string }
export type ComputerBrowserState = {
  tabs: ComputerBrowserTab[]
  activeTabId: string | null
  canGoBack: boolean
  canGoForward: boolean
  presentation: "embedded" | "desktop"
  viewport: { width: number; height: number } | null
}
export type ComputerBrowserAction = {
  type: "browser_tab_create" | "browser_tab_select" | "browser_tab_close" | "browser_back" | "browser_forward" | "browser_reload" | "browser_present" | "browser_restore" | "browser_resize"
  tabId?: string
  width?: number
  height?: number
}

function confirmedBrowser(body: unknown, chatId: string, sessionId: string): ComputerBrowserState {
  const value = body as Record<string, any> | null
  const state = value?.browser
  if (value?.ok !== true || value.sessionId !== sessionId || value.conversationId !== (chatId || null)
    || value.conversationBound !== Boolean(chatId) || !state || !Array.isArray(state.tabs)
    || !state.tabs.every((tab: any) => typeof tab?.id === "string" && tab.id.length > 0 && typeof tab.title === "string" && typeof tab.url === "string")
    || new Set(state.tabs.map((tab: ComputerBrowserTab) => tab.id)).size !== state.tabs.length
    || !(state.activeTabId === null || typeof state.activeTabId === "string")
    || (state.activeTabId !== null && !state.tabs.some((tab: ComputerBrowserTab) => tab.id === state.activeTabId))
    || typeof state.canGoBack !== "boolean" || typeof state.canGoForward !== "boolean"
    || !["embedded", "desktop"].includes(state.presentation)
    || !(state.viewport === null || (Number.isInteger(state.viewport?.width) && Number.isInteger(state.viewport?.height)
      && state.viewport.width > 0 && state.viewport.height > 0))) {
    throw new Error("No se pudo confirmar el estado del navegador. Inténtalo de nuevo.")
  }
  return state as ComputerBrowserState
}

export async function readComputerBrowser(conversationId: string, sessionId: string, signal?: AbortSignal): Promise<ComputerBrowserState> {
  if (!sessionId.trim()) throw new Error("La computadora aún no está disponible.")
  const qs = new URLSearchParams({ ...(conversationId ? { conversationId } : {}), sessionId, browser: "1" })
  const response = await authenticatedFetch(`${apiRoot()}/agent-computer/activity?${qs}`, {
    credentials: "include", headers: authHeaders(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error("No se pudo consultar el navegador. Inténtalo de nuevo.")
  return confirmedBrowser(await response.json().catch(() => null), conversationId, sessionId)
}

export async function actComputerBrowser(conversationId: string, sessionId: string, action: ComputerBrowserAction, signal?: AbortSignal): Promise<ComputerBrowserState> {
  if (!sessionId.trim()) throw new Error("La computadora aún no está disponible.")
  const response = await authenticatedFetch(`${apiRoot()}/agent-computer/action`, {
    method: "POST", credentials: "include", headers: authHeaders(),
    body: JSON.stringify({ ...(conversationId ? { conversationId } : {}), sessionId, action }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error("No se pudo completar la acción del navegador. Inténtalo de nuevo.")
  return confirmedBrowser(await response.json().catch(() => null), conversationId, sessionId)
}
