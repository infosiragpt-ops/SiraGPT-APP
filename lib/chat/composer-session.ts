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
  return isComposerPermissionId(raw) ? raw : "full"
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

export function composerGenerateFlags(): {
  permission: ComposerPermissionId
  disableAgentic?: true
} {
  const permission = readComposerPermission()
  if (composerBlocksTools(permission) || readComposerFastMode()) {
    return { permission, disableAgentic: true }
  }
  return { permission }
}
