/**
 * dev-log — `console.log` you can leave in production code without
 * spamming the user's browser devtools.
 *
 * Why: a clean console is part of "professional software." The chat
 * surface had ~30 informational logs (Word/Excel connector
 * lifecycle, computer-use orchestration, intent flags) that were
 * useful while debugging but show up as noise for every end user.
 *
 * Behaviour:
 *   · NODE_ENV === "development"  → calls `console.log`
 *   · NODE_ENV === "production"   → no-op (zero cost at runtime)
 *   · Also activates when `localStorage.siragptDebug === "1"`, so a
 *     support engineer can flip it on in prod without redeploying.
 *
 * `devError` and `devWarn` exist for symmetry but they always log
 * — production errors are usually worth surfacing.
 */

const isDev =
  typeof process !== "undefined" && process.env?.NODE_ENV !== "production"

function debugFlagOn(): boolean {
  if (isDev) return true
  if (typeof window === "undefined") return false
  try {
    return window.localStorage?.getItem("siragptDebug") === "1"
  } catch {
    return false
  }
}

export function devLog(...args: unknown[]): void {
  if (!debugFlagOn()) return
  // eslint-disable-next-line no-console
  console.log(...args)
}

export function devWarn(...args: unknown[]): void {
  if (!debugFlagOn()) return
  // eslint-disable-next-line no-console
  console.warn(...args)
}

// Errors always log — they're load-bearing for incident triage.
export function devError(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(...args)
}
