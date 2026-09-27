"use client"

import { authenticatedFetch } from "./authenticated-fetch"

type ClientLogPayload = {
  source?: "client" | "api" | "render" | "global" | "network"
  severity?: "fatal" | "error" | "warn" | "info"
  page?: string
  action?: string
  message?: string
  stack?: string
  component?: string
  requestId?: string | null
  status?: number | null
  method?: string
  endpoint?: string
  extra?: Record<string, unknown> | null
  digest?: string | null
  /**
   * Turn failure seen in the browser (Admin → Logs → «Fallos de respuesta»).
   * The server merges it into the same row as its own finalizer by
   * chatId + idempotencyKey. Ids only — never the prompt or the answer.
   */
  turn?: ClientTurnSignal | null
}

export type ClientTurnReason =
  | "stream_error"
  | "connect_failed"
  | "http_error"
  | "render_crash"
  | "no_activity"
  | "stalled"
  | "empty_close"
  | "no_response"

export type ClientTurnSignal = {
  reason: ClientTurnReason
  chatId?: string | null
  streamId?: string | null
  idempotencyKey?: string | null
  model?: string | null
  attempts?: number | null
  hasContent?: boolean
  elapsedMs?: number | null
}

const MAX_MESSAGE = 700
const SENSITIVE_KEY_RE = /password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|session|csrf|bearer|deepseek|email|prompt|completion|access_token|refresh_token|id_token|client_secret|mailto|ssn|iban|cvv|phone|card|credit[_-]?card|passport|dob|date[_-]?of[_-]?birth|address|national[_-]?id|routing[_-]?number|tax[_-]?id|driver[_-]?license|bank[_-]?account|swift|bic|ruc|dni|cpf|curp|rfc|(?:^|_|-)pin(?:$|_|-)|national[_-]?insurance|clabe|cci|cuit|cuil|nie|nif|(?:^|_|-)nss(?:$|_|-)|jwt|sessionid|set[_-]?cookie|x[_-]?csrf|auth[_-]?header/i

const TURN_ID_RE = /^[A-Za-z0-9:_\-.]{1,150}$/

function cleanTurnId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim()
  return TURN_ID_RE.test(text) ? text : null
}

function cleanTurn(turn: ClientTurnSignal | null | undefined): ClientTurnSignal | null {
  if (!turn || typeof turn !== "object" || typeof turn.reason !== "string") return null
  return {
    reason: turn.reason,
    chatId: cleanTurnId(turn.chatId),
    streamId: cleanTurnId(turn.streamId),
    idempotencyKey: cleanTurnId(turn.idempotencyKey),
    model: typeof turn.model === "string" ? turn.model.slice(0, 80) : null,
    attempts: typeof turn.attempts === "number" && Number.isFinite(turn.attempts) ? turn.attempts : null,
    hasContent: turn.hasContent === true,
    elapsedMs: typeof turn.elapsedMs === "number" && Number.isFinite(turn.elapsedMs) ? Math.round(turn.elapsedMs) : null,
  }
}

/** Chat id of the /agentes conversation on screen, if any. */
function chatIdFromLocation(): string | null {
  if (typeof window === "undefined") return null
  const match = /\/agentes\/([A-Za-z0-9_-]{8,})/.exec(window.location.pathname || "")
  if (match) return match[1]
  try {
    return cleanTurnId(new URLSearchParams(window.location.search || "").get("id"))
  } catch {
    return null
  }
}

function currentPage(): string {
  if (typeof window === "undefined") return "server"
  return `${window.location.pathname}${window.location.search || ""}`
}

function cleanString(value: unknown, max = MAX_MESSAGE): string | null {
  if (value == null) return null
  const text = String(value).replace(/\s+/g, " ").trim()
  if (!text) return null
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:jwt]")
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])_[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED:key]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED:email]")
    .slice(0, max)
}

function cleanExtra(input: unknown, depth = 0): unknown {
  if (depth > 2) return "[truncated]"
  if (input == null) return null
  if (typeof input === "string") return cleanString(input, 300)
  if (typeof input === "number" || typeof input === "boolean") return input
  if (Array.isArray(input)) return input.slice(0, 8).map((item) => cleanExtra(item, depth + 1))
  if (typeof input !== "object") return cleanString(input, 300)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, 24)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : cleanExtra(value, depth + 1)
  }
  return out
}

const LOG_WINDOW_MS = 60_000
const LOG_MAX_PER_WINDOW = 12
let logWindowStart = 0
let logWindowCount = 0

function allowClientLog(): boolean {
  const now = Date.now()
  if (now - logWindowStart > LOG_WINDOW_MS) {
    logWindowStart = now
    logWindowCount = 0
  }
  if (logWindowCount >= LOG_MAX_PER_WINDOW) return false
  logWindowCount += 1
  return true
}

export function reportClientLog(payload: ClientLogPayload): void {
  if (typeof window === "undefined") return
  if (!allowClientLog()) return

  const body = {
    source: payload.source || "client",
    severity: payload.severity || "error",
    page: cleanString(payload.page || currentPage(), 300),
    action: cleanString(payload.action || "unknown", 180),
    message: cleanString(payload.message || "Client error"),
    stack: cleanString(payload.stack || "", 1800),
    component: cleanString(payload.component || "", 160),
    requestId: cleanString(payload.requestId || "", 160),
    status: typeof payload.status === "number" ? payload.status : null,
    method: cleanString(payload.method || "", 20),
    endpoint: cleanString(payload.endpoint || "", 300),
    extra: cleanExtra(payload.extra || null),
    ...(payload.turn ? { turn: cleanTurn(payload.turn) } : {}),
  }

  const token = window.localStorage?.getItem("auth-token")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`

  authenticatedFetch("/api/telemetry/error", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // Observability must never affect the user flow.
  })
}

export function reportErrorBoundary(
  label: string,
  error: Error & { digest?: string },
  extra?: { requestId?: string | null; digest?: string | null },
): void {
  const digest = extra?.digest || error.digest || null
  const chatId = chatIdFromLocation()
  reportClientLog({
    source: "render",
    severity: "error",
    action: "error_boundary",
    component: label,
    message: error.message,
    stack: error.stack,
    requestId: extra?.requestId || null,
    digest,
    extra: digest ? { digest } : null,
    // A crash while a chat is on screen means the user could not read the
    // answer: it also counts as a failed turn for the admin tracker.
    ...(chatId ? { turn: { reason: "render_crash" as const, chatId } } : {}),
  })
}

export function redactBoundaryMessage(message: unknown): string {
  return cleanString(message, 240) || "Error desconocido"
}



/**
 * Report a turn the browser saw fail (stream error, no activity, empty
 * close…). Never throws; rate-limited with every other client log.
 */
export function reportTurnFailure(turn: ClientTurnSignal, message?: string, extra?: { status?: number | null; endpoint?: string; requestId?: string | null }): void {
  reportClientLog({
    source: "api",
    severity: "error",
    action: `turn_${turn.reason}`,
    message: message || turn.reason,
    endpoint: extra?.endpoint || "/ai/generate",
    status: extra?.status ?? null,
    requestId: extra?.requestId || null,
    turn,
  })
}

/** 3H-FE-003 — nested extra PII (email/prompt) never leaves the browser. */
export function stripPiiExtra(extra: unknown): unknown {
  return cleanExtra(extra)
}
