// codex/format — pure formatting helpers for the cards (features 11–12). No
// React; unit-testable. Spanish-first; feature 14 swaps the literals for i18n.

/** "hace 2 min" style relative time from an ISO/Date to `now`. */
export function relativeTime(from: string | number | Date, now: number = Date.now()): string {
  const t = typeof from === "number" ? from : new Date(from).getTime()
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return "ahora"
  if (s < 60) return `hace ${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.floor(h / 24)
  return `hace ${d} d`
}

/** "Worked for N minutes" → humanized duration from ms. */
export function humanizeDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem ? `${m} min ${rem} s` : `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

/** "$0.0042" style — small costs get more decimals; 0 → "$0". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Whether to show the struck-through original price (only when it differs). */
export function shouldStrikethrough(original: number, applied: number): boolean {
  return Number.isFinite(original) && Number.isFinite(applied) && original > applied + 1e-9
}
