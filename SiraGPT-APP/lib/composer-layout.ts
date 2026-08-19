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
