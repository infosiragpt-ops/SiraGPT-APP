/**
 * plans-catalog — single source of truth for the TWO plans SiraGPT sells.
 *
 *   1. "Pro"      — $10 USD / mes, paid through Stripe Checkout. Backed by
 *                   the backend plan code `PRO_MAX` (already priced at $10
 *                   in every backend catalog, so no billing math changes).
 *   2. "Hablemos" — contact-only (teams / enterprise). Opens WhatsApp with a
 *                   pre-filled message; no self-serve checkout.
 *
 * Pure module (no React, no fetch) so the root `node --test` tier can cover
 * it. Every surface that shows plans (/planes, landing pricing, billing
 * page, upgrade redirect) reads from here — never duplicate the copy.
 */

export type PlanCode = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

export const PAID_PLAN_CODE: PlanCode = "PRO_MAX"

export const PAID_PLAN = {
  code: PAID_PLAN_CODE,
  name: "Pro",
  tagline: "Investiga, crea y trabaja con IA sin límites artificiales",
  priceUsd: 10,
  priceLabel: "10 $",
  periodLabel: "USD / mes",
  billingNote: "Facturado mensualmente",
  cta: "Elegir Pro",
  ctaCurrent: "Plan actual",
  ctaManage: "Gestionar suscripción",
  reassurance: "Sin compromiso · Cancela cuando quieras",
  featuresIntro: "Todo lo de Gratis y:",
  features: [
    "Agentes que investigan y ejecutan tareas por ti",
    "Documentos, hojas de cálculo y presentaciones profesionales",
    "Imágenes, diagramas y contenido visual en segundos",
    "Límites de uso más altos y acceso prioritario",
    "Memoria que se mantiene entre conversaciones",
    "Soporte prioritario por WhatsApp",
  ],
} as const

export const CONTACT_PLAN = {
  code: "ENTERPRISE" as PlanCode,
  name: "Hablemos",
  tagline: "Equipos y empresas con necesidades a medida",
  priceLabel: "A medida",
  periodLabel: "Plan personalizado",
  billingNote: "Te respondemos el mismo día",
  cta: "Escríbenos por WhatsApp",
  reassurance: "Sin compromiso · Cotización en minutos",
  featuresIntro: "Todo lo incluido en Pro, más:",
  features: [
    "Cuentas para todo tu equipo con facturación única",
    "Integraciones con tus sistemas y flujos internos",
    "Seguridad, permisos y control de accesos",
    "Acompañamiento directo en la implementación",
    "Condiciones y volumen a la medida de tu operación",
  ],
} as const

/** Human labels for every backend plan code (badges, profile, receipts). */
export const PLAN_DISPLAY_NAMES: Record<PlanCode, string> = {
  FREE: "Gratis",
  PRO: "Pro",
  PRO_MAX: "Pro",
  ENTERPRISE: "Enterprise",
}

export function planDisplayName(code: string | null | undefined): string {
  const key = String(code || "FREE").toUpperCase() as PlanCode
  return PLAN_DISPLAY_NAMES[key] || PLAN_DISPLAY_NAMES.FREE
}

/** True when the account already has a paid tier (nothing left to buy). */
export function isPaidPlanCode(code: string | null | undefined): boolean {
  const key = String(code || "").toUpperCase()
  return key === "PRO" || key === "PRO_MAX" || key === "ENTERPRISE"
}

export const SALES_WHATSAPP_MESSAGE =
  "Hola 👋, me interesa el plan Hablemos de SiraGPT para mi equipo. ¿Podemos conversar?"

export const PRO_WHATSAPP_MESSAGE =
  "Hola 👋, quiero activar el plan Pro de SiraGPT ($10/mes). ¿Me ayudan?"

/** Keep only digits so "+51 999 123 456" and "51999123456" both work. */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  const digits = String(raw || "").replace(/\D+/g, "")
  return digits.length >= 7 ? digits : null
}

/**
 * Build a wa.me deep link. Returns null when there is no usable number so
 * callers can fall back to /support instead of shipping a broken link.
 */
export function buildWhatsAppHref(
  number: string | null | undefined,
  message: string = SALES_WHATSAPP_MESSAGE,
): string | null {
  const phone = normalizeWhatsAppNumber(number)
  if (!phone) return null
  const text = message ? `?text=${encodeURIComponent(message)}` : ""
  return `https://wa.me/${phone}${text}`
}

/**
 * Resolve the sales number: runtime value (from /api/payments/config) wins
 * over the build-time NEXT_PUBLIC_WHATSAPP_NUMBER so production can change
 * the number without rebuilding the frontend image.
 */
export function resolveWhatsAppNumber(runtimeNumber?: string | null): string | null {
  const buildTime =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WHATSAPP_NUMBER : undefined
  return normalizeWhatsAppNumber(runtimeNumber) || normalizeWhatsAppNumber(buildTime)
}

export const SUPPORT_FALLBACK_PATH = "/support"

export type CheckoutErrorKind = "unavailable" | "auth" | "validation" | "generic"

export interface CheckoutErrorInfo {
  kind: CheckoutErrorKind
  message: string
  whatsappNumber: string | null
}

/**
 * Turn any error thrown by apiClient.createStripePayment into a Spanish,
 * user-facing message. A 503 (Stripe not configured) is NOT a bug the user
 * can fix — steer them to WhatsApp instead of showing a raw provider error.
 */
export function describeCheckoutError(err: unknown): CheckoutErrorInfo {
  const e = (err || {}) as {
    status?: number
    statusCode?: number
    message?: string
    errorData?: { message?: string; code?: string; whatsappNumber?: string | null }
  }
  const status = e.status ?? e.statusCode
  const data = e.errorData || {}
  const rawMessage = String(e.message || "")
  const whatsappNumber = normalizeWhatsAppNumber(data.whatsappNumber)

  if (status === 503 || data.code === "STRIPE_NOT_CONFIGURED" || /not configured/i.test(rawMessage)) {
    return {
      kind: "unavailable",
      message:
        data.message ||
        "El pago con tarjeta aún no está habilitado. Escríbenos por WhatsApp y activamos tu plan Pro en minutos.",
      whatsappNumber,
    }
  }
  if (status === 401) {
    return { kind: "auth", message: "Tu sesión expiró. Inicia sesión de nuevo para continuar.", whatsappNumber }
  }
  if (status === 400) {
    return { kind: "validation", message: data.message || "No pudimos preparar el pago. Inténtalo de nuevo.", whatsappNumber }
  }
  return {
    kind: "generic",
    message: data.message || rawMessage || "No pudimos iniciar el pago. Inténtalo de nuevo en unos segundos.",
    whatsappNumber,
  }
}
