/**
 * Computer login-handoff — frontend contracts.
 *
 * The user types credentials on the per-chat computer overlay.
 * SiraGPT / the model never receives those keystrokes.
 */

export const LOGIN_HANDOFF_EVENT = "computer_login_handoff"
export const LOGIN_HANDOFF_WINDOW_EVENT = "siragpt:computer-login-handoff"

export const LOGIN_HANDOFF_COPY = {
  title: "Inicia sesión en el equipo",
  instruction: "Inicia sesión en este sitio",
  neverSees: "SiraGPT no ve tu contraseña",
  ready: "Listo",
  paused: "La computadora espera a que inicies sesión. SiraGPT no ve tu contraseña.",
  captchaTitle: "Completa el captcha en el equipo",
  captchaInstruction: "Hay un captcha. Tómalo tú.",
  captchaChat:
    "Apareció un captcha (tráfico inusual / no soy un robot). Toma el control de la computadora, resuélvelo ahí y pulsa Listo. SiraGPT no ve tu contraseña.",
  otpTitle: "Completa la verificación en el equipo",
  otpInstruction: "Ingresa el código 2FA en esta computadora",
  otpChat:
    "Hay una verificación en dos pasos. Toma el control de la computadora, ingresa el código ahí y pulsa Listo. SiraGPT no ve tu contraseña.",
  paymentTitle: "Completa el pago en el equipo",
  paymentInstruction: "Paga en esta computadora. SiraGPT no ve tus datos.",
  paymentChat:
    "Hay un muro de pago. Toma el control de la computadora, completa el pago ahí y pulsa Listo. SiraGPT no ve tu contraseña ni tu tarjeta.",
  loginChat:
    "Inicia sesión en el equipo. Toma el control de la computadora y pulsa Listo. SiraGPT no ve tu contraseña.",
} as const

export const HAS_COMPUTER_POLICY_ES = [
  "POLÍTICA DE COMPUTADORA EN VIVO (obligatoria):",
  "- Cada chat TIENE una computadora en vivo con navegador. El overlay de ESTE chat es real.",
  "- Cuando el usuario pide abrirla, buscar en vivo, ofertas, comprar, reservar, agendar una cita, DMV, seguro o revisar un sitio: llama computer_screenshot, computer_navigate, computer_click y computer_type de inmediato, abre el overlay y navega de verdad.",
  "- NUNCA niegues la computadora ni el navegador de este chat. Confirma precios y ofertas navegando de verdad.",
  "- El usuario escribe contraseñas, OTP y tarjetas EN el overlay. NUNCA pidas que las pegue en el chat. SiraGPT no ve la contraseña.",
].join("\n")

export const LOGIN_HANDOFF_POLICY_ES = [
  HAS_COMPUTER_POLICY_ES,
  "NUNCA pidas al usuario que pegue una contraseña, usuario, código OTP/2FA o número de tarjeta en el chat.",
  "Abre la computadora del agente de ESTE chat. El usuario inicia sesión en el overlay. SiraGPT no ve tu contraseña.",
  "No inventes integraciones por sitio. Usa el navegador real de la computadora.",
].join("\n")

export const EXAMPLE_AUTHENTICATED_TASKS = [
  "activa los servicios (luz, agua, internet) del departamento nuevo",
  "renueva mi licencia en el DMV",
  "agenda la cita de pasaporte y sube la foto",
  "reclama el reembolso del seguro con las facturas",
  "busca un médico in-network cerca y agenda",
  "renueva el registro del auto",
  "escribe al landlord y contrasta con la póliza de renter",
  "filtra departamentos en portales y contacta a los que calzan",
  "reordena este producto a partir de la foto",
  "coordina recoger el paquete en la sucursal",
  "cancela estos boletos y pide el reembolso",
  "agenda al veterinario y sube el historial",
  "arma el reembolso médico con los recibos",
  "avísame y compra en el drop de reventa",
  "evalúa estos candidatos y arma el informe para hiring",
  "manda las facturas a contabilidad",
  "responde las consultas de alquiler con disponibilidad",
  "tramita el permiso de pequeño negocio",
  "cierra los action items del portal de proveedores",
  "analiza la campaña de anuncios en el panel del anunciante",
] as const

export type LoginHandoffKind = "password" | "otp" | "captcha" | "sso" | "payment" | "username"

export type LoginHandoffDetail = {
  conversationId?: string | null
  active: boolean
  site?: string
  kind?: LoginHandoffKind | string
  reason?: string
  title?: string
  instruction?: string
  chatMessage?: string | null
}

export type OverlayLayoutContract = {
  mobile: boolean
  fullScreen: boolean
  minTapPx: number
  bannerMinHeightPx: number
  noClippedChrome: boolean
  overlayPosition: "fixed-inset-0" | "panel"
}

