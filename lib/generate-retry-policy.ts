/**
 * /api/ai/generate failure policy — the single source of truth for how the
 * chat client reacts to a failed turn (pure, no React, no network).
 *
 * Every failure (HTTP response, SSE `type:'error'` frame, transport throw) is
 * classified into ONE kind, and the kind alone decides:
 *   - whether the client retries and with which budget,
 *   - whether the plan/credits upgrade prompt may open (only `quota`),
 *   - which Spanish sentence the user reads.
 *
 * Owner policy: a model the user picked is never switched. When its provider
 * fails, the server explains it in Spanish («DeepSeek V4 Pro no pudo
 * responder: su proveedor no tiene saldo ahora. No cambié de modelo…»); that
 * human copy is shown verbatim. Raw codes, «HTTP 502», English plan-limit
 * strings, URLs and stack text never reach the user.
 */

export type GenerateFailureKind =
  | "turn_in_progress"
  | "rate_limited"
  | "transport"
  | "restarting"
  | "quota"
  | "provider"
  | "conflict"
  | "invalid"
  | "empty"
  | "aborted"

export type GenerateFailureInput = {
  status?: number | null
  code?: unknown
  error?: unknown
  message?: unknown
  retryable?: unknown
  retryAfterMs?: number | null
  name?: unknown
  /** Body flag of the plan gates (402/429 `upgradeRequired: true`). */
  upgradeRequired?: unknown
}

export type GenerateFailureDecision = {
  kind: GenerateFailureKind
  retryable: boolean
  showUpgrade: boolean
  retryAfterMs: number | null
  userMessage: string
  code: string | null
  status: number | null
}

/** A duplicate POST for a live turn waits for its owner (10 min budget). */
export const TURN_IN_PROGRESS_MAX_WAIT_MS = 600_000
/** Backend restart (deploy): poll health for at most this long. */
export const RESTART_MAX_WAIT_MS = 120_000
/** Health poll cadence while the backend restarts. */
export const RESTART_POLL_INTERVAL_MS = 3_000
/**
 * Connect timeout used ONLY for the one attempt right after a connect
 * timeout: longer than the server's silent follower wait (55 s), so a
 * retry outlives it instead of stacking another follower.
 */
export const GENERATE_FOLLOWER_CONNECT_MS = 65_000
/** Total time spent waiting for response headers across all attempts. */
export const GENERATE_TOTAL_CONNECT_BUDGET_MS = 150_000
/** Server hints (Retry-After, retryAfterSeconds) are honoured up to 60 s. */
export const RETRY_AFTER_CAP_MS = 60_000
/** Transport budget: POSTs that may fail on the network or a 5xx. */
export const MAX_TRANSPORT_ATTEMPTS = 5
/** Rate-limited 429s retried at most this many times. */
export const MAX_RATE_LIMITED_RETRIES = 4

export const CONNECTION_UNAVAILABLE_MESSAGE = "Conexión no disponible"

export const PROVIDER_UNAVAILABLE_MESSAGE =
  "Este modelo no está disponible ahora. No cambié a otro modelo. Reintenta, elige otro en el selector o reconecta el proveedor en Ajustes."

/** Shown while a duplicate request waits for the live turn (activity, not an error). */
export const TURN_IN_PROGRESS_ACTIVITY = "La respuesta sigue en curso. Reconectando…"
/**
 * Shown while the backend restarts and the client IS retrying (live activity
 * line only — never as a terminal error: see GENERATE_ERROR_COPY.restarting).
 */
export const RESTARTING_ACTIVITY = "SiraGPT se está actualizando. Reintentando en unos segundos…"

/**
 * Terminal copy, one per kind. Every sentence is true at the moment the user
 * reads it: nothing here claims a retry is running.
 */
