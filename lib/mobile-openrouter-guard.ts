
/** OLA200_WAVE_G FE-095 — APK / Capacitor must never embed OPENROUTER_API_KEY. No keys invented. */
export const MOBILE_OPENROUTER_EMBEDDED = false
export function assertNoEmbeddedOpenRouterKey(source: string): { ok: boolean; hits: number } {
  const text = String(source || "")
  const hits = (text.match(/OPENROUTER_API_KEY/g) || []).length + (text.match(/openrouter\.ai\/api/gi) || []).length
  return { ok: hits === 0, hits }
}
export function mobileHealthChecksum(source: string): { openrouterEmbedded: false; ok: boolean } {
  const check = assertNoEmbeddedOpenRouterKey(source)
  return { openrouterEmbedded: false, ok: check.ok }
}
