/**
 * lib/toast-helper.ts
 *
 * In-memory dedup + classification helpers for the project's toast
 * system (shadcn/use-toast based — see `hooks/use-toast.ts`).
 *
 * Why this exists:
 *
 *   • API errors are surfaced in many places. Without dedup, a single
 *     network outage can spawn dozens of identical toasts.
 *   • Some errors are user-facing (network down, file too large) and
 *     deserve a friendly translation; others are pure noise. The
 *     `classifyApiError` helper picks a sensible message.
 *
 * This module is *toast-library-agnostic*: callers pass their own
 * `toast` function (the `toast` returned from `useToast`) — we just
 * decide *whether* to invoke it.
 *
 * Public API:
 *   • toastOnce(key, payload, toastFn, windowMs?)
 *   • classifyApiError(err) → { title, description, severity }
 *   • toastApiError(err, toastFn, opts?)
 *   • toastDestructiveSuccess(message, undo, toastFn)
 *   • resetToastDedupCache()  — test helper
 */

/* ------------------------------------------------------------------ */
/* Dedup state                                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_WINDOW_MS = 5_000

interface DedupEntry {
  lastShown: number
}

const dedup = new Map<string, DedupEntry>()

/**
 * Show a toast only if the same `key` hasn't been shown within
 * `windowMs` (default 5 s). Returns `true` when the toast was
 * actually invoked, `false` when it was suppressed by the dedup
 * window.
 */
export function toastOnce<T>(
  key: string,
  payload: T,
  toastFn: (payload: T) => unknown,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now()
  const entry = dedup.get(key)
  if (entry && now - entry.lastShown < windowMs) return false
  dedup.set(key, { lastShown: now })
  // Opportunistic cleanup so the map doesn't grow without bound.
  if (dedup.size > 256) {
    for (const [k, v] of dedup) {
      if (now - v.lastShown > windowMs * 4) dedup.delete(k)
    }
  }
  try {
    toastFn(payload)
  } catch {
    // If the consumer's toast implementation throws, we don't want
    // to crash the caller. Allow another attempt by clearing the
    // dedup entry.
    dedup.delete(key)
    return false
  }
  return true
}

export function resetToastDedupCache(): void {
  dedup.clear()
}

/* ------------------------------------------------------------------ */
/* API error classification                                           */
/* ------------------------------------------------------------------ */

export type ErrorSeverity = "info" | "warning" | "error"

export interface ClassifiedError {
  title: string
  description: string
  severity: ErrorSeverity
  /** Stable code used for dedup keying */
  code: string
}

interface MaybeAxiosLike {
  message?: string
  status?: number
  code?: string
  name?: string
  response?: { status?: number; data?: { error?: string; message?: string } }
}

/**
 * Translate an arbitrary error (Error, fetch rejection, apiClient
 * response with `.error`) into a user-friendly toast payload.
 */
