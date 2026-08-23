/**
 * /code desktop chrome lock — single source of truth.
 *
 * Production chrome must match the golden /code UI:
 * - No green header Ejecutar / Detener / Arrancando control
 * - No company-home nav rows for Panel / Controlar / Archivos / Recursos
 * - Keep black Publicar, Routines, and Computadora (noVNC / ACS)
 *
 * Engine-only waves and FE image recreates used to resurrect those
 * controls. The selectors live here so the UI and CI guards cannot drift.
 */

export const CODE_CHROME_LOCK_VERSION = "2026-08-23-arrancando-ban"

export const CODE_FORBIDDEN_DESKTOP_NAV_LABELS = [
  "Panel",
  "Controlar",
  "Archivos",
  "Recursos",
] as const

/** Green header run/stop labels. Publicar is kept and is NOT in this list. */
export const CODE_FORBIDDEN_TOPBAR_ACTIONS = [
  "Arrancando",
  "Arrancando…",
  "Ejecutar",
  "Detener",
] as const

export const CODE_KEPT_SURFACES = ["Routines", "Computadora", "Publicar"] as const

export const CODE_CHROME_LOCK = {
  version: CODE_CHROME_LOCK_VERSION,
  forbiddenDesktopNavLabels: CODE_FORBIDDEN_DESKTOP_NAV_LABELS,
  forbiddenTopBarActions: CODE_FORBIDDEN_TOPBAR_ACTIONS,
  keptSurfaces: CODE_KEPT_SURFACES,
  /** Company nav rows for the four forbidden labels stay unmounted. */
  showForbiddenCompanyNav: false,
  /** Emerald Ejecutar / Detener / Arrancando header control stays unmounted. */
  showHeaderRunStopButton: false,
  /** Black zinc-900 Publicar stays mounted on the desktop top bar. */
  keepPublishButton: true,
  /** Phone /code uses Grok chrome; the desktop top bar must not overlay. */
  hideDesktopTopBarOnPhone: true,
} as const

export function isForbiddenCompanyNavLabel(label: string): boolean {
  return (CODE_FORBIDDEN_DESKTOP_NAV_LABELS as readonly string[]).includes(label)
}

export function isForbiddenTopBarAction(label: string): boolean {
  const trimmed = label.replace(/…/g, "").trim()
  return (CODE_FORBIDDEN_TOPBAR_ACTIONS as readonly string[]).some(
    (forbidden) => forbidden.replace(/…/g, "") === trimmed,
  )
}

export function isKeptSurface(label: string): boolean {
  return (CODE_KEPT_SURFACES as readonly string[]).includes(label)
}
