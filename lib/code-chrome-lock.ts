/**
 * /code desktop chrome lock — single source of truth.
 *
 * Engine-only waves and FE image recreates used to resurrect VPS hot-patches
 * that hid Panel / Controlar / Archivos / Recursos and the green
 * Ejecutar / Publicar buttons. Those selectors now live here so the UI
 * and the CI continuity guards cannot drift.
 *
 * Keep: Routines (reserved slot) + Computadora (noVNC / ACS).
 * Hide on phones: WorkspaceTopBar (Grok chrome owns the header).
 */

export const CODE_CHROME_LOCK_VERSION = "2026-08-23"

export const CODE_FORBIDDEN_DESKTOP_NAV_LABELS = [
  "Panel",
  "Controlar",
  "Archivos",
  "Recursos",
] as const

export const CODE_FORBIDDEN_TOPBAR_ACTIONS = ["Ejecutar", "Publicar"] as const

export const CODE_KEPT_SURFACES = ["Routines", "Computadora"] as const

export const CODE_CHROME_LOCK = {
  version: CODE_CHROME_LOCK_VERSION,
  forbiddenDesktopNavLabels: CODE_FORBIDDEN_DESKTOP_NAV_LABELS,
  forbiddenTopBarActions: CODE_FORBIDDEN_TOPBAR_ACTIONS,
  keptSurfaces: CODE_KEPT_SURFACES,
  /** Company nav rows for the four forbidden labels stay unmounted. */
  showForbiddenCompanyNav: false,
  /** Green Ejecutar + Publicar stay unmounted on the desktop top bar. */
  showRunPublishButtons: false,
  /** Phone /code uses Grok chrome; the desktop top bar must not overlay. */
  hideDesktopTopBarOnPhone: true,
} as const

export function isForbiddenCompanyNavLabel(label: string): boolean {
  return (CODE_FORBIDDEN_DESKTOP_NAV_LABELS as readonly string[]).includes(label)
}

export function isForbiddenTopBarAction(label: string): boolean {
  return (CODE_FORBIDDEN_TOPBAR_ACTIONS as readonly string[]).includes(label)
}
