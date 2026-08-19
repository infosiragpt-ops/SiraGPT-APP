/**
 * Task 29 — discreet sub-text shown by the Appshots settings page when the
 * backend reports `geoHintStatus !== 'ok'` for a device.
 *
 * Lives in lib/ (not in the page file) because Next.js App Router page
 * files only allow a fixed allowlist of named exports — any extra export
 * breaks the production build — and the unit test needs to import it.
 */
export type GeoHintStatus = 'ok' | 'private' | 'unresolved'

export function describeGeoHintStatus(status: GeoHintStatus): string | null {
  // Copy intentionally short and neutral. Anything longer would push the
  // device card onto a third visual line and start competing for
  // attention with the "Último uso" timestamp.
  switch (status) {
    case 'private':
      return 'Ubicación no disponible (red privada)'
    case 'unresolved':
      return 'Ubicación no disponible'
    case 'ok':
    default:
      return null
  }
}
