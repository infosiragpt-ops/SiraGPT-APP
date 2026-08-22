import {
  isRecoverableClientBundleError,
  markStaleClientBundleReload,
  shouldHardReloadStaleClientBundle,
  staleClientBundleReloadKey,
} from "./client-bundle-recovery"
import { isChunkLoadOrBuildSkewError } from "./code-workspace-errors"
import { readBrowserClientBuildId } from "./client-build-id"

export const CODE_ERROR_RESET_DELAY_MS = 750
export const CODE_ERROR_RESET_KEY_PREFIX = "__siragpt_code_error_reset__"
export const CODE_BUILD_RELOAD_KEY_PREFIX = "__siragpt_code_build_reload__"

export type CodeErrorLike = Error & { digest?: string; code?: string }
export type CodeErrorRecoveryPhase = "recovering" | "exhausted"

function digestOf(error: CodeErrorLike | null | undefined): string {
  const digest = String(error?.digest || error?.name || error?.message || "unknown")
    .slice(0, 160)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
  return digest || "unknown"
}

export function codeErrorResetStorageKey(error: CodeErrorLike | null | undefined): string {
  return `${CODE_ERROR_RESET_KEY_PREFIX}${digestOf(error)}`
}

export function codeBuildReloadStorageKey(buildId = readBrowserClientBuildId()): string {
  return `${CODE_BUILD_RELOAD_KEY_PREFIX}${buildId || "unknown"}`
}

export function shouldAutoResetCodeWorkspaceError(
  error: CodeErrorLike | null | undefined,
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  if (!error || !storage) return false
  if (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error)) {
    return false
  }
  try {
    return !storage.getItem(codeErrorResetStorageKey(error))
  } catch {
    return false
  }
}

export function markCodeWorkspaceErrorReset(
  error: CodeErrorLike | null | undefined,
  storage: Pick<Storage, "setItem"> | null | undefined,
  now = Date.now(),
): boolean {
  if (!error || !storage) return false
  try {
    storage.setItem(codeErrorResetStorageKey(error), String(now))
    return true
  } catch {
    return false
  }
}

export function shouldReloadForBuildSkew(
  error: unknown,
  storage: Pick<Storage, "getItem"> | null | undefined,
  buildId = readBrowserClientBuildId(),
): boolean {
  if (!isChunkLoadOrBuildSkewError(error) || !storage) return false
  if (isRecoverableClientBundleError(error)) {
    return shouldHardReloadStaleClientBundle(error, storage, buildId)
  }
  try {
    return !storage.getItem(staleClientBundleReloadKey(error, buildId))
  } catch {
    return false
  }
}

export function markBuildSkewReload(
  error: unknown,
  storage: Pick<Storage, "setItem"> | null | undefined,
  buildId = readBrowserClientBuildId(),
  now = Date.now(),
): boolean {
  if (!storage) return false
  if (isRecoverableClientBundleError(error)) {
    return markStaleClientBundleReload(error, storage, buildId, now)
  }
  try {
    storage.setItem(staleClientBundleReloadKey(error, buildId), String(now))
    return true
  } catch {
    return false
  }
}

export function resolveCodeWorkspaceErrorPhase(
  error: CodeErrorLike | null | undefined,
  storage: Pick<Storage, "getItem"> | null | undefined,
  buildId = readBrowserClientBuildId(),
): CodeErrorRecoveryPhase {
  if (!error) return "recovering"
  if (isRecoverableClientBundleError(error) || isChunkLoadOrBuildSkewError(error)) {
    return shouldReloadForBuildSkew(error, storage, buildId) ? "recovering" : "exhausted"
  }
  return shouldAutoResetCodeWorkspaceError(error, storage) ? "recovering" : "exhausted"
}
