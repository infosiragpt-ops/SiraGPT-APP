import { isRecoverableClientBundleError } from "./client-bundle-recovery"

export const WORKSPACE_ERROR_CODES = {
  SESSION_REFRESH_REQUIRED: "SESSION_REFRESH_REQUIRED",
  CLIENT_BUILD_MISMATCH: "CLIENT_BUILD_MISMATCH",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  WORKSPACE_PROVISIONING: "WORKSPACE_PROVISIONING",
  WORKSPACE_MOUNT_FAILED: "WORKSPACE_MOUNT_FAILED",
  WORKSPACE_START_FAILED: "WORKSPACE_START_FAILED",
  WORKSPACE_HEALTH_FAILED: "WORKSPACE_HEALTH_FAILED",
  WORKSPACE_CONNECT_FAILED: "WORKSPACE_CONNECT_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  TRANSIENT_UNAVAILABLE: "TRANSIENT_UNAVAILABLE",
  CAPACITY_FULL: "CAPACITY_FULL",
  FORBIDDEN: "FORBIDDEN",
  INVALID_REQUEST: "INVALID_REQUEST",
  CHUNK_LOAD_ERROR: "CHUNK_LOAD_ERROR",
  UNKNOWN: "UNKNOWN",
} as const

export type WorkspaceErrorCode =
  (typeof WORKSPACE_ERROR_CODES)[keyof typeof WORKSPACE_ERROR_CODES]

export const WORKSPACE_STAGES = {
  RESOLVING_SESSION: "RESOLVING_SESSION",
  REQUESTING_WORKSPACE: "REQUESTING_WORKSPACE",
  PROVISIONING: "PROVISIONING",
  MOUNTING: "MOUNTING",
  STARTING: "STARTING",
  CHECKING_HEALTH: "CHECKING_HEALTH",
  CONNECTING: "CONNECTING",
  READY: "READY",
  RECONNECTING: "RECONNECTING",
  DEGRADED: "DEGRADED",
} as const

export type WorkspaceBootstrapStage =
  (typeof WORKSPACE_STAGES)[keyof typeof WORKSPACE_STAGES]

export type WorkspaceErrorSeverity = "info" | "warning" | "error" | "fatal"

export type WorkspaceErrorPayload = {
  code: WorkspaceErrorCode
  retryable: boolean
  stage: WorkspaceBootstrapStage
  severity: WorkspaceErrorSeverity
  traceId: string
  userMessage: string
  internalMessage: string
  retryAfterMs: number | null
  progress: WorkspaceProgress | null
  status: number
}

export type WorkspaceProgress = {
  stage: WorkspaceBootstrapStage
  percent: number
  label: string
  reused?: boolean
}

const USER_MESSAGES: Record<WorkspaceErrorCode, string> = {
  SESSION_REFRESH_REQUIRED: "Tu sesión caducó. Reintentar refresca el acceso sin perder el chat.",
  CLIENT_BUILD_MISMATCH: "Hay una versión nueva de SiraGPT. Recargamos el espacio una vez para alinearla.",
  WORKSPACE_NOT_FOUND: "Este espacio ya no está disponible. Puedes abrir /code y elegir otro.",
  WORKSPACE_PROVISIONING: "Estamos preparando tu espacio. El chat y los archivos no se tocan.",
  WORKSPACE_MOUNT_FAILED: "No se pudo montar el espacio. Reintentar reutiliza el mismo workspace.",
  WORKSPACE_START_FAILED: "El runtime no arrancó. Reintentar no crea un runtime duplicado.",
  WORKSPACE_HEALTH_FAILED: "El espacio no respondió al chequeo de salud. Reintentamos en automático.",
  WORKSPACE_CONNECT_FAILED: "No se pudo conectar al espacio. El chat no se ve afectado.",
  RATE_LIMITED: "Demasiados intentos seguidos. Esperamos un momento y reintentamos.",
  TIMEOUT: "El espacio tardó demasiado en responder. Reintentamos con la misma clave.",
  TRANSIENT_UNAVAILABLE: "El espacio está ocupado o en mantenimiento breve. Reintentamos en automático.",
  CAPACITY_FULL: "No hay capacidad libre ahora. Reintentamos sin crear otro runtime.",
  FORBIDDEN: "No tienes permiso para este espacio. El chat no se ve afectado.",
  INVALID_REQUEST: "La petición del espacio no es válida. Vuelve a /code o al chat.",
  CHUNK_LOAD_ERROR: "El navegador cargó archivos de una versión anterior. Recargamos una vez.",
  UNKNOWN: "No se pudo cargar el espacio de código. Reintentar remonta el workspace. El chat no se ve afectado.",
}

const RETRYABLE_CODES = new Set<WorkspaceErrorCode>([
  WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED,
  WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH,
  WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING,
  WORKSPACE_ERROR_CODES.WORKSPACE_HEALTH_FAILED,
  WORKSPACE_ERROR_CODES.WORKSPACE_CONNECT_FAILED,
  WORKSPACE_ERROR_CODES.RATE_LIMITED,
  WORKSPACE_ERROR_CODES.TIMEOUT,
  WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE,
  WORKSPACE_ERROR_CODES.CAPACITY_FULL,
  WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR,
])

