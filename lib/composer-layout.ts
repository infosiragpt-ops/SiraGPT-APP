/**
 * Composer layout helpers.
 *
 * Idle / single-line: compact ChatGPT-style row
 *   [+]  [textarea]  [model · mic · send]
 *
 * Multi-line: stacked professional capsule
 *   [full-width textarea]
 *   [+]                    [model · mic · send]
 *
 * The toolbar (including the model picker) always sits on the footer
 * once the prompt wraps, so the growing text never pushes the model
 * sideways or clips it.
 */

export const COMPOSER_TEXTAREA_MIN_PX = 26
export const COMPOSER_TEXTAREA_EXPANDED_MIN_PX = 136
export const COMPOSER_STACK_DELTA_PX = 10
export const COMPOSER_STACK_HOLD_CHARS = 48

export function shouldStackComposer({
  scrollHeight,
  minHeight = COMPOSER_TEXTAREA_MIN_PX,
  hasExplicitNewline = false,
  charCount = 0,
  currentlyStacked = false,
}: {
  scrollHeight: number
  minHeight?: number
  hasExplicitNewline?: boolean
  charCount?: number
  currentlyStacked?: boolean
}): boolean {
  if (hasExplicitNewline) return true
  if (scrollHeight > minHeight + COMPOSER_STACK_DELTA_PX) return true
  // Once the model is on the footer, keep it there for a real draft so a
  // wider stacked textarea cannot immediately collapse back to the idle row.
  if (currentlyStacked && charCount > COMPOSER_STACK_HOLD_CHARS) return true
  return false
}

export function measureComposerTextarea({
  scrollHeight,
  minHeight = COMPOSER_TEXTAREA_MIN_PX,
  maxHeight,
  hasExplicitNewline = false,
  charCount = 0,
  currentlyStacked = false,
}: {
  scrollHeight: number
  minHeight?: number
  maxHeight: number
  hasExplicitNewline?: boolean
  charCount?: number
  currentlyStacked?: boolean
}): {
  height: number
  overflowY: "auto" | "hidden"
  stacked: boolean
} {
  const safeMax = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 200
  const height = Math.min(safeMax, Math.max(minHeight, scrollHeight))
  const overflowY = scrollHeight > safeMax + 1 ? "auto" : "hidden"
  return {
    height,
    overflowY,
    stacked: shouldStackComposer({
      scrollHeight,
      minHeight,
      hasExplicitNewline,
      charCount,
      currentlyStacked,
    }),
  }
}


/** OLA200_WAVE_G FE-048 — memoize measure to cut layout thrash (no chip moves). */
const _measureCache = new Map<string, ReturnType<typeof measureComposerTextarea>>()
const MEASURE_CACHE_MAX = 64
export function composerMeasureCacheKey(input: { scrollHeight: number; minHeight?: number; maxHeight: number; hasExplicitNewline?: boolean; charCount?: number; currentlyStacked?: boolean }): string {
  return [input.scrollHeight|0, (input.minHeight ?? COMPOSER_TEXTAREA_MIN_PX)|0, input.maxHeight|0, input.hasExplicitNewline?1:0, (input.charCount??0)|0, input.currentlyStacked?1:0].join(":")
}
export function memoizedMeasureComposerTextarea(input: Parameters<typeof measureComposerTextarea>[0]): ReturnType<typeof measureComposerTextarea> {
  const key = composerMeasureCacheKey(input)
  const hit = _measureCache.get(key)
  if (hit) return hit
  const value = measureComposerTextarea(input)
  if (_measureCache.size >= MEASURE_CACHE_MAX) { const first = _measureCache.keys().next().value; if (first !== undefined) _measureCache.delete(first) }
  _measureCache.set(key, value)
  return value
}

/** Content must exceed ~2 compact lines before Ampliar appears. */
export const COMPOSER_EXPAND_OVERFLOW_PX = 12

/**
 * ChatGPT-like visibility:
 * show Contraer while expanded; show Ampliar only when collapsed text
 * actually overflows / wraps past the compact single-line height.
 * Empty or short greetings stay icon-free.
 */
export function shouldShowComposerExpandControl({
  scrollHeight,
  clientHeight = 0,
  minHeight = COMPOSER_TEXTAREA_MIN_PX,
  expanded = false,
  value = "",
  charCount,
}: {
  scrollHeight: number
  clientHeight?: number
  minHeight?: number
  expanded?: boolean
  value?: string
  charCount?: number
}): boolean {
  if (expanded) return true
  const text = value
  if (!text.trim()) return false
  const lines = text.split("\n").length
  if (lines > 2) return true
  const chars = charCount ?? text.length
  // Narrow phone composer is ~36-40 glyphs/line. 96+ wraps past two lines.
  // Stay high so "Hola cómo estas" never flashes the icon on every word.
  if (chars >= 96) return true
  if (clientHeight > 0 && scrollHeight > clientHeight + 1) return true
  if (scrollHeight > minHeight + COMPOSER_EXPAND_OVERFLOW_PX) return true
  return false
}
