/**
 * hero-presentation — small pure helpers extracted out of
 * `components/chat/ChatEmptyStateHero.tsx` so they can be unit-tested
 * without mounting the whole React tree.
 *
 *   · `pickGreeting(date)` — time-of-day greeting in Spanish. The
 *     mapping is: 0–5 → "Buenas noches", 6–12 → "Buenos días",
 *     13–19 → "Buenas tardes", 20–23 → "Buenas noches". Accepts an
 *     explicit Date so tests don't need to monkey-patch `new Date()`.
 *   · `pickDisplayName(name)` — returns the first whitespace-split
 *     token, capped at 24 chars, or null if the input is empty /
 *     all-whitespace / a single token longer than the cap.
 *   · `sampleSixFromPool(pool, rng?)` — Fisher–Yates shuffle on a
 *     copy of `pool`, then slice 6. `rng` defaults to `Math.random`
 *     and is overridable for deterministic tests. Throws on a pool
 *     smaller than 6 because we always render a 6-cell grid.
 */

export function pickGreeting(date: Date = new Date()): string {
  const hour = date.getHours()
  if (hour < 6) return "Buenas noches"
  if (hour < 13) return "Buenos días"
  if (hour < 20) return "Buenas tardes"
  return "Buenas noches"
}

export function pickDisplayName(userName?: string | null): string | null {
  if (!userName) return null
  const trimmed = userName.trim()
  if (!trimmed) return null
  const first = trimmed.split(/\s+/)[0]
  if (!first || first.length > 24) return null
  return first
}

export function sampleSixFromPool<T>(pool: readonly T[], rng: () => number = Math.random): T[] {
  if (pool.length < 6) {
    throw new Error(`sampleSixFromPool requires at least 6 elements, got ${pool.length}`)
  }
  const a = [...pool]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, 6)
}