export function overlayLayoutContract(viewportWidth: number): OverlayLayoutContract {
  const width = Number(viewportWidth) || 0
  const mobile = width > 0 && width < 768
  return {
    mobile,
    fullScreen: mobile,
    minTapPx: 44,
    bannerMinHeightPx: mobile ? 64 : 48,
    noClippedChrome: true,
    overlayPosition: mobile ? "fixed-inset-0" : "panel",
  }
}

export function copyForKind(kind?: string | null, site?: string | null): {
  title: string
  instruction: string
  chat: string
} {
  const host = String(site || "").trim()
  const k = String(kind || "password")
  if (k === "captcha") {
    return {
      title: LOGIN_HANDOFF_COPY.captchaTitle,
      instruction: host ? `Completa el captcha en ${host}` : LOGIN_HANDOFF_COPY.captchaInstruction,
      chat: LOGIN_HANDOFF_COPY.captchaChat,
    }
  }
  if (k === "otp") {
    return {
      title: LOGIN_HANDOFF_COPY.otpTitle,
      instruction: host ? `Ingresa el código 2FA en ${host}` : LOGIN_HANDOFF_COPY.otpInstruction,
      chat: LOGIN_HANDOFF_COPY.otpChat,
    }
  }
  if (k === "payment") {
    return {
      title: LOGIN_HANDOFF_COPY.paymentTitle,
      instruction: host ? `Completa el pago en ${host}` : LOGIN_HANDOFF_COPY.paymentInstruction,
      chat: LOGIN_HANDOFF_COPY.paymentChat,
    }
  }
  return {
    title: LOGIN_HANDOFF_COPY.title,
    instruction: host ? `Inicia sesión en ${host}` : LOGIN_HANDOFF_COPY.instruction,
    chat: LOGIN_HANDOFF_COPY.loginChat,
  }
}

export function instructionForSite(site?: string | null, kind?: string | null): string {
  return copyForKind(kind, site).instruction
}

export function chatMessageFromDetail(detail: LoginHandoffDetail | null | undefined): string {
  if (!detail || !detail.active) return ""
  if (detail.chatMessage) return String(detail.chatMessage)
  return copyForKind(detail.kind, detail.site).chat
}

export function shouldPostHandoffChatMessage(
  messages: Array<{ role?: string; content?: string }> | null | undefined,
  chatMessage: string,
): boolean {
  const needle = String(chatMessage || "").trim()
  if (!needle) return false
  const head = needle.slice(0, 48)
  return !(messages || []).some((msg) => {
    const role = String(msg?.role || "").toUpperCase()
    if (role !== "ASSISTANT") return false
    return String(msg?.content || "").includes(head)
  })
}

export function buildHandoffAssistantMessage(
  chatId: string,
  chatMessage: string,
  detail?: LoginHandoffDetail | null,
): {
  id: string
  chatId: string
  role: "ASSISTANT"
  content: string
  timestamp: string
  metadata: { type: string; kind?: string; site?: string }
} {
  return {
    id: `login-handoff-${chatId}-${detail?.kind || "gate"}`,
    chatId,
    role: "ASSISTANT",
    content: chatMessage,
    timestamp: new Date().toISOString(),
    metadata: {
      type: LOGIN_HANDOFF_EVENT,
      kind: detail?.kind,
      site: detail?.site,
    },
  }
}

export function isCaptchaHandoffUrl(url?: string | null): boolean {
  const raw = String(url || "").trim()
  if (!raw) return false
  if (/(?:^|[/.])google(?:apis)?\.[a-z.]+\/sorry(?:\/|\?|$)|\/sorry\/index\b|ipv[46]\.google\.[a-z.]+\/sorry\b/i.test(raw)) {
    return true
  }
  if (/recaptcha(?:\/|$|\.)|\/recaptcha\//i.test(raw)) return true
  try {
    const parsed = new URL(raw)
    const host = String(parsed.hostname || "").replace(/^www\./, "")
    const path = String(parsed.pathname || "")
    if (/google\./i.test(host) && /\/sorry\b/i.test(path)) return true
    if (/recaptcha/i.test(host) || /recaptcha/i.test(path)) return true
  } catch {
    /* relative */
  }
  return false
}

export function overlayOpenFromTakeover(state: { active?: boolean } | null | undefined): {
  openPanel: boolean
  expand: boolean
  banner: boolean
} {
  const active = Boolean(state && state.active)
  return { openPanel: active, expand: active, banner: active }
}

export function emitLoginHandoff(detail: LoginHandoffDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(LOGIN_HANDOFF_WINDOW_EVENT, { detail }))
}

