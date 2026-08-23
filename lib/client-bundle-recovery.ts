/**
 * Shared stale-bundle / version-skew recovery.
 *
 * After a FE deploy, a tab can still be running the previous JS. The only
 * safe recovery is one hard reload — `reset()` remounts the same deleted
 * chunks and the error screen sticks. Used by the root `app/error.tsx`
 * and the `/code` boundary so both share the same sessionStorage guard.
 */

import { readBrowserClientBuildId } from "./client-build-id"

export const STALE_CLIENT_BUNDLE_RELOAD_PREFIX = "__siragpt_stale_reload__"

export type ClientBundleErrorLike = {
  name?: string
  message?: string
  digest?: string
  code?: string
}

function asErrorLike(error: unknown): ClientBundleErrorLike {
  if (error && typeof error === "object") return error as ClientBundleErrorLike
  return { message: error == null ? "" : String(error) }
}

export function isRecoverableClientBundleError(error: unknown): boolean {
  const err = asErrorLike(error)
  const msg = `${err.message || ""} ${err.digest || ""} ${err.code || ""}`
  return (
    /Failed to find Server Action/i.test(msg)
    || /ChunkLoadError/i.test(err.name || "")
    || /ChunkLoadError/i.test(msg)
    || /Loading chunk \S+ failed/i.test(msg)
    || /Loading CSS chunk/i.test(msg)
    || /Failed to fetch dynamically imported module/i.test(msg)
    || (/ReferenceError/i.test(err.name || "") && /\bis not defined\b/i.test(msg))
  )
}

export function staleClientBundleSignature(error: unknown): string {
  const err = asErrorLike(error)
  return `${err.name || "Error"}:${err.message || err.digest || "unknown"}`
    .slice(0, 160)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
}

/**
 * Live Next documents key the stale-reload guard by `__NEXT_DATA__.buildId`
 * (e.g. `9NdPlPdIifS4deZzUFUr1` on siragpt.com). Prefer that so /code and
 * the root boundary share the same sessionStorage slot as production.
 */
export function readStaleReloadBuildId(): string {
  if (typeof window !== "undefined") {
    const nextId = (window as unknown as { __NEXT_DATA__?: { buildId?: string } })
      .__NEXT_DATA__?.buildId
    const trimmed = String(nextId || "").trim()
    if (trimmed && trimmed !== "unknown") return trimmed
  }
  return readBrowserClientBuildId()
}

export function staleClientBundleReloadKey(
  error: unknown,
  buildId = readStaleReloadBuildId(),
): string {
  return `${STALE_CLIENT_BUNDLE_RELOAD_PREFIX}:${buildId || "unknown"}:${staleClientBundleSignature(error)}`
}

export function shouldHardReloadStaleClientBundle(
  error: unknown,
  storage: Pick<Storage, "getItem"> | null | undefined,
  buildId?: string,
): boolean {
  if (!isRecoverableClientBundleError(error) || !storage) return false
  try {
    return !storage.getItem(staleClientBundleReloadKey(error, buildId))
  } catch {
    return false
  }
}

export function markStaleClientBundleReload(
  error: unknown,
  storage: Pick<Storage, "setItem"> | null | undefined,
  buildId?: string,
  now = Date.now(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(staleClientBundleReloadKey(error, buildId), String(now))
    return true
  } catch {
    return false
  }
}

export function maybeReloadStaleClientBundle(
  error: unknown,
  options: {
    storage?: Pick<Storage, "getItem" | "setItem"> | null
    reload?: () => void
    buildId?: string
    now?: number
  } = {},
): boolean {
  const storage = options.storage ?? (
    typeof sessionStorage !== "undefined" ? sessionStorage : null
  )
  const buildId = options.buildId || readStaleReloadBuildId()
  if (!shouldHardReloadStaleClientBundle(error, storage, buildId)) return false
  markStaleClientBundleReload(error, storage, buildId, options.now)
  const reload = options.reload ?? (() => {
    if (typeof window !== "undefined") window.location.reload()
  })
  reload()
  return true
}
