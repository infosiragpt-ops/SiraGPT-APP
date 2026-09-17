export const COMPOSER_ACCESS_STORE = "sira.composer.access"
export const COMPOSER_FAST_STORE = "sira.composer.fast"

export const COMPOSER_PERMISSIONS = [
  "default",
  "read",
  "protected",
  "workspace",
  "full",
] as const

export type ComposerPermissionId = (typeof COMPOSER_PERMISSIONS)[number]

function readStorage(name: string): string {
  if (typeof window === "undefined") return ""
  try {
    return String(window.localStorage.getItem(name) || "").trim()
  } catch {
    return ""
  }
}

function writeStorage(name: string, value: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(name, value)
  } catch {
    /* private mode */
  }
}

export function isComposerPermissionId(value: string): value is ComposerPermissionId {
  return (COMPOSER_PERMISSIONS as readonly string[]).includes(value)
}

export function readComposerPermission(): ComposerPermissionId {
  const raw = readStorage(COMPOSER_ACCESS_STORE)
  return isComposerPermissionId(raw) ? raw : "default"
}

export function writeComposerPermission(id: ComposerPermissionId) {
  writeStorage(COMPOSER_ACCESS_STORE, id)
}

export function readComposerFastMode(): boolean {
  return readStorage(COMPOSER_FAST_STORE) === "1"
}

export function writeComposerFastMode(on: boolean) {
  writeStorage(COMPOSER_FAST_STORE, on ? "1" : "0")
}

export function composerBlocksTools(id: ComposerPermissionId = readComposerPermission()): boolean {
  return id === "read" || id === "protected"
}

/**
 * Whether the composer must skip the agentic loop for this turn.
 *
 * Solo lectura runs the plain stream (no tools at all). Protegido keeps the
 * agentic loop ON: reads run freely and writes pause on the interactive
 * reviewer (permission_request card) instead of being disabled up front.
 * document-sandbox-client keeps using composerBlocksTools as its hard gate
 * because direct file ops have no reviewer UI.
 */
export function composerDisablesAgentic(id: ComposerPermissionId = readComposerPermission()): boolean {
  return id === "read" || readComposerFastMode()
}

export function composerGenerateFlags(): {
  permission: ComposerPermissionId
  disableAgentic?: true
} {
  const permission = readComposerPermission()
  if (composerDisablesAgentic(permission)) {
    return { permission, disableAgentic: true }
  }
  return { permission }
}