export function classifyApiError(err: unknown): ClassifiedError {
  if (err == null) {
    return {
      title: "Error",
      description: "Ocurrió un error inesperado.",
      severity: "error",
      code: "unknown",
    }
  }

  const e = err as MaybeAxiosLike & { aborted?: boolean }

  if (e.name === "AbortError" || e.aborted) {
    return {
      title: "Operación cancelada",
      description: "La solicitud fue cancelada.",
      severity: "info",
      code: "aborted",
    }
  }

  const status = e.status ?? e.response?.status
  const apiMessage =
    e.response?.data?.error ||
    e.response?.data?.message ||
    e.message ||
    (typeof err === "string" ? err : "")

  if (status === 401 || status === 403) {
    return {
      title: "Sesión expirada",
      description: "Inicia sesión nuevamente para continuar.",
      severity: "warning",
      code: `auth-${status}`,
    }
  }
  if (status === 404) {
    return {
      title: "No encontrado",
      description: apiMessage || "El recurso solicitado no existe.",
      severity: "warning",
      code: "404",
    }
  }
  if (status === 413) {
    return {
      title: "Archivo demasiado grande",
      description: apiMessage || "Reduce el tamaño del archivo y reintenta.",
      severity: "warning",
      code: "413",
    }
  }
  if (status === 415) {
    return {
      title: "Formato no soportado",
      description: apiMessage || "El tipo de archivo no se admite.",
      severity: "warning",
      code: "415",
    }
  }
  if (status === 429) {
    return {
      title: "Demasiadas solicitudes",
      description: "Espera unos segundos y vuelve a intentar.",
      severity: "warning",
      code: "429",
    }
  }
  if (typeof status === "number" && status >= 500) {
    return {
      title: "Error del servidor",
      description: apiMessage || "Servicio temporalmente no disponible.",
      severity: "error",
      code: `server-${status}`,
    }
  }

  const msg = String(apiMessage || "Error de red").toLowerCase()
  if (
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    e.code === "ENETUNREACH"
  ) {
    return {
      title: "Sin conexión",
      description: "Comprueba tu red e intenta de nuevo.",
      severity: "error",
      code: "network",
    }
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return {
      title: "Tiempo agotado",
      description: "La operación tardó demasiado.",
      severity: "warning",
      code: "timeout",
    }
  }

  return {
    title: "Error",
    description: apiMessage || "Ocurrió un error inesperado.",
    severity: "error",
    code: `generic:${String(apiMessage || "unknown").slice(0, 40)}`,
  }
}

/* ------------------------------------------------------------------ */
/* Helpers that combine dedup + classification                        */
/* ------------------------------------------------------------------ */

export interface ToastApiErrorOptions {
  /** Extra dedup-key suffix (e.g. the endpoint path) */
  scope?: string
  /** Window for dedup — default 5 s */
  windowMs?: number
  /** Override the classifier output (still dedup-keyed) */
  override?: Partial<ClassifiedError>
}

interface ToastFnPayload {
  title: string
  description: string
  variant?: "default" | "destructive"
}

/**
 * Classify + dedup an API error, then forward the friendly payload
 * to a toast function. Returns `true` if the toast was emitted.
 */
export function toastApiError(
  err: unknown,
  toastFn: (payload: ToastFnPayload) => unknown,
  opts: ToastApiErrorOptions = {},
): boolean {
  const classified = { ...classifyApiError(err), ...opts.override }
  const key = `api-error:${classified.code}${opts.scope ? `:${opts.scope}` : ""}`
  return toastOnce(
    key,
    {
      title: classified.title,
      description: classified.description,
      variant: classified.severity === "error" ? "destructive" : "default",
    },
    toastFn,
    opts.windowMs,
  )
}

/* ------------------------------------------------------------------ */
/* Destructive-success helper                                         */
/* ------------------------------------------------------------------ */

export interface DestructiveSuccessOptions {
  /** Display key — defaults to the message itself */
  key?: string
  /** Window for dedup — default 5 s */
  windowMs?: number
}

interface DestructiveSuccessPayload {
  title: string
  description?: string
  /**
   * Action descriptor — caller renders this into the toast's action
   * slot however its toast UI demands.
   */
  action?: { label: string; onClick: () => void }
}

/**
 * Show a success toast for destructive operations (delete, archive,
 * etc.) with an optional "Undo" affordance. Deduped on the
 * `key` (or `message`).
 */
export function toastDestructiveSuccess(
  message: string,
  undo: (() => void) | undefined,
  toastFn: (payload: DestructiveSuccessPayload) => unknown,
  opts: DestructiveSuccessOptions = {},
): boolean {
  const key = `destructive:${opts.key ?? message}`
  return toastOnce(
    key,
    {
      title: message,
      action: undo ? { label: "Deshacer", onClick: undo } : undefined,
    },
    toastFn,
    opts.windowMs,
  )
}
