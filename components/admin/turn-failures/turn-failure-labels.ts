import type { TurnFailureCategory, TurnFailureSeverity } from "@/lib/admin/turn-failures-types"

export const CATEGORY_LABELS: Record<TurnFailureCategory, string> = {
  sin_respuesta: "Sin respuesta",
  colgado: "Se quedó colgado",
  sin_cierre: "Turno sin cerrar",
  adjunto_perdido: "Adjunto perdido",
  error_visible: "Error visible",
  herramienta_fallida: "Herramienta fallida",
  cancelado_por_sistema: "Cancelado por el sistema",
  respuesta_no_entendible: "Respuesta no entendible",
  usuario_reporto: "Reportado por el usuario",
}

export const CATEGORY_HINTS: Record<TurnFailureCategory, string> = {
  sin_respuesta: "El turno terminó sin texto ni archivo para el usuario.",
  colgado: "No llegó la primera respuesta a tiempo o se quedó pensando.",
  sin_cierre: "El turno nunca se finalizó (sin actividad por más de 10 min).",
  adjunto_perdido: "Un archivo adjunto no estaba disponible al responder.",
  error_visible: "El usuario vio un mensaje de error o de respaldo.",
  herramienta_fallida: "Una herramienta (editor, agente, transcripción…) falló.",
  cancelado_por_sistema: "El sistema canceló el turno antes de responder.",
  respuesta_no_entendible: "Hubo respuesta, pero no se puede usar (marcas internas, eco, idioma…).",
  usuario_reporto: "El usuario marcó la respuesta con pulgar abajo.",
}

export const CATEGORY_ORDER: TurnFailureCategory[] = [
  "sin_respuesta",
  "colgado",
  "sin_cierre",
  "adjunto_perdido",
  "error_visible",
  "herramienta_fallida",
  "cancelado_por_sistema",
  "respuesta_no_entendible",
  "usuario_reporto",
]

export function categoryLabel(category?: string | null, fallback?: string | null): string {
  if (category && category in CATEGORY_LABELS) return CATEGORY_LABELS[category as TurnFailureCategory]
  return fallback || category || "Fallo"
}

/** Muted admin palette: red for critical, amber for high, zinc for medium. */
export function severityBadgeClass(severity?: TurnFailureSeverity | string | null): string {
  switch (severity) {
    case "critical":
      return "border-red-200 bg-red-50 text-red-700"
    case "high":
      return "border-amber-200 bg-amber-50 text-amber-800"
    case "medium":
      return "border-zinc-200 bg-zinc-100 text-zinc-700"
    default:
      return "border-zinc-200 bg-white text-zinc-600"
  }
}

export function severityDotClass(severity?: TurnFailureSeverity | string | null): string {
  switch (severity) {
    case "critical":
      return "bg-red-500"
    case "high":
      return "bg-amber-500"
    case "medium":
      return "bg-zinc-400"
    default:
      return "bg-zinc-300"
  }
}

export function severityLabel(severity?: TurnFailureSeverity | string | null): string {
  switch (severity) {
    case "critical":
      return "Crítico"
    case "high":
      return "Alto"
    case "medium":
      return "Medio"
    case "low":
      return "Bajo"
    default:
      return "—"
  }
}

export function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  if (m < 60) return `${m} min ${rest ? `${rest} s` : ""}`.trim()
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "medium" })
  } catch {
    return iso
  }
}

export function formatRelative(iso?: string | null, now = Date.now()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const diff = Math.max(0, now - t)
  const min = Math.round(diff / 60000)
  if (min < 1) return "hace segundos"
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

export function trendLabel(trendPct: number | null, isNew: boolean): { text: string; tone: "up" | "down" | "flat" | "new" } {
  if (isNew) return { text: "Nuevo", tone: "new" }
  if (trendPct == null) return { text: "—", tone: "flat" }
  if (trendPct > 0) return { text: `↑ ${trendPct}%`, tone: "up" }
  if (trendPct < 0) return { text: `↓ ${Math.abs(trendPct)}%`, tone: "down" }
  return { text: "= 0%", tone: "flat" }
}
