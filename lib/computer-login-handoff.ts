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
} as const

export const LOGIN_HANDOFF_POLICY_ES = [
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

export function instructionForSite(site?: string | null): string {
  const host = String(site || "").trim()
  if (!host) return LOGIN_HANDOFF_COPY.instruction
  return `Inicia sesión en ${host}`
}

export function emitLoginHandoff(detail: LoginHandoffDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(LOGIN_HANDOFF_WINDOW_EVENT, { detail }))
}

export function isPasswordPasteRequest(text: string): boolean {
  return /(pega|paste|escribe|escr[ií]beme|m[aá]ndame|env[ií]ame).{0,40}(contrase|password|otp|cvv|usuario.{0,10}y.{0,10}contrase)/i.test(
    String(text || ""),
  )
}

export function routeAuthenticatedComputerTask(prompt: string): {
  useComputer: boolean
  loginHandoff: boolean
  askPasswordInChat: false
  openComputerInstead: true
} {
  const t = String(prompt || "").toLowerCase()
  const matched = EXAMPLE_AUTHENTICATED_TASKS.some((ex) => t.includes(ex.slice(0, 18).toLowerCase()))
  const portal =
    /\b(dmv|pasaporte|passport|seguro|insurance|reembolso|landlord|arrendador|veterinari|vet\b|departamento|apartamento|utilities|luz|agua|internet|registro del auto|in-network|m[eé]dico|boletos|tickets|permiso|proveedor|vendor|campa[nñ]a|anuncios|ads manager|hiring|candidatos|facturas|contabilidad|reventa|drop)\b/i.test(
      t,
    )
  const action =
    /\b(renueva|agenda|tramita|reclama|activa|cancela|coordina|escribe|filtra|reordena|manda|eval[uú]a|analiza|compra|cierra|avisa|busca|contacta)\b/i.test(
      t,
    )
  const authenticated = matched || (portal && action)
  return {
    useComputer: authenticated,
    loginHandoff: authenticated,
    askPasswordInChat: false,
    openComputerInstead: true,
  }
}