const HTTP_STATUS_BY_CODE: Record<WorkspaceErrorCode, number> = {
  SESSION_REFRESH_REQUIRED: 401,
  CLIENT_BUILD_MISMATCH: 409,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_PROVISIONING: 202,
  WORKSPACE_MOUNT_FAILED: 422,
  WORKSPACE_START_FAILED: 422,
  WORKSPACE_HEALTH_FAILED: 503,
  WORKSPACE_CONNECT_FAILED: 503,
  RATE_LIMITED: 429,
  TIMEOUT: 408,
  TRANSIENT_UNAVAILABLE: 503,
  CAPACITY_FULL: 503,
  FORBIDDEN: 403,
  INVALID_REQUEST: 422,
  CHUNK_LOAD_ERROR: 409,
  UNKNOWN: 500,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function firstString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return fallback
}

function normalizeCode(value: unknown): WorkspaceErrorCode | "" {
  const raw = firstString(value).trim().toUpperCase().replace(/[\s-]+/g, "_")
  return raw in WORKSPACE_ERROR_CODES ? raw as WorkspaceErrorCode : ""
}

export function normalizeWorkspaceStage(
  value: unknown,
  fallback: WorkspaceBootstrapStage = WORKSPACE_STAGES.REQUESTING_WORKSPACE,
): WorkspaceBootstrapStage {
  const raw = firstString(value).trim().toUpperCase()
  return raw in WORKSPACE_STAGES ? raw as WorkspaceBootstrapStage : fallback
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

export function isChunkLoadOrBuildSkewError(error: unknown): boolean {
  const rec = asRecord(error)
  const code = normalizeCode(rec?.code)
  return (
    code === WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR
    || code === WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH
    || isRecoverableClientBundleError(error)
  )
}

function looksLikeNetwork(error: unknown): boolean {
  const rec = asRecord(error)
  const message = firstString(rec?.message)
  const code = firstString(rec?.code)
  return (
    error instanceof TypeError
    || /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(`${code} ${message}`)
  )
}

function codeFromStatus(status: number): WorkspaceErrorCode {
  if (status === 401) return WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED
  if (status === 403) return WORKSPACE_ERROR_CODES.FORBIDDEN
  if (status === 404) return WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND
  if (status === 408) return WORKSPACE_ERROR_CODES.TIMEOUT
  if (status === 409) return WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH
  if (status === 422 || status === 400) return WORKSPACE_ERROR_CODES.INVALID_REQUEST
  if (status === 429) return WORKSPACE_ERROR_CODES.RATE_LIMITED
  if (status === 202) return WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING
  if (status >= 500) return WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE
  return WORKSPACE_ERROR_CODES.UNKNOWN
}

export function classifyWorkspaceError(
  error: unknown,
  extras: Partial<WorkspaceErrorPayload> & { status?: number; requestId?: string } = {},
): WorkspaceErrorPayload {
  const rec = asRecord(error)
  const body = asRecord(rec?.body)
  const status = Number(extras.status ?? rec?.status ?? rec?.statusCode)
  const explicit = normalizeCode(extras.code || rec?.code || body?.code || body?.error)
  const stage = normalizeWorkspaceStage(extras.stage || rec?.stage || body?.stage)
  const traceId = firstString(
    extras.traceId || rec?.traceId || rec?.requestId || extras.requestId || body?.traceId,
  )

  let code: WorkspaceErrorCode = explicit || WORKSPACE_ERROR_CODES.UNKNOWN
  if (isChunkLoadOrBuildSkewError(error)) {
    code = explicit === WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH
      ? WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH
      : WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR
  } else if (code === WORKSPACE_ERROR_CODES.UNKNOWN && Number.isFinite(status) && status > 0) {
    code = codeFromStatus(status)
  } else if (code === WORKSPACE_ERROR_CODES.UNKNOWN && looksLikeNetwork(error)) {
    code = WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE
  } else if (
    code === WORKSPACE_ERROR_CODES.UNKNOWN
    && /timeout|timed out|aborted/i.test(firstString(rec?.message))
  ) {
    code = WORKSPACE_ERROR_CODES.TIMEOUT
  }

  const retryable = extras.retryable != null
    ? Boolean(extras.retryable)
    : (RETRYABLE_CODES.has(code) || (Number.isFinite(status) && isRetryableHttpStatus(status)))

  return {
    code,
    retryable,
    stage,
    severity: extras.severity || (retryable ? "warning" : "error"),
    traceId,
    userMessage: extras.userMessage
      || firstString(body?.userMessage)
      || USER_MESSAGES[code]
      || USER_MESSAGES.UNKNOWN,
    internalMessage: firstString(
      extras.internalMessage || rec?.internalMessage || rec?.message,
      "unclassified workspace error",
    ).slice(0, 500),
    retryAfterMs: extras.retryAfterMs ?? (
      Number.isFinite(Number(body?.retryAfterMs ?? rec?.retryAfterMs))
        ? Number(body?.retryAfterMs ?? rec?.retryAfterMs)
        : null
    ),
    progress: extras.progress ?? (asRecord(body?.progress) as WorkspaceProgress | null),
    status: Number.isFinite(status) && status > 0 ? status : HTTP_STATUS_BY_CODE[code],
  }
}

export function genericWorkspaceFailureCopy(): string {
  return USER_MESSAGES.UNKNOWN
}

export { USER_MESSAGES, RETRYABLE_CODES, HTTP_STATUS_BY_CODE }
