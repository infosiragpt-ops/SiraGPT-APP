/**
 * Stale-deployment recovery shared by the route error boundaries
 * (`app/error.tsx`, `app/admin/error.tsx`).
 *
 * After a deploy, a tab still running the previous bundle cannot load the new
 * chunks: ChunkLoadError, «Loading chunk N failed», a Server Action the server
 * no longer knows, or a lazily loaded symbol that «is not defined». The
 * boundary's `reset()` re-renders with the same stale chunks and loops; the
 * only real fix is one hard reload that fetches the new bundle.
 *
 * The reload is guarded per (build, error) in sessionStorage so a genuinely
 * broken build cannot reload forever, and the guard expires after a cooldown
 * so the next deployment gets a fresh chance even when the build id is not
 * exposed to the client (the app router does not publish `__NEXT_DATA__`).
 */

export type BoundaryError = Error & { digest?: string }

export const STALE_RELOAD_KEY_PREFIX = "__siragpt_stale_reload__"
export const STALE_RELOAD_COOLDOWN_MS = 10 * 60 * 1000

type StorageLike = Pick<Storage, "getItem" | "setItem">

export function isRecoverableClientBundleError(err: BoundaryError | null | undefined): boolean {
  if (!err) return false
  const msg = `${err.message || ""} ${err.digest || ""}`
  const name = err.name || ""
  return (
    /Failed to find Server Action/i.test(msg) ||
    /ChunkLoadError/i.test(name) ||
    /ChunkLoadError/i.test(msg) ||
    /Loading chunk \S+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    (/ReferenceError/i.test(name) && /\bis not defined\b/i.test(msg))
  )
}

export function currentBuildId(win: unknown = typeof window === "undefined" ? undefined : window): string {
  const data = (win as { __NEXT_DATA__?: { buildId?: string } } | undefined)?.__NEXT_DATA__
  return (data && typeof data.buildId === "string" && data.buildId) || "unknown"
}

export function staleReloadKey(err: BoundaryError, buildId: string = currentBuildId()): string {
  const signature = `${err.name || "Error"}:${err.message || err.digest || "unknown"}`
    .slice(0, 160)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
  return `${STALE_RELOAD_KEY_PREFIX}:${buildId}:${signature}`
}

export type StaleReloadOptions = {
  storage?: StorageLike
  reload?: () => void
  buildId?: string
  now?: () => number
  cooldownMs?: number
}

/**
 * Hard-reload once for a stale-bundle error. Returns true when a reload was
 * triggered, false when the error is not a stale-bundle error, when this tab
 * already reloaded for it inside the cooldown, or when storage is unavailable
 * (private mode): the caller then shows its fallback UI.
 */
export function reloadOnceForStaleBundle(err: BoundaryError | null | undefined, opts: StaleReloadOptions = {}): boolean {
  if (!err || !isRecoverableClientBundleError(err)) return false
  const hasWindow = typeof window !== "undefined"
  if (!hasWindow && (!opts.storage || !opts.reload)) return false
  try {
    const storage: StorageLike = opts.storage ?? window.sessionStorage
    const now = opts.now ? opts.now() : Date.now()
    const cooldownMs = opts.cooldownMs ?? STALE_RELOAD_COOLDOWN_MS
    const key = staleReloadKey(err, opts.buildId ?? currentBuildId())
    const previous = Number(storage.getItem(key) || 0)
    if (Number.isFinite(previous) && previous > 0 && now - previous < cooldownMs) return false
    storage.setItem(key, String(now))
    const reload = opts.reload ?? (() => window.location.reload())
    reload()
    return true
  } catch {
    return false
  }
}