export const GENERATE_ERROR_COPY: Record<GenerateFailureKind, string> = {
  turn_in_progress: "La respuesta sigue generándose en segundo plano; aparecerá aquí al terminar.",
  rate_limited: "Hay muchas solicitudes en curso. Espera unos segundos y vuelve a intentarlo.",
  transport: "No se pudo conectar con el modelo. Revisa tu conexión y vuelve a intentarlo.",
  restarting: "SiraGPT se está actualizando. Vuelve a intentarlo en un momento.",
  quota: "Te quedaste sin créditos o alcanzaste el límite de tu plan. Revisa tu plan para continuar.",
  provider: "El modelo no pudo completar la respuesta. No cambié de modelo; reintenta o elige otro en el selector.",
  conflict: "Este mensaje cambió desde el primer intento y no se pudo reenviar. Envíalo de nuevo como un mensaje nuevo.",
  invalid: "No se pudo procesar la solicitud. Revisa el mensaje y vuelve a intentarlo.",
  empty: "No recibí respuesta del modelo. Vuelve a intentarlo.",
  aborted: "Detuviste la respuesta.",
}

/** A 5xx reached us (not the user's network). */
export const SERVER_ERROR_MESSAGE = "El servidor no pudo completar la respuesta. Vuelve a intentarlo en unos segundos."
/** 401, or a 403 about the session / token. */
export const SESSION_EXPIRED_MESSAGE = "Tu sesión expiró. Vuelve a iniciar sesión para continuar."
/** Token-budget preflight: the prompt plus history exceed the model's context. */
export const CONTEXT_OVERFLOW_MESSAGE =
  "La conversación y los adjuntos superan lo que el modelo elegido puede leer de una vez. Empieza un chat nuevo, quita adjuntos o elige un modelo con más contexto en el selector."
/** Token-budget preflight: one request above the per-request cost cap. */
export const COST_CAP_MESSAGE =
  "Esta solicitud supera el costo máximo permitido por solicitud. Acórtala o revisa tu plan para continuar."
/** A resume found the turn still running but could not attach to it. */
export const STREAM_RESUME_PENDING_MESSAGE =
  "Se cortó la conexión mientras la respuesta seguía generándose. Vuelve a intentarlo en unos segundos para recuperarla."

const RETRYABLE_KINDS: ReadonlySet<GenerateFailureKind> = new Set([
  "turn_in_progress",
  "rate_limited",
  "transport",
  "restarting",
])

const RATE_LIMITED_CODES = new Set([
  "rate_limited",
  "queue_wait",
  "queue_fairness",
  "queue_generate_cap",
  "public_web_turn_capacity",
  "duplicate_turn",
  "sandbox_at_capacity",
  "document_turn_queue_full",
  "e_quota",
])

/**
 * The USER's own plan / credits / budget (exact code tokens only: a model's
 * own quota such as `image_quota_exceeded` is never one of these).
 */
const QUOTA_CODES = new Set([
  "quota_exceeded",
  "quota_exhausted",
  "insufficient_credits",
  "upgrade_required",
  "credits_exhausted",
  "plan_quota_exceeded",
  "cost_cap_exceeded",
  "organization_budget_exhausted",
  "fallback_quota_exceeded",
])

/** The picked model / its provider failed (billing, quota, outage…). */
const PROVIDER_CODES = new Set([
  "connection_unavailable",
  "provider_unavailable",
  "provider_connection_unavailable",
  "e_provider",
  "e_timeout",
  "e_sandbox",
  "e_github_connect",
  "model_error",
  "image_quota_exceeded",
  "image_generation_failed",
  "image_provider_no_credit",
])

/** Requests a replay cannot fix. */
const INVALID_CODES = new Set([
  "context_overflow",
])

/**
 * Plan / credit wording the backend uses for the USER's own quota. Code-like
 * tokens only match as whole tokens (`image_quota_exceeded` does not).
 */
const PLAN_LIMIT_TEXT_RE =
  /monthly (?:api |video generation )?limit exceeded|free (?:monthly|daily) queries|insufficient[ _]credits|upgrade[ _]required|(?:plan|monthly) quota (?:exceeded|exhausted)|organization (?:monthly )?quota exceeded|(?:^|[^a-z0-9_])(?:quota_exceeded|quota_exhausted|credits_exhausted)(?![a-z0-9_])/i

