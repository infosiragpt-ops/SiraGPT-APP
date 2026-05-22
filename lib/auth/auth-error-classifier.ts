export type AuthErrorCode =
  | "invalid_credentials"
  | "expired_session"
  | "oauth_failed"
  | "rate_limited"
  | "network_error"
  | "unknown"

export interface AuthErrorMessage {
  es: string
  en: string
}

export interface ClassifiedAuthError {
  code: AuthErrorCode
  message: AuthErrorMessage
}

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, AuthErrorMessage> = {
  invalid_credentials: {
    es: "Credenciales incorrectas",
    en: "Invalid credentials",
  },
  expired_session: {
    es: "La sesión es inválida o expiró. Inicia sesión otra vez.",
    en: "The session is invalid or expired. Please sign in again.",
  },
  oauth_failed: {
    es: "No se pudo completar la autenticación externa. Intenta otra vez.",
    en: "External authentication could not be completed. Please try again.",
  },
  rate_limited: {
    es: "Demasiados intentos. Espera un momento e intenta otra vez.",
    en: "Too many attempts. Wait a moment and try again.",
  },
  network_error: {
    es: "No se pudo conectar con el servidor. Revisa tu conexión e intenta otra vez.",
    en: "Could not connect to the server. Check your connection and try again.",
  },
  unknown: {
    es: "No se pudo iniciar sesión. Intenta otra vez.",
    en: "Could not sign in. Please try again.",
  },
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode

  return typeof status === "number" && Number.isFinite(status) ? status : null
}

function getErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (!error || typeof error !== "object") return ""

  const candidate = error as { message?: unknown; error?: unknown; code?: unknown }
  return [candidate.message, candidate.error, candidate.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

export function normalizeAuthErrorCode(value: unknown): AuthErrorCode | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")

  if (normalized in AUTH_ERROR_MESSAGES) return normalized as AuthErrorCode
  if (/invalid|incorrect|credencial|unauthori[sz]ed|forbidden|401|403/.test(normalized)) {
    return "invalid_credentials"
  }
  if (/expir|invalid_token|session|sesion|sesión|token/.test(normalized)) {
    return "expired_session"
  }
  if (/oauth|google|autenticaci[oó]n|authentication/.test(normalized)) {
    return "oauth_failed"
  }
  if (/rate|limit|429|too_many/.test(normalized)) {
    return "rate_limited"
  }
  if (/network|fetch|timeout|conexion|conexi[oó]n|offline/.test(normalized)) {
    return "network_error"
  }

  return null
}

export function classifyAuthError(error: unknown): ClassifiedAuthError {
  const status = getErrorStatus(error)
  const textCode = normalizeAuthErrorCode(getErrorText(error))

  if (status === 401 || status === 403) return { code: "invalid_credentials", message: AUTH_ERROR_MESSAGES.invalid_credentials }
  if (status === 408 || status === 0) return { code: "network_error", message: AUTH_ERROR_MESSAGES.network_error }
  if (status === 419) return { code: "expired_session", message: AUTH_ERROR_MESSAGES.expired_session }
  if (status === 429) return { code: "rate_limited", message: AUTH_ERROR_MESSAGES.rate_limited }
  if (textCode) return { code: textCode, message: AUTH_ERROR_MESSAGES[textCode] }

  return { code: "unknown", message: AUTH_ERROR_MESSAGES.unknown }
}

export function getAuthErrorMessage(code: AuthErrorCode, locale: string = "es"): string {
  const message = AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES.unknown
  return locale.toLowerCase().startsWith("en") ? message.en : message.es
}

export function getSafeAuthRedirectMessage(rawError: unknown, locale: string = "es"): string {
  const code = normalizeAuthErrorCode(String(rawError || "")) ?? "unknown"
  return getAuthErrorMessage(code, locale)
}