export function consumeLoginHandoffSse(payload: Record<string, unknown> | null | undefined): LoginHandoffDetail | null {
  if (!payload || typeof payload !== "object") return null
  const typed = String(payload.type || "")
  const isHandoffEvent = typed === LOGIN_HANDOFF_EVENT || typed === "computer_login_handoff"
  if (!isHandoffEvent && typeof payload.active !== "boolean") return null
  if (!isHandoffEvent && payload.active !== true) return null
  const detail: LoginHandoffDetail = {
    active: Boolean(payload.active),
    conversationId: payload.conversationId == null ? null : String(payload.conversationId),
    site: payload.site == null ? undefined : String(payload.site),
    kind: payload.kind == null ? undefined : String(payload.kind),
    reason: payload.reason == null ? undefined : String(payload.reason),
    title: payload.title == null ? undefined : String(payload.title),
    instruction: payload.instruction == null ? undefined : String(payload.instruction),
    chatMessage: payload.chatMessage == null ? undefined : String(payload.chatMessage),
  }
  emitLoginHandoff(detail)
  return detail
}

export function isPasswordPasteRequest(text: string): boolean {
  return /(pega|paste|escribe|escr[ií]beme|m[aá]ndame|env[ií]ame).{0,40}(contrase|password|otp|cvv|usuario.{0,10}y.{0,10}contrase)/i.test(
    String(text || ""),
  )
}

const OPEN_COMPUTER_RE = /\b(abre|abrir|enciende|usa|usar|abre(?:me|la)?)\b.{0,48}\b(?:tu |la |el |mi )?(computadora|ordenador|navegador|browser|overlay)\b/i
const LIVE_BROWSE_RE = /\b(busca(?:r|me|le)? en vivo|buscar en vivo|en el navegador|live (?:search|browse)|navega(?:r)? (?:a|en|por)|en tu computadora)\b/i
const SHOPPING_RE = /\b(ofertas?|prendas? de vestir|shopping|comprar ropa|tienda de ropa|ropa de (?:mujer|hombre|ni[nñ][oa]s?))\b/i
const BOOKING_RE = /\b(reserva(?:r)?(?: un[oa]?| el| la)? (?:vuelo|hotel|mesa|cita|restaurante|turno)|hacer una reserva|booking)\b/i
const APPOINTMENT_RE = /\b(agend(?:a|ar)(?: una| la)? cita|pedir cita|saca(?:r)? una cita|cita (?:m[eé]dica|en el|para|del|de ))\b/i
const PORTAL_ALWAYS_RE = /\b(dmv|pasaporte|passport)\b/i

export function isAuthenticatedComputerTask(prompt: string): boolean {
  const t = String(prompt || "").toLowerCase()
  if (!t.trim()) return false
  const matched = EXAMPLE_AUTHENTICATED_TASKS.some((ex) => t.includes(ex.slice(0, 18).toLowerCase()))
  const portal =
    /\b(dmv|pasaporte|passport|seguro|insurance|reembolso|landlord|arrendador|veterinari|vet\b|departamento|apartamento|utilities|luz|agua|internet|registro del auto|in-network|m[eé]dico|boletos|tickets|permiso|proveedor|vendor|campa[nñ]a|anuncios|ads manager|hiring|candidatos|facturas|contabilidad|reventa|drop)\b/i.test(
      t,
    )
  const action =
    /\b(renueva|agenda|tramita|reclama|activa|cancela|coordina|escribe|filtra|reordena|manda|eval[uú]a|analiza|compra|cierra|avisa|busca|contacta)\b/i.test(
      t,
    )
  return matched || (portal && action)
}

export function isLiveComputerUsePrompt(prompt: string): boolean {
  const t = String(prompt || "")
  if (!t.trim()) return false
  if (OPEN_COMPUTER_RE.test(t)) return true
  if (LIVE_BROWSE_RE.test(t)) return true
  if (SHOPPING_RE.test(t)) return true
  if (BOOKING_RE.test(t)) return true
  if (APPOINTMENT_RE.test(t)) return true
  if (PORTAL_ALWAYS_RE.test(t)) return true
  return isAuthenticatedComputerTask(t)
}

export function routeAuthenticatedComputerTask(prompt: string): {
  useComputer: boolean
  loginHandoff: boolean
  askPasswordInChat: false
  openComputerInstead: true
  replyClass: "computer_use" | "text"
} {
  const live = isLiveComputerUsePrompt(prompt)
  const authenticated = isAuthenticatedComputerTask(prompt)
  return {
    useComputer: live,
    loginHandoff: authenticated,
    askPasswordInChat: false,
    openComputerInstead: true,
    replyClass: live ? "computer_use" : "text",
  }
}