/** A provider's (not the user's) billing: never opens the upgrade prompt. */
const PROVIDER_BILLING_TEXT_RE = /\bprovider\b|\bproveedor\b|elevenlabs/i

/** 403 bodies about the session / token (not about a plan or a model). */
const AUTH_TEXT_RE = /\btoken\b|csrf|\bsession\b|sesi[oó]n|unauthori[sz]ed|not authenticated|no autenticad/i

const RESTART_STATUSES = new Set([502, 504, 520, 521, 522, 523, 524])

const SPANISH_MARKS_RE = /[áéíóúñü¿¡]/i
/** Spanish function words and our own copy verbs (never shared with English). */
const SPANISH_WORDS = new Set([
  "el", "la", "los", "las", "lo", "le", "les", "del", "al", "de", "que", "se", "en",
  "un", "una", "unos", "unas", "por", "para", "con", "sin", "tu", "tus", "su", "sus",
  "es", "está", "están", "esta", "este", "esto", "esa", "ese", "eso", "y", "o", "ya",
  "más", "pero", "sobre", "hay", "muy", "puede", "pudo", "pude", "puedes", "vuelve",
  "intenta", "inténtalo", "reintenta", "espera", "elige", "revisa", "ahora", "aquí",
  "también", "cuando", "porque", "mientras", "desde", "hasta", "otro", "otra", "ve",
])
/** English function words and error jargon (never shared with Spanish). */
const ENGLISH_WORDS = new Set([
  "the", "of", "and", "to", "is", "are", "was", "were", "be", "been", "for", "with",
  "without", "from", "your", "you", "please", "this", "that", "not", "or", "an", "on",
  "in", "at", "by", "it", "its", "has", "have", "had", "cannot", "can't", "failed",
  "invalid", "expired", "token", "request", "response", "exceeded", "unauthorized",
  "forbidden", "denied", "unknown", "undefined", "null", "properties", "reading",
  "reached", "limit", "quota", "upgrade", "required", "unavailable", "timeout",
])

/**
 * True when `text` reads as Spanish copy: at least one Spanish function word,
 * no more English words than Spanish ones, and — when any English word is
 * present — Spanish diacritics. English server text never reaches the user.
 */
