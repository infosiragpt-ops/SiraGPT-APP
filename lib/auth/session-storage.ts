export const AUTH_TOKEN_STORAGE_KEY = "auth-token"
export const AUTH_SESSION_STORAGE_KEY = "siragpt.auth.session.v1"

export type AuthTokenSource = "credentials" | "local-demo" | "token" | "refresh" | "unknown"

export interface AuthSessionRecord {
  version: 1
  tokenFingerprint: string
  source: AuthTokenSource
  issuedAt: number
  expiresAt?: number
}

export interface StoredAuthSession {
  token: string | null
  session: AuthSessionRecord | null
  expired: boolean
}

export interface AuthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface WriteAuthTokenOptions {
  source?: AuthTokenSource
  expiresAt?: number
  expiresInMs?: number
  now?: number
  storage?: AuthStorage | null
}

export interface ReadAuthTokenOptions {
  now?: number
  storage?: AuthStorage | null
}

function getAuthStorage(storage?: AuthStorage | null): AuthStorage | null {
  if (storage !== undefined) return storage
  if (typeof window === "undefined") return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

function safeGetItem(storage: AuthStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(storage: AuthStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
  }
}

function safeRemoveItem(storage: AuthStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
  }
}

export function fingerprintAuthToken(token: string): string {
  let hash = 0x811c9dc5
  const normalizedToken = String(token || "")

  for (let index = 0; index < normalizedToken.length; index += 1) {
    hash ^= normalizedToken.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(36)
}

export function createAuthSessionRecord(token: string, options: WriteAuthTokenOptions = {}): AuthSessionRecord {
  const issuedAt = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const explicitExpiresAt = Number.isFinite(options.expiresAt) ? Number(options.expiresAt) : undefined
  const relativeExpiresAt = Number.isFinite(options.expiresInMs)
    ? issuedAt + Math.max(0, Number(options.expiresInMs))
    : undefined

  return {
    version: 1,
    tokenFingerprint: fingerprintAuthToken(token),
    source: options.source ?? "unknown",
    issuedAt,
    ...(explicitExpiresAt !== undefined || relativeExpiresAt !== undefined
      ? { expiresAt: explicitExpiresAt ?? relativeExpiresAt }
      : {}),
  }
}

export function isAuthSessionExpired(session: AuthSessionRecord, now: number = Date.now()): boolean {
  return Number.isFinite(session.expiresAt) && Number(session.expiresAt) <= now
}

function parseAuthSessionRecord(raw: string | null): AuthSessionRecord | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<AuthSessionRecord>
    if (
      parsed.version !== 1 ||
      typeof parsed.tokenFingerprint !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.source !== "string"
    ) {
      return null
    }

    if (parsed.expiresAt !== undefined && typeof parsed.expiresAt !== "number") {
      return null
    }

    return parsed as AuthSessionRecord
  } catch {
    return null
  }
}

export function writeAuthToken(token: string, options: WriteAuthTokenOptions = {}): void {
  const storage = getAuthStorage(options.storage)
  if (!storage) return

  safeSetItem(storage, AUTH_TOKEN_STORAGE_KEY, token)
  safeSetItem(storage, AUTH_SESSION_STORAGE_KEY, JSON.stringify(createAuthSessionRecord(token, options)))
}

export function clearAuthSession(storageOverride?: AuthStorage | null): void {
  const storage = getAuthStorage(storageOverride)
  if (!storage) return

  safeRemoveItem(storage, AUTH_TOKEN_STORAGE_KEY)
  safeRemoveItem(storage, AUTH_SESSION_STORAGE_KEY)
}

export function readAuthToken(options: ReadAuthTokenOptions = {}): StoredAuthSession {
  const storage = getAuthStorage(options.storage)
  if (!storage) return { token: null, session: null, expired: false }

  const token = safeGetItem(storage, AUTH_TOKEN_STORAGE_KEY)
  if (!token) {
    safeRemoveItem(storage, AUTH_SESSION_STORAGE_KEY)
    return { token: null, session: null, expired: false }
  }

  const session = parseAuthSessionRecord(safeGetItem(storage, AUTH_SESSION_STORAGE_KEY))
  if (!session || session.tokenFingerprint !== fingerprintAuthToken(token)) {
    safeRemoveItem(storage, AUTH_SESSION_STORAGE_KEY)
    return { token, session: null, expired: false }
  }

  if (isAuthSessionExpired(session, options.now)) {
    clearAuthSession(storage)
    return { token: null, session: null, expired: true }
  }

  return { token, session, expired: false }
}