export function readsAsSpanish(text: unknown): boolean {
  const raw = str(text)
  if (!raw) return false
  const words = raw.toLowerCase().match(/[a-záéíóúñü']+/g) || []
  let es = 0
  let en = 0
  for (const word of words) {
    if (SPANISH_WORDS.has(word)) es += 1
    if (ENGLISH_WORDS.has(word)) en += 1
  }
  if (es === 0 || en > es) return false
  return en === 0 || SPANISH_MARKS_RE.test(raw)
}

/** Kinds the client may retry automatically (each under its own budget). */
export function isRetryableGenerateKind(kind: GenerateFailureKind): boolean {
  return RETRYABLE_KINDS.has(kind)
}

function str(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

/** A value that reads like a machine code (no spaces), lower-cased. */
function codeToken(value: unknown): string {
  const text = str(value)
  if (!text || text.length > 80 || /\s/.test(text)) return ""
  return text.toLowerCase()
}

export function isPlanLimitText(text: unknown): boolean {
  return PLAN_LIMIT_TEXT_RE.test(str(text))
}

/**
 * True when `text` reads like copy written for a person, in Spanish: no
 * machine token, no «HTTP nnn», no URL (except the in-app /conexiones and
 * /planes paths), no stack frame, not transport/plan jargon, short enough —
 * and it must read as Spanish (an allowlist, not a jargon blocklist).
 */
export function isHumanErrorCopy(text: unknown): boolean {
  const raw = stripCodePrefix(str(text))
  if (!raw || raw.length > 400) return false
  if (!/\s/.test(raw)) return false // a lone token ("Unauthorized", "rate_limited")
  if (/^[[{]/.test(raw)) return false // JSON / array dump
  if (/\bHTTP\s*\d{3}\b/i.test(raw)) return false
  if (/(?:https?:\/\/|www\.)/i.test(raw)) return false
  const paths = raw.match(/(?:^|[\s(«"'])\/[a-z][\w-]*/gi) || []
  for (const match of paths) {
    const slug = match.replace(/^[\s(«"']*\//, "").toLowerCase()
    if (slug !== "conexiones" && slug !== "planes") return false
  }
  if (/\bat\s+[\w$.<>[\]]+\s*\(|\.(?:m?js|cjs|tsx?):\d+|\n\s+at\s/.test(raw)) return false
  if (/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(raw)) return false // ALL_CAPS_TOKEN
  if (/\b[a-z0-9]+_[a-z0-9_]+\b/.test(raw)) return false // snake_case_token
  if (
    /monthly api limit|limit exceeded|please upgrade|queries exhausted|insufficient credits|too many requests|rate[ -]?limited|bad gateway|service unavailable|internal server error|gateway time-?out|failed to fetch|network ?error|request failed|request aborted|stream (?:stalled|connect timeout)|\bgenerate\b/i
      .test(raw)
  ) return false
  return readsAsSpanish(raw)
}

/** «E_PROVIDER: No pude…» → «No pude…» (the code stays structured). */
function stripCodePrefix(text: string): string {
  return text.replace(/^E_[A-Z_]+:\s*/, "").trim()
}

function firstHumanCopy(...values: unknown[]): string {
  for (const value of values) {
    if (isHumanErrorCopy(value)) return stripCodePrefix(str(value))
  }
  return ""
}

function kindFor(input: GenerateFailureInput, status: number | null, codes: string[], text: string): GenerateFailureKind {
  const name = str(input.name)
  if (name === "AbortError" && !status && codes.length === 0) return "aborted"

  const has = (set: ReadonlySet<string>) => codes.some((c) => set.has(c))
  const hasPrefix = (prefix: string) => codes.some((c) => c.startsWith(prefix))

  // The user's own plan / credits — never a provider's (or a model's) own
  // billing or quota. A 402 is the user's only when it carries a user-credit
  // code / wording, the plan gates' `upgradeRequired`, or no code at all.
  if (!has(PROVIDER_CODES) && !PROVIDER_BILLING_TEXT_RE.test(text)) {
    if (has(QUOTA_CODES) || isPlanLimitText(text)) return "quota"
    if ((status === 402 || status === 429) && input.upgradeRequired === true) return "quota"
    if (status === 402 && codes.length === 0) return "quota"
  } else if (status === 402) {
    // A provider's own billing («… provider has insufficient credits»).
    return "provider"
  }

  if (codes.includes("turn_in_progress")) return "turn_in_progress"
  if (codes.includes("idempotency_conflict") || hasPrefix("idempotency_key_")) return "conflict"
  if (codes.includes("server_restarting")) return "restarting"
  // A resume found the turn still running: reconnecting is the fix.
  if (codes.includes("stream_resume_pending")) return "transport"
  if (has(INVALID_CODES)) return "invalid"
  if (has(RATE_LIMITED_CODES)) return "rate_limited"
  if (has(PROVIDER_CODES)) return "provider"

  if (status === 409) {
    return input.retryable === true ? "turn_in_progress" : "invalid"
  }
  if (status === 429) return "rate_limited"
  if (status === 408) return "transport"
  if (status === 503 && codes.length === 0 && !str(input.message) && !str(input.error)) {
    // Live hang: 503 with an empty body is a dead connection, not a retry.
    return "provider"
  }
  if (status != null && RESTART_STATUSES.has(status) && codes.length === 0) return "restarting"
  if (status != null && status >= 500) return "transport"
  if (status != null && status >= 400) return "invalid"

  if (/stream_connect_timeout|stream_stall|stream connect timeout|stream stalled|failed to fetch|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(`${codes.join(" ")} ${text}`)) {
    return "transport"
  }
  // An SSE error frame (status 200 / none) with no known code: the turn
  // failed on the server side — terminal, show its copy.
  return "provider"
}

function messageFor(kind: GenerateFailureKind, codes: string[], input: GenerateFailureInput, status: number | null): string {
  // A live-wait kind delivered as terminal: its fixed copy (a server line
  // such as «Reconectando…» / «Reintentando…» is no longer true).
  if (kind === "turn_in_progress" || kind === "aborted" || kind === "restarting") return GENERATE_ERROR_COPY[kind]
  if (kind === "invalid") {
    const text = [str(input.code), str(input.error), str(input.message)].join(" ")
    if (status === 401 || (status === 403 && AUTH_TEXT_RE.test(text))) return SESSION_EXPIRED_MESSAGE
  }
  const human = firstHumanCopy(input.message, input.error)
  if (kind === "quota") {
    if (codes.includes("cost_cap_exceeded")) return COST_CAP_MESSAGE
    return human || GENERATE_ERROR_COPY.quota
  }
  if (human) return human
  if (codes.includes("stream_resume_pending")) return STREAM_RESUME_PENDING_MESSAGE
  if (codes.includes("context_overflow")) return CONTEXT_OVERFLOW_MESSAGE
  if (kind === "transport" && status != null && status >= 500) return SERVER_ERROR_MESSAGE
  if (kind === "provider") {
    if (codes.includes("provider_unavailable") || codes.includes("provider_connection_unavailable")) {
      return PROVIDER_UNAVAILABLE_MESSAGE
    }
    if (codes.includes("connection_unavailable") || (status === 503 && codes.length === 0)) {
      return CONNECTION_UNAVAILABLE_MESSAGE
    }
  }
  return GENERATE_ERROR_COPY[kind]
}

/**
 * Classify one failed /api/ai/generate outcome. `retryable === false` from
 * the server always wins (never retried); a retryable kind otherwise retries
 * under its own budget.
 */
export function classifyGenerateFailure(input: GenerateFailureInput = {}): GenerateFailureDecision {
  const statusNumber = Number(input.status)
  const status = Number.isFinite(statusNumber) && statusNumber > 0 ? statusNumber : null
  const codes = [codeToken(input.code), codeToken(input.error)].filter(Boolean)
  const text = [str(input.code), str(input.error), str(input.message)].join(" ")
  const kind = kindFor(input, status, codes, text)
  const retryAfter = input.retryAfterMs == null ? Number.NaN : Number(input.retryAfterMs)
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(RETRY_AFTER_CAP_MS, retryAfter)
    : null
  const retryable = RETRYABLE_KINDS.has(kind) && input.retryable !== false
  const code = codes[0] || null
  return {
    kind,
    retryable,
    showUpgrade: kind === "quota",
    retryAfterMs,
    userMessage: messageFor(kind, codes, input, status),
    code,
    status,
  }
}

/**
 * Best-effort input for any thrown value: an Error from lib/api.ts (with
 * status / code / errorData / kind), a plain object, or a string.
 */
export function generateFailureInputFrom(error: unknown): GenerateFailureInput {
  if (typeof error === "string") return { message: error }
  if (!error || typeof error !== "object") return {}
  const e = error as Record<string, any>
  const data = e.errorData && typeof e.errorData === "object" ? e.errorData : {}
  const status = Number(e.status ?? e.statusCode ?? e.response?.status)
  return {
    status: Number.isFinite(status) && status > 0 ? status : null,
    code: e.code ?? data.code,
    // A plain `{ status, error }` object (no errorData) carries it inline.
    error: data.error ?? (typeof e.error === "string" ? e.error : undefined),
    message: e.message ?? data.message,
    retryable: e.retryable ?? data.retryable,
    retryAfterMs: typeof e.retryAfterMs === "number" ? e.retryAfterMs : null,
    name: e.name,
    upgradeRequired: data.upgradeRequired ?? e.upgradeRequired,
  }
}

/**
 * The decision for any thrown value. An Error produced by lib/api.ts already
 * carries its `kind` (and a friendly message); that classification wins.
 */
export function describeGenerateFailure(error: unknown): GenerateFailureDecision {
  const decision = classifyGenerateFailure(generateFailureInputFrom(error))
  const attachedKind = error && typeof error === "object" ? (error as { kind?: unknown }).kind : undefined
  if (typeof attachedKind === "string" && attachedKind in GENERATE_ERROR_COPY) {
    const kind = attachedKind as GenerateFailureKind
    if (kind === decision.kind) return decision
    return {
      ...decision,
      kind,
      retryable: RETRYABLE_KINDS.has(kind) && (error as { retryable?: unknown }).retryable !== false,
      showUpgrade: kind === "quota",
      userMessage: messageFor(kind, decision.code ? [decision.code] : [], generateFailureInputFrom(error), decision.status),
    }
  }
  return decision
}

/** The Spanish sentence to show for any failure (toast or bubble). */
export function friendlyGenerateError(error: unknown): string {
  return describeGenerateFailure(error).userMessage
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value)
  return null
}

/**
 * Server retry hint in ms from a `Retry-After` header (delta-seconds or
 * HTTP-date) and/or a JSON body (`retryAfterMs`, `retryAfterSeconds`). The
 * largest valid hint wins; capped at 60 s. `null` when there is none.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  body?: unknown,
  now: number = Date.now(),
): number | null {
  const hints: number[] = []
  const headerText = typeof header === "string" ? header.trim() : ""
  if (headerText) {
    const seconds = numberFrom(headerText)
    if (seconds != null) {
      hints.push(seconds * 1000)
    } else {
      const at = Date.parse(headerText)
      if (Number.isFinite(at)) hints.push(Math.max(0, at - now))
    }
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>
    const ms = numberFrom(b.retryAfterMs)
    if (ms != null) hints.push(ms)
    const secs = numberFrom(b.retryAfterSeconds)
    if (secs != null) hints.push(secs * 1000)
  }
  const valid = hints.filter((h) => Number.isFinite(h) && h >= 0)
  if (valid.length === 0) return null
  return Math.min(RETRY_AFTER_CAP_MS, Math.round(Math.max(...valid)))
}

/**
 * Delay before the next try. With a server hint: the hint plus a small
 * jitter (never earlier than the hint). Without one: full jitter over an
 * exponential ceiling, with a small floor so a retry is never immediate.
 */
export function computeRetryDelayMs(options: {
  attempt: number
  retryAfterMs?: number | null
  baseMs?: number
  capMs?: number
  minMs?: number
  random?: () => number
}): number {
  const random = options.random ?? Math.random
  const r = Math.min(0.999999, Math.max(0, Number(random()) || 0))
  const hint = Number(options.retryAfterMs)
  if (Number.isFinite(hint) && hint > 0) {
    const bounded = Math.min(RETRY_AFTER_CAP_MS, hint)
    return Math.round(bounded + r * Math.min(1000, 0.2 * bounded))
  }
  const baseMs = options.baseMs ?? 1000
  const capMs = options.capMs ?? 20_000
  const minMs = Math.min(options.minMs ?? 250, capMs)
  const attempt = Math.max(1, Math.floor(Number(options.attempt) || 1))
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1))
  return Math.max(minMs, Math.round(r * ceiling))
}

export type KeyedSingleFlight<T> = {
  /** Runs `fn` once per key at a time; concurrent callers share its promise. */
  run: (key: string, fn: () => Promise<T>) => Promise<T>
  has: (key: string) => boolean
  get: (key: string) => Promise<T> | undefined
}

export function createKeyedSingleFlight<T = unknown>(): KeyedSingleFlight<T> {
  const inflight = new Map<string, Promise<T>>()
  return {
    run(key, fn) {
      const existing = inflight.get(key)
      if (existing) return existing
      const promise: Promise<T> = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key)
        })
      inflight.set(key, promise)
      return promise
    },
    has: (key) => inflight.has(key),
    get: (key) => inflight.get(key),
  }
}
