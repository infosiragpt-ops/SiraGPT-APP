// Frontend API client for backend integration
import { streamSseJson } from "./sse-client"
import { sanitizeFetchHeaders } from "./fetch-sanitize"
import { reportClientLog } from "./client-logs"
import { safeUUID } from "./safe-uuid"
export { getNormalizedApiBaseUrl } from "./api-base-url"
import { getNormalizedApiBaseUrl } from "./api-base-url"
// Codegen'd from backend/src/schemas/* — DO NOT edit by hand. Regenerate
// with `node backend/scripts/generate-api-types.js` whenever schemas change.
import type {
  CreateChatRequest,
  LoginRequest,
  RegisterRequest,
  CreatePaymentRequest,
} from "./api-types"
// Re-export response types so app code can reference them without depending
// on the codegen path directly.
export type {
  AuthResponse,
  ChatResponse,
  FileUploadResponse,
  PaymentResponse,
  MessageResponse,
  FileMetadata,
} from "./api-types"

import type {
  AuthResponse,
  ChatResponse,
  FileUploadResponse,
  MessageResponse,
  FileMetadata,
  AuthUser,
} from "./api-types"

// Wrapper response shapes — the codegen models only the inner record,
// but routes return wrappers. Defined here (cycle 42) so the most-called
// methods can stop returning `any`. Each wrapper allows passthrough
// fields via `[key: string]: unknown` so callers reading optional
// extras still compile.
export type ChatEnvelope = { chat: ChatResponse; [key: string]: unknown }
export type ChatsEnvelope = {
  chats: ChatResponse[]
  total?: number
  page?: number
  limit?: number
  [key: string]: unknown
}
export type CurrentUserEnvelope = { user: AuthUser; [key: string]: unknown }
export type FileEnvelope = { file: FileMetadata; [key: string]: unknown }
export type AddMessageEnvelope = {
  message?: MessageResponse
  chat?: ChatResponse
  [key: string]: unknown
}
export type ShareEnvelope = {
  shareableLink?: string
  shareId?: string
  url?: string
  [key: string]: unknown
}
export type SuccessEnvelope = {
  success?: boolean
  message?: string
  [key: string]: unknown
}
export type ChatRunSummary = {
  runId: string
  chatId: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string
  model: string
  provider: string | null
  messageId: string | null
  startedAt: string | null
  lastChunkAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
  attempt: number
  snippet: string
}
export type ImpersonateEnvelope = {
  token?: string
  user?: AuthUser
  impersonating?: boolean
  [key: string]: unknown
}

const API_BASE_URL = getNormalizedApiBaseUrl()

function sanitizeStreamError(raw: string): string {
  if (/does not support image/i.test(raw)) {
    return "El modelo seleccionado no admite imágenes. Intenta con un modelo compatible con visión o adjunta documentos en lugar de imágenes."
  }
  if (/cannot read.*image/i.test(raw)) {
    return "No se pudieron procesar las imágenes adjuntas con este modelo. Intenta con un modelo compatible con visión."
  }
  if (/image input/i.test(raw)) {
    return "El modelo no soporta entrada de imagen. Intenta con un modelo compatible con visión o adjunta documentos en lugar de imágenes."
  }
  if (/content.*policy|safety/i.test(raw)) {
    return "La solicitud no pudo ser procesada debido a las políticas de contenido."
  }
  return raw
}

function getResponseHeader(response: Response | { headers?: { get?: (name: string) => string | null } }, name: string): string | null {
  try {
    const get = response?.headers?.get
    return typeof get === "function" ? get.call(response.headers, name) : null
  } catch {
    return null
  }
}

// When the user's paid balance is exhausted, the backend silently serves the
// turn with the free fallback model (Cerebras Llama 3.1) and signals it via
// the `x-sira-fallback: free-ia` response header (see chargeCredits middleware
// + CLAUDE.md "FlashGPT"). The UI used to read NONE of this, so users couldn't
// tell they'd dropped to free-tier quality. Surface it once per response as a
// non-blocking toast. Lazy-imports sonner so this stays out of the SSR bundle
// and never throws if the toast lib is unavailable.
function notifyFreeIaFallback(response: Response | { headers?: { get?: (name: string) => string | null } }): void {
  try {
    if (typeof window === "undefined") return
    if (getResponseHeader(response, "x-sira-fallback") !== "free-ia") return
    const feature = getResponseHeader(response, "x-sira-fallback-feature")
    const detail = feature
      ? `Sin créditos para ${feature}: respondimos con el modelo gratuito ⚡ FlashGPT.`
      : "Sin créditos suficientes: respondimos con el modelo gratuito ⚡ FlashGPT."
    import("sonner")
      .then(({ toast }) => toast.info(detail, { duration: 6000 }))
      .catch(() => { /* toast lib unavailable — silent, header already logged server-side */ })
  } catch {
    /* never let a UX hint break the stream */
  }
}

/** Login/register must not send a stale Bearer token or treat 401 as "refresh session". */
function isCredentialHandshake(endpoint: string, method: string): boolean {
  if (method !== "POST") return false
  const pathOnly = (endpoint.split("?")[0] || "").replace(/\/$/, "")
  return pathOnly === "/auth/login" || pathOnly === "/auth/register"
}

function normalizedEndpointPath(endpoint: string): string {
  const raw = String(endpoint || "").trim()
  let pathOnly = raw
  try {
    pathOnly = new URL(raw, "https://siragpt.local").pathname
  } catch {
    pathOnly = raw.split("?")[0] || raw
  }
  if (pathOnly.startsWith("/api/")) pathOnly = pathOnly.slice(4)
  return pathOnly.replace(/\/$/, "") || "/"
}

function isExpectedAuthApiFailure(args: {
  endpoint: string
  method: string
  status?: number | null
  message?: string
  extra?: Record<string, unknown>
}): boolean {
  const status = Number(args.status)
  if (status !== 401 && status !== 403) return false

  const pathOnly = normalizedEndpointPath(args.endpoint)
  const text = `${args.message || ""} ${JSON.stringify(args.extra || {})}`.toLowerCase()

  if (status === 401 && pathOnly === "/auth/me") return true

  if (
    status === 401 &&
    isCredentialHandshake(args.endpoint, args.method) &&
    /invalid credentials|invalid_credentials/.test(text)
  ) {
    return true
  }

  if (
    /invalid or expired token|jwt expired|token expired|\binvalid token\b|missing token|access token required|unauthorized|not authenticated|authentication required|session revoked|re-?authentication required/.test(text)
  ) {
    return true
  }

  return false
}

// A benign 404 on GET /chats/<id> (chat deleted, or a stale id restored from
// localStorage) is expected — don't report it as an api error. Kept narrow:
// GET only, 404 only, EXACT /chats/<id> (never nested routes like
// /chats/:id/messages), so genuine failures still surface.
function isExpectedMissingChat(args: {
  endpoint: string
  method: string
  status?: number | null
}): boolean {
  if (Number(args.status) !== 404) return false
  if (String(args.method || "GET").toUpperCase() !== "GET") return false
  return /^\/chats\/[^/]+$/.test(normalizedEndpointPath(args.endpoint))
}

export type WebSource = {
  title: string
  url: string
  snippet?: string
  domain?: string
  confidence?: string
}

export type WebSourcesPayload = {
  provider?: string
  query?: string
  elapsedMs?: number
  sources: WebSource[]
}

export type MemoryItem = {
  id?: string
  fact: string
  category?: string
  tier?: string
  polarity?: string
  confidence?: number | null
  relevance?: number | null
  matchedTopics?: string[]
  semantic?: number | null
  why?: string
  ageMs?: number | null
  strength?: number | null
  score?: number | null
}

export type MemoryPayload = {
  reason?: string
  confidence?: number | null
  items: MemoryItem[]
}

// ── Agent harness (Phase 1) typed SSE events ───────────────────────────────
// Every frame carries a globally monotonic `seq` plus a `blockIndex` (one
// block per tool call), so the store renders deterministically regardless of
// frame interleaving or stream reconnects.
export type AgentToolCallStartEvent = {
  type: 'tool_call_start'
  seq: number
  blockIndex: number
  id: string
  name: string
  humanDescription?: string
  args?: string
  permissionTier?: 'auto' | 'confirm'
}
export type AgentToolExecutingEvent = {
  type: 'tool_executing'
  seq: number
  blockIndex: number
  id: string
  name?: string
}
export type AgentToolResultEvent = {
  type: 'tool_result'
  seq: number
  blockIndex: number
  id: string
  name?: string
  preview?: string
  isError?: boolean
  durationMs?: number
  status?: string
}
export type AgentPermissionRequestEvent = {
  type: 'permission_request'
  seq: number
  blockIndex: number
  id: string
  permissionId: string
  name: string
  humanDescription?: string
  args?: string
  expiresInMs?: number
}
export type AgentPermissionResolvedEvent = {
  type: 'permission_resolved'
  seq: number
  blockIndex: number
  id: string
  decision?: string
  scope?: string
  cached?: boolean
}
export type AgentDoneEvent = {
  type: 'agent_done'
  seq: number
  blockIndex?: number
  steps?: number
  toolCalls?: number
  errors?: number
  durationMs?: number
  tokensEstimate?: number
  costUsdEstimate?: number | null
  stoppedReason?: string | null
  interrupted?: boolean
}
export type AgentStreamEvent =
  | AgentToolCallStartEvent
  | AgentToolExecutingEvent
  | AgentToolResultEvent
  | AgentPermissionRequestEvent
  | AgentPermissionResolvedEvent
  | AgentDoneEvent

/** Registered external MCP server (headers never leave the backend). */
export type McpServerInfo = {
  id: string
  name: string
  url: string
  transport: 'streamable-http' | 'sse'
  enabled: boolean
  hasHeaders: boolean
  createdAt?: string
  updatedAt?: string
}

const AGENT_STREAM_EVENT_TYPES = new Set([
  'tool_call_start',
  'tool_executing',
  'tool_result',
  'permission_request',
  'permission_resolved',
  'agent_done',
])

type AIStreamOptions = {
  onReplace?: (content: string) => void
  onSources?: (payload: WebSourcesPayload) => void
  onMemory?: (payload: MemoryPayload) => void
  // Claude-style extended thinking. `onReasoning` receives each
  // chain-of-thought delta while the model is in its thinking phase;
  // `onReasoningDone` fires once with the total thinking duration when the
  // first visible token arrives (or the stream ends thought-only).
  onReasoning?: (delta: string) => void
  onReasoningDone?: (durationMs: number) => void
  // Tool-call deltas surfaced by reasoning models mid-stream: `name` arrives
  // on the first frame for an index, `argsDelta` carries argument fragments.
  onToolCall?: (payload: { index: number; name?: string; argsDelta?: string }) => void
  // Agent harness: typed tool-call / permission / done frames (AgentTrace).
  onAgentEvent?: (event: AgentStreamEvent) => void
  // Real token usage (+ optional USD cost) emitted once at stream end, so a
  // caller can show an honest "Agent Usage" figure. costOriginalUsd is the
  // provider list price; costAppliedUsd is after the plan policy (struck-through
  // original → applied when they differ).
  onUsage?: (payload: { tokensIn: number; tokensOut: number; model?: string; costOriginalUsd?: number; costAppliedUsd?: number }) => void
}

export type GrokVoiceSessionSnapshot = {
  version: string
  id: string
  chatId: string | null
  mode: 'advanced_voice' | 'dictation' | 'hands_free'
  status: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  lastTurnId: string | null
  turnCount: number
  capabilities: {
    persistentWhileChatting?: boolean
    chatComposerRemainsUsable?: boolean
    supportsDesktopActionPlanning?: boolean
    desktopBridge?: unknown
  }
}

export type GrokVoiceTurn = {
  id: string
  sessionId: string
  source: 'stt' | 'typed' | 'system'
  transcript: string
  route: 'chat_message' | 'desktop_action' | 'empty'
  responseMode: string
  chatDispatch?: {
    enabled: boolean
    text?: string
    chatId?: string | null
    mode?: string
    canUseComposerConcurrently?: boolean
    reason?: string
  }
  desktopAction?: unknown
  createdAt: string
}

export type GrokVoiceAssistantReply = {
  provider: string
  model: string
  configured: boolean
  text: string
  spoken?: boolean
  errorCode?: string
  ttsConfigured?: boolean
  ttsErrorCode?: string
  audio?: {
    provider: string
    voice?: string
    language?: string
    format: string
    mimeType: string
    base64: string
  }
}

export type GrokVoiceTranscriptEnvelope = {
  success: boolean
  provider: string
  model: string
  text: string
}

export type GrokVoiceSessionEnvelope = {
  success: boolean
  session: GrokVoiceSessionSnapshot
}

export type GrokVoiceTurnEnvelope = {
  success: boolean
  session: GrokVoiceSessionSnapshot
  turn: GrokVoiceTurn
  assistant?: GrokVoiceAssistantReply
}

export type OrganizationRole = "VIEWER" | "MEMBER" | "ADMIN" | "OWNER"

export type OrganizationSummary = {
  id: string
  name: string
  slug?: string | null
  billingPlan?: string | null
  ownerId?: string | null
  monthlyQuota?: string | number | null
  usedThisMonth?: string | number | null
  createdAt?: string | null
  role?: OrganizationRole
  joinedAt?: string | null
}

export type MyOrganizationsEnvelope = {
  items: OrganizationSummary[]
}

export type OrganizationInvitation = {
  id: string
  email: string
  role: Exclude<OrganizationRole, "OWNER">
  token: string
  magicLink: string
  expiresAt: string
}

export type UserNotification = {
  id: string
  type: string
  title: string
  message: string
  severity?: "info" | "warning" | "critical"
  read: boolean
  readAt?: string | null
  createdAt: string
  orgId?: string | null
  metadata?: Record<string, any> | null
}

export type UserNotificationsEnvelope = {
  items: UserNotification[]
  total: number
  unreadCount: number
  nextCursor?: string | null
}

export type OrganizationInvitationAcceptResult = {
  ok: boolean
  needs_verification?: boolean
  expiresAt?: string
  message?: string
  organization?: OrganizationSummary
  role?: OrganizationRole
}

class ApiClient {
  private baseURL: string;
  private token: string | null = null;

  // Retry config — transient network blips shouldn't fail the UI.
  // Only retries on network errors / 5xx; 4xx passes through immediately
  // EXCEPT for 429 / 503 which are retryable (Retry-After honored).
  private readonly MAX_RETRIES = 2;
  private readonly BASE_RETRY_DELAY_MS = 500;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30s
  // Hard ceiling on any single Retry-After wait. Without this, a
  // server returning Retry-After: 3600 would lock the UI for an hour.
  private readonly RETRY_AFTER_MAX_MS = 30000; // 30s

  // Refresh-token state — when a 401 fires, we attempt /auth/refresh once
  // and queue concurrent requests until it resolves.
  private _refreshing: Promise<boolean> | null = null;
  private _pendingQueue: Array<{
    resolve: (value: any) => void;
    reject: (err: any) => void;
  }> = [];

  // CSRF token state. The backend uses double-submit cookies:
  // GET /api/csrf-token sets both a public `csrf_token` cookie (non-httpOnly,
  // JS-readable) and an httpOnly `_csrf_secret` cookie. Mutating requests
  // must echo the public token in the `X-CSRF-Token` header.
  private _csrfTokenInFlight: Promise<string | null> | null = null;
  private _csrfToken: string | null = null; // cached stateless token (Safari ITP path)

  constructor(baseURL: string) {
    this.baseURL = baseURL;

    // Get token from localStorage on client side
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth-token');
    }
  }

  private _getAccessTokenSnapshot(): string | null {
    if (this.token) return this.token;
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem('auth-token');
    if (stored) {
      this.token = stored;
      return stored;
    }
    return null;
  }

  private _reportApiFailure(args: {
    endpoint: string
    method: string
    status?: number | null
    requestId?: string | null
    message?: string
    extra?: Record<string, unknown>
  }): void {
    if (args.endpoint.startsWith("/telemetry")) return
    if (isExpectedAuthApiFailure(args)) return
    if (isExpectedMissingChat(args)) return
    // A stable "not configured" 503 (e.g. Stripe billing off) is an expected
    // config state, not a server outage — don't report it as a server-error.
    if (
      Number(args.status) === 503 &&
      /not[ _]?configured/i.test(`${args.message || ""} ${JSON.stringify(args.extra || {})}`)
    ) return
    reportClientLog({
      source: "api",
      severity: args.status && args.status >= 500 ? "error" : "warn",
      action: "api_request_failed",
      endpoint: args.endpoint,
      method: args.method,
      status: args.status ?? null,
      requestId: args.requestId || null,
      message: args.message || "API request failed",
      extra: args.extra || null,
    })
  }

  /**
   * Core request method with timeout + retry.
   * Throws on final failure with status, statusCode, and errorData attached.
   *
   * Reliability primitives wired here (phase 8u):
   *
   *   - Auto Idempotency-Key on POST/PUT/PATCH. A v4 UUID is minted
   *     ONCE per logical call and stays stable across retries, so the
   *     backend's idempotency middleware (phase 8n) sees the same key
   *     on the original + every retry and replays the cached 2xx
   *     response instead of re-executing the operation. The key is
   *     skipped on GET/HEAD/OPTIONS (idempotent by HTTP semantics) and
   *     never overwritten if the caller passed one explicitly.
   *
   *   - Retry-After honor on 429 / 503. Previously the 4xx-immediate-
   *     fail block treated 429 as a hard failure; now the wrapper
   *     reads the Retry-After header (delta-seconds OR HTTP-date),
   *     waits, and retries up to MAX_RETRIES. The cap is bounded by
   *     RETRY_AFTER_MAX_MS so a misbehaving server with a 1-hour
   *     Retry-After can't pin the UI for an hour.
   */
  private async request(endpoint: string, options: RequestInit & { timeoutMs?: number; maxRetries?: number; suppressFailureLog?: boolean } = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const timeoutMs = options.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;
    const callerSignal = options.signal as AbortSignal | undefined;
    const makeAbortError = () => {
      const error = typeof DOMException !== 'undefined'
        ? new DOMException('Request aborted', 'AbortError')
        : new Error('Request aborted');
      (error as any).name = 'AbortError';
      return error;
    };
    // Per-request retry override. Expensive, non-idempotent generations
    // (image/video) pass 0: an automatic retry of a timed-out generation
    // triples the provider spend and multiplies the user's wait — the
    // caller recovers via chat polling instead.
    const maxRetries = options.maxRetries ?? this.MAX_RETRIES;

    // Build headers once (they don't change between retries — and
    // Idempotency-Key MUST stay stable across retries for the
    // backend dedup to work).
    const headers = new Headers(sanitizeFetchHeaders(options.headers as any));

    const method = String((options.method || "GET")).toUpperCase()

    const bearerToken = this._getAccessTokenSnapshot()
    if (bearerToken && !isCredentialHandshake(endpoint, method)) {
      headers.set("Authorization", `Bearer ${bearerToken}`)
    }

    // Only set Content-Type for non-FormData requests
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Idempotency-Key auto-injection. Only for mutating verbs and
    // only when the caller didn't supply one. safeUUID covers LAN /
    // plain-HTTP browser contexts where crypto.randomUUID is missing.
    const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (isMutating && method !== 'DELETE' && !headers.has('Idempotency-Key') && !headers.has('idempotency-key')) {
      headers.set('Idempotency-Key', safeUUID());
    }

    // CSRF double-submit token. Backend requires X-CSRF-Token on mutating
    // requests to cookie-auth routers (/api/auth, /api/users, /api/chats,
    // /api/files, /api/projects, /api/payments, /api/bookmarks, /api/orgs,
    // /api/library, /api/cowork, /api/thesis). Bearer-auth requests skip
    // CSRF server-side, but we set the header unconditionally on mutating
    // calls — harmless when not required.
    if (isMutating && !headers.has('X-CSRF-Token') && !headers.has('x-csrf-token')) {
      const csrf = await this._ensureCsrfToken();
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }

    // Track last error for re-throw on final failure
    let lastError: Error & { status?: number; statusCode?: number; errorData?: any } | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (callerSignal?.aborted) {
        throw makeAbortError();
      }

      // AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (callerSignal) {
        callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      }

      try {
        const config: RequestInit = {
          ...options,
          // Snapshot headers per attempt. The canonical `headers` object is
          // intentionally mutated after refresh (new Authorization), but each
          // fetch call should see the headers as they were at dispatch time.
          headers: new Headers(headers),
          credentials: 'include',
          signal: controller.signal as AbortSignal,
        };

        const response = await fetch(url, config);

        // HTTP-level success (2xx)
        if (response.ok) {
          clearTimeout(timeoutId);
          // Handle 204 No Content
          if (response.status === 204) return null;
          return await response.json();
        }

        // 429 — rate limited / quota exceeded. Honor Retry-After
        // header per RFC 9110 and retry up to MAX_RETRIES. We
        // intentionally branch on 429 BEFORE the generic 4xx block
        // because 429 IS retryable (unlike 400, 403, 404, 409).
        if (response.status === 429 || response.status === 503) {
          clearTimeout(timeoutId);
          if (attempt < maxRetries) {
            const retryAfterMs = this._parseRetryAfter(getResponseHeader(response, 'retry-after'));
            const waitMs = retryAfterMs !== null
              ? Math.min(retryAfterMs, this.RETRY_AFTER_MAX_MS)
              // No header → fall back to exponential backoff so the
              // server still gets relief if its rate limiter forgot
              // to send Retry-After.
              : this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          // Out of retries — fall through to the 4xx error path so
          // the caller sees the structured response body.
          const errorData = await response.json().catch(() => ({ error: 'Rate limited' }));
          const error = new Error(errorData.error || `HTTP ${response.status}`);
          (error as any).status = response.status;
          (error as any).statusCode = response.status;
          (error as any).errorData = errorData;
          this._reportApiFailure({
            endpoint,
            method,
            status: response.status,
            requestId: getResponseHeader(response, "X-Request-Id"),
            message: error.message,
            extra: { code: errorData.code || errorData.error || null },
          })
          throw error;
        }

        // 4xx — client error, don't retry (except 401 with refresh)
        if (response.status >= 400 && response.status < 500) {
          // 401 — attempt token refresh once before failing
          if (
            response.status === 401 &&
            this.token &&
            !isCredentialHandshake(endpoint, method)
          ) {
            const refreshed = await this._tryRefresh();
            if (refreshed) {
              // Update Authorization header with new token
              headers.set('Authorization', `Bearer ${this.token}`);
              clearTimeout(timeoutId);
              // Reset attempt counter so this doesn't consume a retry slot
              attempt = -1;
              continue;
            }
          }

          // 403 csrf_invalid — token rotated or missing. Refresh once and
          // retry transparently so the UI doesn't surface a CSRF error.
          if (response.status === 403 && isMutating) {
            const peek = await response.clone().json().catch(() => null) as { error?: string } | null;
            if (peek && peek.error === 'csrf_invalid') {
              // Force a fresh token (clear in-flight + drop stale cookie value
              // by re-fetching) and retry once. We cap at one CSRF retry by
              // tagging the headers so we don't loop indefinitely.
              if (!headers.has('X-CSRF-Retry')) {
                const fresh = await this._ensureCsrfToken(true);
                if (fresh) {
                  headers.set('X-CSRF-Token', fresh);
                  headers.set('X-CSRF-Retry', '1');
                  clearTimeout(timeoutId);
                  attempt = -1;
                  continue;
                }
              }
            }
          }

          clearTimeout(timeoutId);
          const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
          const error = new Error(errorData.error || `HTTP ${response.status}`);
          (error as any).status = response.status;
          (error as any).statusCode = response.status;
          (error as any).errorData = errorData;
          this._reportApiFailure({
            endpoint,
            method,
            status: response.status,
            requestId: getResponseHeader(response, "X-Request-Id"),
            message: error.message,
            extra: { code: errorData.code || errorData.error || null },
          })
          throw error;
        }

        // 5xx — server error, retry with backoff
        clearTimeout(timeoutId);
        lastError = new Error(`HTTP ${response.status}`);
        (lastError as any).status = response.status;
        (lastError as any).statusCode = response.status;

        // If it's the last attempt, try to parse the body for better error
        if (attempt === maxRetries) {
          const errorData = await response.json().catch(() => ({ error: 'Server error' }));
          lastError!.message = errorData.error || lastError!.message;
          (lastError as any).errorData = errorData;
        }
      } catch (error: any) {
        clearTimeout(timeoutId);

        // AbortError (timeout) — retry
        if (error.name === 'AbortError') {
          if (callerSignal?.aborted) {
            throw makeAbortError();
          }
          lastError = new Error(`Request timed out after ${timeoutMs}ms`);
          (lastError as any).status = 408;
          (lastError as any).statusCode = 408;
          continue;
        }

        // TypeError (network error, CORS, etc.) — retry
        if (error instanceof TypeError || error.message === 'Failed to fetch' || error.message?.includes('NetworkError')) {
          lastError = error;
          (lastError as any).status = 0;
          (lastError as any).statusCode = 0;
          // Not the last attempt — retry
          if (attempt < maxRetries) {
            const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // For errors thrown inside our block (4xx, already handled), re-throw
        throw error;
      } finally {
        clearTimeout(timeoutId);
        if (callerSignal) {
          callerSignal.removeEventListener('abort', abortFromCaller);
        }
      }

      // Exponential backoff before retry
      if (attempt < maxRetries) {
        const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // All retries exhausted
    const finalError = lastError || new Error('Request failed after retries');
    if (!options.suppressFailureLog) {
      console.error(`[ApiClient] Request failed after ${maxRetries + 1} attempts:`, endpoint, finalError.message);
      this._reportApiFailure({
        endpoint,
        method,
        status: (finalError as any).status ?? null,
        requestId: (finalError as any).errorData?.requestId || null,
        message: finalError.message,
      })
    }
    throw finalError;
  }

  // Public getter for baseURL
  get apiBaseURL() {
    return this.baseURL;
  }

  /**
   * _parseRetryAfter — turn an RFC 9110 Retry-After header value into
   * a millisecond delay relative to "now". Returns null when the
   * header is missing or unparseable so the caller falls back to
   * exponential backoff.
   *
   * Two valid formats per spec:
   *   - delta-seconds: `Retry-After: 30`
   *   - HTTP-date:     `Retry-After: Fri, 31 Dec 2030 23:59:59 GMT`
   *
   * Negative deltas (server clock skew) are clamped to 0; the caller
   * separately enforces the upper bound via RETRY_AFTER_MAX_MS.
   */
  private _parseRetryAfter(headerValue: string | null): number | null {
    if (!headerValue) return null;
    const trimmed = headerValue.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number.parseInt(trimmed, 10);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
    const epoch = Date.parse(trimmed);
    if (!Number.isNaN(epoch)) {
      return Math.max(0, epoch - Date.now());
    }
    return null;
  }

  /**
   * Read the `csrf_token` cookie (set by the backend's double-submit CSRF
   * middleware). Returns null when running on the server, when document.cookie
   * is unavailable, or when the cookie hasn't been issued yet.
   */
  private _readCsrfCookie(): string | null {
    if (typeof document === 'undefined') return null;
    const raw = document.cookie || '';
    const match = raw.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Ensure we have a CSRF token to attach to mutating requests. If the
   * cookie is already present we return it immediately; otherwise we hit
   * GET /api/csrf-token once (deduped via _csrfTokenInFlight) to have the
   * backend mint a fresh pair and surface the public token in the body.
   */
  private async _ensureCsrfToken(forceRefresh = false): Promise<string | null> {
    if (typeof window === 'undefined') return null;
    if (forceRefresh) { this._csrfToken = null; this._csrfTokenInFlight = null; }
    // Reuse the last good stateless token first. On Safari ITP the public
    // csrf_token cookie is dropped/partitioned (split-host) and goes stale,
    // so the cached stateless token is the only value that keeps validating.
    if (this._csrfToken) return this._csrfToken;
    if (!forceRefresh) {
      const existing = this._readCsrfCookie();
      if (existing) return existing; // double-submit path (non-Safari / same-origin)
    }
    if (this._csrfTokenInFlight) return this._csrfTokenInFlight;
    this._csrfTokenInFlight = (async () => {
      try {
        const res = await fetch(`${this.baseURL}/auth/csrf-token`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null) as { csrfToken?: string } | null;
        const token = (data && data.csrfToken) || this._readCsrfCookie();
        if (token) this._csrfToken = token; // cache the freshly minted stateless token
        return token;
      } catch {
        return null;
      } finally {
        this._csrfTokenInFlight = null;
      }
    })();
    return this._csrfTokenInFlight;
  }

  /**
   * Try to refresh the JWT token by calling /auth/refresh.
   * Ensures only one refresh is in-flight at a time.
   * Returns true if successful, false otherwise.
   */
  async _tryRefresh(): Promise<boolean> {
    // If a refresh is already in progress, wait for it
    if (this._refreshing) {
      return this._refreshing;
    }

    const tryRefreshRequest = async (includeBearer: boolean): Promise<boolean> => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (includeBearer && this.token) {
        headers.set('Authorization', `Bearer ${this.token}`);
      }

      try {
        const res = await fetch(`${this.baseURL}/auth/refresh`, {
          method: 'POST',
          headers,
          credentials: 'include',
        });

        if (!res.ok) return false;

        const data = await res.json();
        if (!data?.token) return false;
        this.setToken(data.token);
        return true;
      } catch {
        return false;
      }
    };

    this._refreshing = (async () => {
      // Legacy/browser clients can have a stale localStorage `auth-token`
      // while the httpOnly/session cookie is still valid (common after
      // deploys, mobile Safari restores, or older token refresh bugs). The
      // backend intentionally gives Authorization precedence over cookies, so
      // a stale Bearer poisons /auth/refresh and protected feature calls with
      // "Invalid or expired token". Preserve the old Bearer-first behavior for
      // token-only clients, then fall back once to cookie-only refresh.
      const refreshedWithBearer = this.token ? await tryRefreshRequest(true) : false;
      if (refreshedWithBearer) return true;

      const refreshedWithCookie = await tryRefreshRequest(false);
      if (refreshedWithCookie) return true;

      // Refresh failed — clear stale localStorage token so the next request
      // does not keep sending a poisoned Authorization header.
      this.setToken(null);
      return false;
    })();

    const result = await this._refreshing;
    this._refreshing = null;
    return result;
  }

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('auth-token', token);
      } else {
        localStorage.removeItem('auth-token');
      }
    }
  }

  // Auth endpoints
  // NOTE: return type kept loose for backward-compatibility with consumer
  // types (e.g. `User` in chat-context-integrated.tsx narrows `id` to
  // `string`). The codegen'd `AuthResponse` is a structural superset and
  // is documented in `api-types.ts` for refs and FE i18n lookups.
  // Returns AuthResponse at runtime but typed `any` so the consuming
  // auth-context (which uses a narrower local User type with `id: string`)
  // doesn't need a refactor in this cycle.
  async register(data: RegisterRequest): Promise<any> {
    const result = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (result?.token) {
      this.setToken(result.token);
    }

    return result;
  }

  async login(data: LoginRequest): Promise<any> {
    const result = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (result?.token) {
      this.setToken(result.token);
    }

    return result;
  }

  async logout() {
    await this.request('/auth/logout', { method: 'POST' });
    this.setToken(null);
  }

  // Super Admin Impersonation. Backend requires a `reason` (min 10 chars)
  // for the audit log; default to a generic admin-investigation reason
  // so existing call sites keep working without UI changes.
  async impersonateUser(userId: string, reason: string = 'Admin investigation / user support session'): Promise<ImpersonateEnvelope> {
    return (await this.request(`/auth/impersonate/${userId}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })) as ImpersonateEnvelope;
  }

  async endImpersonation(): Promise<SuccessEnvelope> {
    return (await this.request('/auth/end-impersonation', { method: 'POST' })) as SuccessEnvelope;
  }

  // Returns CurrentUserEnvelope at runtime, but typed as `any` because the
  // local User type in auth-context narrows `id` to `string` while the
  // codegen accepts `string | number`. Callers cast at consumption sites.
  async getCurrentUser(): Promise<any> {
    return this.request('/auth/me');
  }

  // Chat endpoints
  // Returns ChatsEnvelope at runtime — kept as `any` because consumers
  // store the result in the local Chat[] state (id: string only).
  async getChats(params?: { page?: number; limit?: number; projectId?: string; includeProjects?: boolean; includeArchived?: boolean; search?: string }): Promise<any> {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/chats${query ? `?${query}` : ''}`);
  }

  // getChat / createChat / updateChat all return ChatEnvelope at runtime,
  // but the consumers store the result in the local `Chat` interface
  // (which narrows `id` to `string`). Cycle 42 keeps these as `any` to
  // avoid a 50+ callsite refactor; revisit after the local Chat type is
  // generated from ChatResponse.
  async createChat(data: CreateChatRequest): Promise<any> {
    return this.request('/chats', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getChat(id: string): Promise<any> {
    return this.request(`/chats/${id}`);
  }

  async updateChat(id: string, data: { title?: string; model?: string }): Promise<any> {
    return this.request(`/chats/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteChat(id: string): Promise<{ success?: boolean; [key: string]: unknown } | null> {
    return (await this.request(`/chats/${id}`, { method: 'DELETE' })) as
      | { success?: boolean; [key: string]: unknown }
      | null;
  }

  async getActiveChatRuns(): Promise<{ runs: ChatRunSummary[] }> {
    return (await this.request('/chats/active-runs')) as { runs: ChatRunSummary[] };
  }

  /** Forget a single recalled memory by id (powers the "Olvidar" action). */
  async forgetMemory(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      await this.request(`/cowork/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  async getActiveChatRun(chatId: string): Promise<{ run: ChatRunSummary | null }> {
    return (await this.request(`/chats/${chatId}/run/active`)) as { run: ChatRunSummary | null };
  }

  async cancelChatRun(chatId: string, runId: string, reason = 'user_cancel'): Promise<{ ok: boolean; run: ChatRunSummary; noop?: boolean }> {
    return (await this.request(`/chats/${chatId}/run/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })) as { ok: boolean; run: ChatRunSummary; noop?: boolean };
  }

  async pinChat(id: string, pinned: boolean): Promise<{ chat: { id: string; isPinned: boolean; pinnedAt: string | null } }> {
    return (await this.request(`/chats/${id}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    })) as { chat: { id: string; isPinned: boolean; pinnedAt: string | null } };
  }

  async archiveChat(id: string, archived: boolean): Promise<{ chat: { id: string; isArchived: boolean } }> {
    return (await this.request(`/chats/${id}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    })) as { chat: { id: string; isArchived: boolean } };
  }

  // Returns AddMessageEnvelope at runtime — kept as `any` because the
  // local Message interface narrows `id` to `string`.
  async addMessage(chatId: string, data: { role: string; content: string; files?: string[]; metadata?: string; idempotencyKey?: string }): Promise<any> {
    return this.request(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async clearChat(chatId: string): Promise<SuccessEnvelope | null> {
    return (await this.request(`/chats/${chatId}/messages`, { method: 'DELETE' })) as SuccessEnvelope | null;
  }



  async clearMessageById(messageId: string): Promise<SuccessEnvelope | null> {
    return (await this.request(`/chats/messages/${messageId}/deleteMessage`, { method: 'DELETE' })) as SuccessEnvelope | null;
  }

  async handleFeedbackLikeDislike(messageId: string, feedbackType: 'liked' | 'disliked'): Promise<SuccessEnvelope> {
    return (await this.request(`/chats/messages/${messageId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback: feedbackType }),
    })) as SuccessEnvelope;
  }

  // Share complete chat
  async handleShare(chatId: String): Promise<ShareEnvelope> {
    return (await this.request(`/chats/${chatId}/share`, {
      method: 'POST',
      // body: JSON.stringify({}),
    })) as ShareEnvelope;
  }

  // Share individual message with its context
  async shareMessage(messageId: String, chatId: String): Promise<ShareEnvelope> {
    return (await this.request(`/chats/${chatId}/messages/${messageId}/share`, {
      method: 'POST',
      // body: JSON.stringify({}),
    })) as ShareEnvelope;
  }

  // Get shared chat content — returns shared chat payload (chat + meta).
  async shareChatIdLink(shareId: String): Promise<{
    chat?: { title?: string; [key: string]: unknown }
    chatTitle?: string
    [key: string]: unknown
  }> {
    return (await this.request(`/public/share/${shareId}`, {
      method: 'GET',
      // body: JSON.stringify({}),
    })) as { chat?: { title?: string; [key: string]: unknown }; chatTitle?: string; [key: string]: unknown };
  }

  // Get shared message content
  async shareMessageIdLink(shareId: String): Promise<{
    chat?: { title?: string; [key: string]: unknown }
    chatTitle?: string
    [key: string]: unknown
  }> {
    return (await this.request(`/public/share/message/${shareId}`, {
      method: 'GET',
      // body: JSON.stringify({}),
    })) as { chat?: { title?: string; [key: string]: unknown }; chatTitle?: string; [key: string]: unknown };
  }

  // Save shared content to user's account
  async saveSharedContent(shareType: 'message' | 'complete', shareData: any, title?: string): Promise<SuccessEnvelope & { chatId?: string | number }> {
    return (await this.request('/chats/save-shared', {
      method: 'POST',
      body: JSON.stringify({
        shareType,
        shareData,
        title
      }),
    })) as SuccessEnvelope & { chatId?: string | number };
  }

  async editUserMessage(messageId: string, data: { content: string }) {
    return this.request(`/chats/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }


  // File endpoints
  /**
   * Upload files to the backend with REAL progress (XHR-based — `fetch`
   * has no upload progress events as of late-2025 Safari/Firefox).
   *
   * @param files          FileList from picker / drop / paste
   * @param opts.sourceChannel  Telemetry tag: where the file came from
   *                            ('picker' | 'drop' | 'paste-files' | …)
   * @param opts.idempotencyKey  Stable per-batch key — server can dedupe
   *                            retries against the SAME upload attempt
   * @param opts.onProgress  Called with (percent 0-100, loadedBytes,
   *                         totalBytes) — wire to the chip's progress bar
   * @param opts.signal      AbortSignal — cancel mid-upload
   */
  async uploadFiles(
    files: FileList,
    opts: {
      sourceChannel?: string
      idempotencyKey?: string
      asyncProcessing?: boolean
      onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
      signal?: AbortSignal
    } = {}
  ): Promise<FileUploadResponse> {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('files', file));
    if (opts.sourceChannel) formData.append('sourceChannel', opts.sourceChannel);
    if (opts.asyncProcessing) formData.append('asyncProcessing', '1');

    const url = `${this.baseURL}/files/upload`;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      if (opts.idempotencyKey) xhr.setRequestHeader('Idempotency-Key', opts.idempotencyKey);
      xhr.withCredentials = true;
      // Don't set Content-Type — XHR sets it with boundary for FormData.

      if (opts.onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          opts.onProgress!(pct, ev.loaded, ev.total);
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as FileUploadResponse); }
          catch { resolve(xhr.responseText as unknown as FileUploadResponse); }
        } else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.onabort = () => reject(Object.assign(new Error('Upload aborted'), { name: 'AbortError' }));

      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(Object.assign(new Error('Upload aborted'), { name: 'AbortError' }));
          return;
        }
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      xhr.send(formData);
    });
  }

  async getFiles(params?: { page?: number; limit?: number; type?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/files${query ? `?${query}` : ''}`);
  }

  async getFile(id: string): Promise<FileEnvelope> {
    return (await this.request(`/files/${id}`)) as FileEnvelope;
  }

  async deleteFile(id: string) {
    return this.request(`/files/${id}`, { method: 'DELETE' });
  }

  async getFileContent(id: string): Promise<string> {
    const url = `${this.baseURL}/files/${id}/content`;
    const headers = new Headers();
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.text();
  }

  // AI endpoints
  // async generateAI(data: { model: string; prompt: string; chatId?: string; files?: string[] }) {
  //   return this.request('/ai/generate', {
  //     method: 'POST',
  //     body: JSON.stringify(data),
  //   });
  // }

  async stopAIStream(streamId: string) {
    return this.request('/ai/stop-stream', {
      method: 'POST',
      body: JSON.stringify({ streamId }),
    });
  }

  /**
   * Answer a pending agent tool-permission request (permission_request SSE
   * frame). `allow` resumes the paused tool call, `always_allow_in_chat`
   * additionally whitelists the tool for the rest of the chat, `deny` feeds
   * a permission-denied tool result back to the model.
   */
  async resolveAgentPermission(permissionId: string, decision: 'allow' | 'always_allow_in_chat' | 'deny') {
    return this.request('/agent/permission', {
      method: 'POST',
      body: JSON.stringify({ permissionId, decision }),
    });
  }

  // ── External MCP servers (agent harness) ─────────────────────────────────
  // Registered servers join every agent turn as mcp__<server>__<tool> with
  // the 'confirm' permission tier. Auth headers are encrypted server-side
  // and NEVER returned by the API (the list only carries `hasHeaders`).

  async listMcpServers(): Promise<{ servers: McpServerInfo[] }> {
    return this.request('/agent/mcp-servers', { method: 'GET' });
  }

  async createMcpServer(data: {
    name: string
    url: string
    transport?: 'streamable-http' | 'sse'
    headers?: Record<string, string>
    enabled?: boolean
  }): Promise<{ server: McpServerInfo }> {
    return this.request('/agent/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMcpServer(id: string, data: {
    name?: string
    url?: string
    transport?: 'streamable-http' | 'sse'
    headers?: Record<string, string>
    enabled?: boolean
  }): Promise<{ server: McpServerInfo }> {
    return this.request(`/agent/mcp-servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteMcpServer(id: string): Promise<{ ok: boolean }> {
    return this.request(`/agent/mcp-servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }


  // Stream chat completions from /ai/generate. Resilient by design:
  // automatically reconnects at the transport layer BEFORE the user sees
  // any tokens (HTTP 429, 5xx, network errors), while never duplicating
  // content that has already been rendered. Mid-stream interruptions
  // surface to the caller so the UI can show the per-message error +
  // retry affordance without losing the user's message.
  async generateAIStream(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[], streamId: string, regenerate?: boolean, regenerationAttempt?: number, disableAgentic?: boolean, reasoningEffort?: string, idempotencyKey?: string },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
    options: AIStreamOptions = {}
  ) {
    const url = `${this.baseURL}/ai/generate`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal }),
    };

    // Robustness contract for /api/ai/generate streaming:
    //  - Up to 5 reconnect attempts before surfacing an error to the UI
    //  - Exponential backoff with jitter: ~1s, 2s, 4s, 8s, 16s (cap 20s)
    //  - Retriable: HTTP 429, HTTP 5xx, transport errors ("Failed to
    //    fetch", ECONNRESET, ETIMEDOUT, socket dropped), AND
    //    "no se recibió respuesta" (the model stream ended dry — usually
    //    a provider-side hiccup that resolves on retry)
    //  - Honor Retry-After header on 429 if provided
    //  - Never retry after content has reached the user (no duplicates)
    //  - Never retry on AbortError (user clicked stop)
    //  - Per-attempt timing is logged so we can audit recovery cost
    const MAX_CONNECT_ATTEMPTS = 5;
    const BASE_RECONNECT_DELAY_MS = 1000;
    const MAX_RECONNECT_DELAY_MS = 20000;
    let hasDeliveredAnyContent = false;
    let lastError: any = null;

    const computeBackoff = (attempt: number, retryAfterSeconds?: number) => {
      if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
        return Math.min(retryAfterSeconds * 1000, MAX_RECONNECT_DELAY_MS);
      }
      // 2^(attempt-1) * base + 0..250ms jitter
      const exp = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY_MS);
      const jitter = Math.floor(Math.random() * 250);
      return Math.min(exp + jitter, MAX_RECONNECT_DELAY_MS);
    };

    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      if (signal?.aborted) { onError(new Error('Request aborted')); return; }
      if (hasDeliveredAnyContent) break;

      try {
        const response = await fetch(url, config);

        if (!response.ok) {
          let details: any = {};
          try { details = await response.json(); } catch { }
          const message = details.error || `HTTP ${response.status}`;

          try {
            if (typeof window !== 'undefined' && message && (/free (monthly|daily)/.test(message.toLowerCase()))) {
              window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
            }
          } catch (e) {
            console.warn('Failed to dispatch open-upgrade-modal event', e);
          }

          const err: any = new Error(message);
          err.status = response.status;
          if (details.code) err.code = details.code;

          // Retriable transport failures: 429 (rate-limit), 5xx server
          // errors, 408 timeout — only BEFORE any content has reached
          // the user. Anything else bubbles up (401/403 auth, 422
          // validation, monthly quota exhausted).
          const retriable = !hasDeliveredAnyContent
            && (response.status === 429 || response.status >= 500 || response.status === 408)
            && attempt < MAX_CONNECT_ATTEMPTS;
          if (retriable) {
            // Honor Retry-After header if the server set one (RFC 7231
            // §7.1.3). Value can be either an integer seconds or an
            // HTTP-date; we only parse the integer form here, the
            // server-side rate limiter always emits seconds.
            const retryAfter = parseInt(getResponseHeader(response, 'retry-after') || '', 10);
            const delay = computeBackoff(attempt, Number.isFinite(retryAfter) ? retryAfter : undefined);
            console.warn(`[ai-stream] HTTP ${response.status} on attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} — auto-reconnecting in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            lastError = err;
            continue;
          }
          throw err;
        }

        if (signal?.aborted) throw new Error('Request aborted');

        // Surface a silent paid→free model fallback (header set by the
        // backend chargeCredits middleware) before we start streaming tokens.
        notifyFreeIaFallback(response);

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Response body is not readable');

        const decoder = new TextDecoder('utf-8');
        let batchBuffer = '';
        // Sticky cross-read buffer — TCP packetization can split a single
        // SSE frame (`data: ...\n\n`) across two reader.read() calls, and
        // `[DONE]` / `replace` events arriving on the boundary used to be
        // dropped because we re-`split('\n\n')`-ed every chunk in isolation.
        // We now accumulate raw bytes and only consume up to the last
        // observed `\n\n`, leaving any partial trailing frame for the next
        // iteration.
        let frameBuffer = '';
        // Armed by a contentless [DONE]: break out of the read loop so the
        // outer attempt loop reconnects (mirrors the abrupt-close retry).
        let retryEmptyStream = false;
        let processedChunks = 0;
        const batchProcessingDelay = 20;
        let lastProcessTime = Date.now();

        const flushBatch = () => {
          if (batchBuffer.trim()) {
            onData(batchBuffer);
            hasDeliveredAnyContent = true;
            batchBuffer = '';
            lastProcessTime = Date.now();
          }
        };

        while (true) {
          if (signal?.aborted) { reader.cancel(); throw new Error('Request aborted'); }

          const { done, value } = await reader.read();
          if (done) {
            flushBatch();
            if (!hasDeliveredAnyContent) {
              // The stream ended before producing any token. Treat as
              // retriable transport failure if we still have attempts
              // left — provider may have rate-limited mid-handshake or
              // hit a transient 5xx that the reverse-proxy swallowed.
              if (attempt < MAX_CONNECT_ATTEMPTS) {
                const delay = computeBackoff(attempt);
                console.warn(`[ai-stream] empty stream on attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} — auto-reconnecting in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                lastError = new Error('Empty model stream');
                break; // jump to outer `for` to retry
              }
              onError(new Error('No se recibió respuesta del modelo. Intenta regenerar la respuesta.'));
              return;
            }
            onClose();
            return;
          }

          frameBuffer += decoder.decode(value, { stream: true });
          const lastBoundary = frameBuffer.lastIndexOf('\n\n');
          if (lastBoundary === -1) continue;
          const consumable = frameBuffer.slice(0, lastBoundary);
          frameBuffer = frameBuffer.slice(lastBoundary + 2);
          const lines = consumable.split('\n\n');

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.substring(6);
            // Sentinel the backend emits at the very end of every stream,
            // including error / recovered cases. Flush pending buffer,
            // close, and return — anything after is a leftover from a
            // broken proxy or a retransmit.
            if (payload === '[DONE]') {
              flushBatch();
              if (!hasDeliveredAnyContent) {
                // A clean [DONE] with zero tokens means the PROVIDER produced
                // nothing (transient provider error the backend closed over).
                // Retry with the same backoff budget as an abrupt close —
                // dying on the first empty stream while retrying empty
                // closes was an inconsistency.
                if (attempt < MAX_CONNECT_ATTEMPTS) {
                  // Release the previous connection before reconnecting —
                  // unlike the abrupt-close path (stream already ended),
                  // here the body may still be open.
                  try { await reader.cancel(); } catch { /* already closed */ }
                  const delay = computeBackoff(attempt);
                  console.warn(`[ai-stream] contentless [DONE] on attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} — auto-reconnecting in ${delay}ms`);
                  await new Promise(r => setTimeout(r, delay));
                  lastError = new Error('Empty model stream');
                  retryEmptyStream = true;
                  break;
                }
                onError(new Error('No se recibió respuesta del modelo. Intenta regenerar la respuesta.'));
                return;
              }
              onClose();
              return;
            }
            try {
              const jsonData = JSON.parse(payload);
              if (jsonData.replace && typeof jsonData.content === 'string') {
                flushBatch();
                if (options.onReplace) {
                  options.onReplace(jsonData.content);
                } else {
                  onData(jsonData.content);
                }
                hasDeliveredAnyContent = true;
                lastProcessTime = Date.now();
              } else if (jsonData.content) {
                batchBuffer += jsonData.content;
                processedChunks++;

                const timeSinceLastProcess = Date.now() - lastProcessTime;
                const shouldProcess =
                  batchBuffer.length >= 150 ||
                  timeSinceLastProcess >= batchProcessingDelay ||
                  jsonData.content.includes('\n');

                if (shouldProcess) flushBatch();
              } else if (jsonData.type === 'reasoning_delta' && typeof jsonData.reasoning === 'string') {
                // Chain-of-thought delta (ThinkingTrace). Deliberately keyed
                // `reasoning` (not `content`) so legacy parsers ignore it.
                if (options.onReasoning) options.onReasoning(jsonData.reasoning);
                lastProcessTime = Date.now();
              } else if (jsonData.type === 'reasoning_done') {
                if (options.onReasoningDone) {
                  options.onReasoningDone(typeof jsonData.durationMs === 'number' ? jsonData.durationMs : 0);
                }
              } else if (jsonData.type === 'tool_call_delta') {
                if (options.onToolCall) {
                  options.onToolCall({
                    index: typeof jsonData.index === 'number' ? jsonData.index : 0,
                    ...(jsonData.name ? { name: jsonData.name } : {}),
                    ...(jsonData.argsDelta ? { argsDelta: jsonData.argsDelta } : {}),
                  });
                }
              } else if (typeof jsonData.type === 'string' && AGENT_STREAM_EVENT_TYPES.has(jsonData.type)) {
                // Agent harness typed frames (tool_call_start / tool_executing /
                // tool_result / permission_request / permission_resolved /
                // agent_done) — ordered by seq/blockIndex in the store.
                if (options.onAgentEvent) {
                  options.onAgentEvent(jsonData as AgentStreamEvent);
                }
              } else if (jsonData.type === 'usage' && typeof jsonData.tokensIn === 'number') {
                // Real token usage (+ optional USD cost) for the Worked Summary.
                if (options.onUsage) {
                  options.onUsage({
                    tokensIn: jsonData.tokensIn,
                    tokensOut: typeof jsonData.tokensOut === 'number' ? jsonData.tokensOut : 0,
                    ...(typeof jsonData.model === 'string' ? { model: jsonData.model } : {}),
                    ...(typeof jsonData.costOriginalUsd === 'number' ? { costOriginalUsd: jsonData.costOriginalUsd } : {}),
                    ...(typeof jsonData.costAppliedUsd === 'number' ? { costAppliedUsd: jsonData.costAppliedUsd } : {}),
                  })
                }
              } else if (jsonData.type === 'web_sources' && Array.isArray(jsonData.sources)) {
                // ChatGPT-style searched-sources frame. Surface to the UI
                // so it can render the "Fuentes" chip + Activity panel.
                if (options.onSources) {
                  options.onSources({
                    provider: jsonData.provider,
                    query: jsonData.query,
                    elapsedMs: jsonData.elapsedMs,
                    sources: jsonData.sources,
                  });
                }
              } else if (jsonData.type === 'memory' && Array.isArray(jsonData.items)) {
                // Autonomous-memory frame: the turn decided to recall stored
                // facts. Surface them so the UI shows the "MEMORIA" section.
                if (options.onMemory) {
                  options.onMemory({
                    reason: jsonData.reason,
                    items: jsonData.items,
                  });
                }
              } else if (jsonData.error) {
                // When the backend recovered the turn with a localized
                // fallback message, we've already delivered a useful
                // reply to the user — don't surface a red toast on top.
                if (jsonData.recovered) {
                  console.warn('[ai-stream] recovered from provider error:', jsonData.error);
                } else {
                  onError(new Error(sanitizeStreamError(jsonData.error)));
                }
              }
            } catch (e) {
              console.warn('Failed to parse streaming data:', e);
            }
          }
          if (retryEmptyStream) break; // reconnect via the outer attempt loop
        }
      } catch (error: any) {
        lastError = error;
        if (error?.name === 'AbortError' || signal?.aborted) {
          onError(error);
          return;
        }

        // Transport-layer network failure BEFORE any content reached
        // the user? Reconnect with exponential backoff. "Failed to
        // fetch" (TypeError) is the most common one — happens when the
        // backend SSE socket drops mid-handshake, the wifi/network
        // hiccups, or a reverse proxy returns nothing.
        const isNetworkError = error?.name === 'TypeError'
          || /fetch failed|failed to fetch|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|empty model stream/i.test(error?.message || '');
        if (!hasDeliveredAnyContent && isNetworkError && attempt < MAX_CONNECT_ATTEMPTS) {
          const delay = computeBackoff(attempt);
          console.warn(`[ai-stream] network error on attempt ${attempt}/${MAX_CONNECT_ATTEMPTS}: "${error.message}" — auto-reconnecting in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        console.error('API stream failed:', error);
        // Convert raw "Failed to fetch" into a human-friendly message.
        // The model wasn't able to reply after every retry — surface
        // an actionable hint instead of a meaningless browser error.
        if (isNetworkError && !hasDeliveredAnyContent) {
          onError(new Error('No se pudo conectar con el modelo después de varios intentos. Verifica tu conexión o reintenta en unos segundos.'));
          return;
        }
        onError(error);
        return;
      }
    }

    // Fallthrough: loop exited without a successful return. This path
    // is taken when all attempts ended in retriable HTTP errors or
    // empty streams — surface the last captured error to the UI with
    // a clean message.
    if (lastError) {
      const msg = lastError?.message || 'Stream failed';
      const isQuota = /429|too many|rate/i.test(msg);
      const friendly = isQuota
        ? 'El servidor está procesando muchas solicitudes. Reintenta en unos segundos.'
        : `No se pudo completar la respuesta después de ${MAX_CONNECT_ATTEMPTS} intentos. ${msg}`;
      onError(new Error(friendly));
    }
  }
  async generateImage(
    data: { prompt: string; chatId?: string; provider: string; model: string; fileId?: string; aspectRatio?: string; quality?: string; imageCount?: number },
    options: { signal?: AbortSignal } = {},
  ) {
    const timeoutMs = 210000;
    const imageRequestStartedAt = Date.now();
    const requestPromise = this.request('/ai/generate-image', {
      method: 'POST',
      body: JSON.stringify(data),
      signal: options.signal,
      // Image generation routinely takes 60-180s (gpt-image-2, Seedream,
      // Imagen). The backend enforces its own 200s deadline and answers
      // with a real result or error by then — waiting 210s (> 200s)
      // guarantees that verdict arrives within a single attempt instead
      // of the client aborting at 180s while the server is still working.
      timeoutMs: 210000,
      // Never auto-retry: a retried generation is a NEW paid generation
      // (3x provider spend) and 3x the wait. On timeout the caller falls
      // back to waitForGeneratedImage(), which picks up the image the
      // backend persists to the chat.
      maxRetries: 0,
      suppressFailureLog: true,
    });
    const response = await this.resolveImageRequestWithChatRecovery(requestPromise, {
      chatId: data.chatId,
      sinceMs: imageRequestStartedAt,
      signal: options.signal,
      timeoutMs,
    });
    // El backend ahora envía cabeceras 200 al inicio (para no morir
    // en el proxy de 30 s) y, si la generación falla después, devuelve
    // `{ error, code }` con status 200. Sin esta comprobación, la UI
    // trataría el fallo como éxito.
    if (response && typeof response === 'object' && (response as any).error) {
      const err: any = new Error((response as any).error);
      err.code = (response as any).code;
      throw err;
    }
    return response;
  }
  async generateImageByImage(data: { fileId: string, prompt: string; chatId?: string, provider: string; model: string; }) {
    const timeoutMs = 210000;
    const imageRequestStartedAt = Date.now();
    const requestPromise = this.request('/ai/generate-image', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs, // > backend 200s deadline; see generateImage
      maxRetries: 0,     // non-idempotent paid generation — never auto-retry
      suppressFailureLog: true,
    })
    const response = await this.resolveImageRequestWithChatRecovery(requestPromise, {
      chatId: data.chatId,
      sinceMs: imageRequestStartedAt,
      timeoutMs,
    });
    if (response && typeof response === 'object' && (response as any).error) {
      const err: any = new Error((response as any).error);
      err.code = (response as any).code;
      throw err;
    }
    return response
  }

  private async resolveImageRequestWithChatRecovery(
    requestPromise: Promise<any>,
    options: { chatId?: string; sinceMs: number; signal?: AbortSignal; timeoutMs: number },
  ): Promise<any> {
    const chatId = String(options.chatId || '').trim();
    if (!chatId) return requestPromise;

    let requestSettled = false;
    const trackedRequest = requestPromise.finally(() => {
      requestSettled = true;
    });

    const edgeRecoveryDelayMs = Math.min(31_000, Math.max(0, options.timeoutMs - 1_000));
    const recoveryPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, edgeRecoveryDelayMs));
      if (requestSettled || options.signal?.aborted) return null;

      const outcome = await this.waitForGeneratedImage(chatId, options.sinceMs, {
        signal: options.signal,
        timeoutMs: Math.max(1_000, options.timeoutMs - edgeRecoveryDelayMs),
        intervalMs: 2000,
      });

      if (outcome === 'image') return { recoveredFromChat: true as const };
      if (outcome === 'error') {
        return {
          error: 'No se pudo generar la imagen. Inténtalo de nuevo.',
          code: 'image_generation_failed',
        };
      }
      return null;
    })();

    try {
      return await Promise.race([
        trackedRequest,
        recoveryPromise.then((recovered) => recovered ?? trackedRequest),
      ]);
    } catch (error: any) {
      const status = Number(error?.status ?? error?.statusCode);
      const message = String(error?.message || '');
      const isTimeout = status === 408 || /timed out|timeout/i.test(message);
      if (!isTimeout) throw error;

      const finalOutcome = await this.waitForGeneratedImage(chatId, options.sinceMs, {
        signal: options.signal,
        timeoutMs: 15_000,
        intervalMs: 2_000,
      });
      if (finalOutcome === 'image') return { recoveredFromChat: true as const };
      if (finalOutcome === 'error') {
        return {
          error: 'No se pudo generar la imagen. Inténtalo de nuevo.',
          code: 'image_generation_failed',
        };
      }

      const friendly: any = new Error('La generación de imagen tardó demasiado. Inténtalo de nuevo o baja la calidad/cantidad.');
      friendly.status = 408;
      friendly.statusCode = 408;
      friendly.code = 'image_generation_timeout';
      throw friendly;
    }
  }

  // El Load Balancer de la Reserved VM corta la petición a los ~30s, pero el
  // backend sigue generando y persiste la imagen (o un mensaje de error) en el
  // chat. Cuando el POST se corta, sondeamos el chat hasta que aparezca un
  // mensaje del asistente con una imagen posterior a `sinceMs` (o se agote el
  // tiempo). Devuelve 'image' si la imagen está lista, 'error' si el backend
  // persistió un fallo, o 'timeout' si se agotó el tiempo / se canceló.
  async waitForGeneratedImage(
    chatId: string,
    sinceMs: number,
    options: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<'image' | 'error' | 'timeout'> {
    const timeoutMs = options.timeoutMs ?? 210000;
    const intervalMs = options.intervalMs ?? 3000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (options.signal?.aborted) return 'timeout';
      try {
        const resp: any = await this.getChat(chatId);
        const messages: any[] = resp?.chat?.messages || [];
        for (const m of messages) {
          if (String(m?.role || '').toUpperCase() !== 'ASSISTANT') continue;
          const ts = m?.timestamp ? new Date(m.timestamp).getTime() : 0;
          if (ts && ts < sinceMs - 5000) continue;
          let files: any = m?.files;
          if (typeof files === 'string') {
            try { files = JSON.parse(files); } catch { files = []; }
          }
          const hasImage = Array.isArray(files)
            && files.some((f: any) => f && f.type === 'image' && (f.url || f.fileId));
          if (hasImage) return 'image';
          // El backend persiste los fallos post-desconexión como un mensaje
          // del asistente con este texto; lo detectamos para salir rápido en
          // vez de esperar al timeout completo.
          const content = typeof m?.content === 'string' ? m.content : '';
          if (content.includes('No se pudo generar la imagen')) return 'error';
        }
      } catch {
        /* transient network/auth hiccup — keep polling */
      }
    }
    return 'timeout';
  }

  async generateGmailResponse(data: { prompt: string; chatId?: string; model: string; type: string }) {
    const response = await this.request('/ai/generate-gmail', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    return response;
  }

  // ✅ Word Document Generation Stream - Specialized for Word Connector
  async generateWordStream(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[], streamId: string, mode?: 'create' | 'rewrite', selectedText?: string },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
    signal?: AbortSignal
  ) {
    const url = `${this.baseURL}/document-ai/generate-word`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal })
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        let details: any = {};
        try { details = await response.json(); } catch { }
        const message = details.error || `HTTP ${response.status}`;

        if (typeof window !== 'undefined' && message && (/free (monthly|daily)/.test(message.toLowerCase()))) {
          window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
        }

        const error: any = new Error(message);
        if (details.code) error.code = details.code;
        throw error;
      }

      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder('utf-8');
      let batchBuffer = '';
      // Accumulate across reads: a `data: {...}\n\n` frame can straddle two
      // reader.read() calls; splitting each chunk in isolation dropped the
      // partial frame. Mirror generateAIStream's frameBuffer parser.
      let frameBuffer = '';
      let lastProcessTime = Date.now();
      const batchProcessingDelay = 20;

      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          throw new Error('Request aborted');
        }

        const { done, value } = await reader.read();

        if (done) {
          if (batchBuffer.trim()) {
            onData(batchBuffer);
          }
          onClose();
          break;
        }

        frameBuffer += decoder.decode(value, { stream: true });
        const lastBoundary = frameBuffer.lastIndexOf('\n\n');
        if (lastBoundary === -1) continue;
        const consumable = frameBuffer.slice(0, lastBoundary);
        frameBuffer = frameBuffer.slice(lastBoundary + 2);
        const lines = consumable.split('\n\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonData = JSON.parse(line.substring(6));
              if (jsonData.content) {
                batchBuffer += jsonData.content;
                const timeSinceLastProcess = Date.now() - lastProcessTime;
                const shouldProcess =
                  batchBuffer.length >= 150 ||
                  timeSinceLastProcess >= batchProcessingDelay ||
                  jsonData.content.includes('\n');

                if (shouldProcess && batchBuffer.trim()) {
                  onData(batchBuffer);
                  batchBuffer = '';
                  lastProcessTime = Date.now();
                }
              } else if (jsonData.error) {
                onError(new Error(jsonData.error));
              } else if (jsonData.done) {
                if (batchBuffer.trim()) {
                  onData(batchBuffer);
                }
                onClose();
                return;
              }
            } catch (e) {
              console.warn('Failed to parse streaming data:', e);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Word Document API stream failed:', error);
      onError(error);
    }
  }

  // ✅ Excel Workbook Generation - Simple POST request (no streaming)
  async generateExcel(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[] },
    signal?: AbortSignal
  ): Promise<{ success: boolean; data: any }> {
    const url = `${this.baseURL}/ai/generate-excel`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal })
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        let details: any = {};
        try { details = await response.json(); } catch { }
        const message = details.error || `HTTP ${response.status}`;

        if (typeof window !== 'undefined' && message && (/free (monthly|daily)/.test(message.toLowerCase()))) {
          window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
        }

        const error: any = new Error(message);
        if (details.code) error.code = details.code;
        throw error;
      }

      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const result = await response.json();
      return result;
    } catch (error: any) {
      console.error('Excel generation API failed:', error);
      throw error;
    }
  }

  /*async generateAI(data: { model: string; messages: any[]; chatId?: string; files?: string[] }) {
    return this.request('/ai/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }*/

  // async getAIModels() {
  //   return this.request('/ai/models');
  // }
  async getAIModels(type?: 'TEXT' | 'IMAGE' | 'VIDEO') { // type ko optional parameter banayein
    const endpoint = type ? `/ai/models?type=${type}` : '/ai/models';
    // Always read the live list: the picker must reflect an admin model
    // activation immediately, so bypass the 5-min server response-cache
    // (response-cache honours Cache-Control: no-cache → forced MISS).
    return this.request(endpoint, { headers: { 'Cache-Control': 'no-cache' } });
  }

  // Admin connections — CRUD + test
  async getAdminConnections() {
    return this.request('/admin/connections');
  }
  async createAdminConnection(payload: any) {
    return this.request('/admin/connections', { method: 'POST', body: JSON.stringify(payload) });
  }
  async updateAdminConnection(id: string, payload: any) {
    return this.request(`/admin/connections/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  }
  async deleteAdminConnection(id: string) {
    return this.request(`/admin/connections/${id}`, { method: 'DELETE' });
  }
  async testAdminConnection(id: string) {
    return this.request(`/admin/connections/${id}/test`, { method: 'POST' });
  }
  async healthCheckAdminConnections() {
    return this.request('/admin/connections/health-check', { method: 'POST' });
  }

  // Payment endpoints
  async createStripePayment(data: { plan: string }) {
    return this.request('/payments/stripe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async verifyPaymentSession(sessionId: string) {
    return this.request(`/payments/verify-session?session_id=${sessionId}`);
  }

  async getSubscriptionInfo() {
    return this.request('/payments/subscription');
  }

  async cancelSubscription() {
    return this.request('/payments/subscription/cancel', {
      method: 'POST',
    });
  }

  async reactivateSubscription() {
    return this.request('/payments/subscription/reactivate', {
      method: 'POST',
    });
  }

  async previewPlanChange(data: { newPlan: string }) {
    return this.request('/payments/plan-change/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async executePlanChange(data: { newPlan: string; immediate: boolean }) {
    return this.request('/payments/plan-change/execute', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async cancelScheduledPlanChange() {
    return this.request('/payments/plan-change/cancel', {
      method: 'POST',
    });
  }



  async getSubscriptionAnalytics(period = '30d') {
    return this.request(`/payments/analytics?period=${period}`);
  }

  async getNotifications(limit = 50): Promise<UserNotificationsEnvelope> {
    return (await this.request(`/users/me/notifications?filter=all&limit=${limit}`)) as UserNotificationsEnvelope;
  }

  async markNotificationRead(notificationId: string) {
    return this.request(`/users/me/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
    });
  }

  async markAllNotificationsRead() {
    return this.request('/users/me/notifications/read-all', {
      method: 'POST',
    });
  }

  async createPayPalPayment(data: Pick<CreatePaymentRequest, 'plan'>) {
    return this.request('/payments/paypal', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createMercadoPagoPayment(data: Pick<CreatePaymentRequest, 'plan'>) {
    return this.request('/payments/mercadopago', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getPayments(params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/payments${query ? `?${query}` : ''}`);
  }

  // Organization / team endpoints
  async listMyOrganizations(): Promise<MyOrganizationsEnvelope> {
    return (await this.request('/orgs/me')) as MyOrganizationsEnvelope;
  }

  async createOrganization(data: { name: string; slug?: string }): Promise<OrganizationSummary> {
    return (await this.request('/orgs', {
      method: 'POST',
      body: JSON.stringify(data),
    })) as OrganizationSummary;
  }

  async inviteOrganizationMember(
    orgId: string,
    data: {
      email: string
      role?: Exclude<OrganizationRole, "OWNER">
      projectName?: string
      workspaceUrl?: string
    },
  ): Promise<OrganizationInvitation> {
    return (await this.request(`/orgs/${encodeURIComponent(orgId)}/invite`, {
      method: 'POST',
      body: JSON.stringify({ role: 'MEMBER', ...data }),
    })) as OrganizationInvitation;
  }

  async acceptOrganizationInvitation(token: string): Promise<OrganizationInvitationAcceptResult> {
    return (await this.request(`/orgs/invitation/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
    })) as OrganizationInvitationAcceptResult;
  }

  // User endpoints
  async getUserProfile() {
    return this.request('/users/profile');
  }

  async updateUserProfile(data: { name?: string; email?: string; avatar?: string }) {
    return this.request('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async getUserSettings() {
    return this.request('/users/settings');
  }

  async updateUserSettings(patch: Record<string, any>) {
    return this.request('/users/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  // Task 18 — narrow PATCH for email-notification opt-outs (see
  // backend/src/routes/users.js#patch /me/settings). Only the
  // `notifications` subtree is accepted server-side and only keys in
  // `VALID_CATEGORIES` (email-preferences.js) survive the merge.
  async updateNotificationPreferences(notifications: Record<string, boolean>) {
    return this.request('/users/me/settings', {
      method: 'PATCH',
      body: JSON.stringify({ notifications }),
    });
  }

  async getUserSessions() {
    return this.request('/users/sessions');
  }

  async revokeOtherSessions() {
    return this.request('/users/sessions/revoke-others', { method: 'POST' });
  }

  async getChatStats() {
    return this.request('/users/chat-stats');
  }

  async archiveAllChats() {
    return this.request('/users/chats/archive-all', { method: 'POST' });
  }

  async clearChatHistory() {
    return this.request('/users/chats/clear-history', { method: 'POST' });
  }

  // ── Memory document (per-user, auto-learned + editable) ──────────
  async getMemory(): Promise<{ entries: any[]; markdown: string; stats: { total: number; byCategory: Record<string, number> } }> {
    return this.request('/memory');
  }
  async searchMemory(q: string): Promise<{ query: string; results: any[] }> {
    return this.request(`/memory/search?q=${encodeURIComponent(q)}`);
  }
  async addMemoryEntry(text: string, category?: string): Promise<{ entry: any }> {
    return this.request('/memory', { method: 'POST', body: JSON.stringify({ text, category }) });
  }
  async updateMemoryEntry(id: string, patch: { text?: string; category?: string }): Promise<{ entry: any }> {
    return this.request(`/memory/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  async deleteMemoryEntry(id: string): Promise<{ ok: boolean }> {
    return this.request(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async clearMemory(): Promise<{ ok: boolean }> {
    return this.request('/memory', { method: 'DELETE' });
  }

  async changePassword(data: { currentPassword: string; newPassword: string }) {
    return this.request('/users/password', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async getUserUsage(period?: string) {
    return this.request(`/users/usage${period ? `?period=${period}` : ''}`);
  }

  async deleteAccount() {
    return this.request('/users/account', { method: 'DELETE' });
  }

  // User preferences endpoints
  async getUserPreferences() {
    return this.request('/users/preferences');
  }

  async updateUserPreferences(data: any) {
    return this.request('/users/preferences', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Payment method endpoints
  async getPaymentMethods() {
    return this.request('/payments/methods');
  }

  async addPaymentMethod(data: any) {
    return this.request('/payments/methods', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removePaymentMethod(id: string) {
    return this.request(`/payments/methods/${id}`, {
      method: 'DELETE',
    });
  }

  async setDefaultPaymentMethod(id: string) {
    return this.request(`/payments/methods/${id}/default`, {
      method: 'PUT',
    });
  }

  // Billing address endpoints
  async getBillingAddress() {
    return this.request('/payments/billing-address');
  }

  async updateBillingAddress(data: any) {
    return this.request('/payments/billing-address', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Invoice endpoints
  async listStripeInvoices() {
    return this.request('/payments/stripe/invoices');
  }

  async downloadInvoice(paymentId: string) {
    const response = await fetch(`${this.baseURL}/payments/invoice/${paymentId}`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadStripeInvoice(invoiceId: string) {
    const response = await fetch(`${this.baseURL}/payments/stripe/invoice/${invoiceId}`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  // Admin endpoints
  async getUsers(params?: { page?: number; limit?: number; search?: string; plan?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/users${query ? `?${query}` : ''}`);
  }

  async updateUser(id: string, data: { plan?: string; isAdmin?: boolean; monthlyLimit?: number }) {
    return this.request(`/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(id: string) {
    return this.request(`/admin/users/${id}`, { method: 'DELETE' });
  }

  async createUserAdmin(data: { name: string; email: string; password: string; plan?: string; isAdmin?: boolean; monthlyLimit?: number }) {
    // Calls admin POST /admin/users - requires admin session token
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  async getAnalytics() {
    return this.request('/admin/analytics');
  }

  async getAllPayments(params?: { page?: number; limit?: number; status?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/payments${query ? `?${query}` : ''}`);
  }

  async getSystemStats() {
    return this.request('/admin/stats');
  }

  async getAdminUserStats(params?: { from?: string; to?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stats/users${query ? `?${query}` : ''}`);
  }

  async getAdminUsageStats(params?: { from?: string; to?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stats/usage${query ? `?${query}` : ''}`);
  }

  async getAdminFileStats(params?: { from?: string; to?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stats/files${query ? `?${query}` : ''}`);
  }

  async getAdminAgentStats(params?: { from?: string; to?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stats/agents${query ? `?${query}` : ''}`);
  }

  async getAdminServiceHealth() {
    return this.request('/admin/health/services');
  }

  async getAdminBackups() {
    return this.request('/admin/backups');
  }

  async getAdminMaintenanceMode() {
    return this.request('/admin/maintenance/mode');
  }

  async setAdminMaintenanceMode(data: { enabled: boolean; message?: string | null }) {
    return this.request('/admin/maintenance/mode', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getAdminSystemSummary() {
    return this.request('/admin/system-summary');
  }

  async getAdminSystemSnapshot() {
    return this.request('/admin/system-snapshot');
  }

  async getAdminAuditLogs(params?: {
    page?: number
    limit?: number
    userId?: string
    action?: string
    resource?: string
    resourceId?: string
    tags?: string
    from?: string
    to?: string
    order?: "asc" | "desc"
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/audit-logs${query ? `?${query}` : ''}`);
  }

  async searchAdminAuditLogs(params: {
    q: string
    page?: number
    limit?: number
    tags?: string
    from?: string
    to?: string
    order?: "asc" | "desc"
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/audit-logs/search?${query}`);
  }

  async exportAdminAuditLogsCsv(params?: {
    userId?: string
    action?: string
    resource?: string
    resourceId?: string
    tags?: string
    from?: string
    to?: string
    order?: "asc" | "desc"
    limit?: number
  }) {
    const query = new URLSearchParams(params as any).toString();
    const response = await fetch(`${this.baseURL}/admin/audit-logs.csv${query ? `?${query}` : ''}`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Failed to export audit logs');
      throw new Error(error || `HTTP ${response.status}`);
    }

    return response.text();
  }

  // Admin invoices
  async getAdminStripeInvoices(params?: { limit?: number; starting_after?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stripe/invoices${query ? `?${query}` : ''}`);
  }

  async downloadAdminStripeInvoice(invoiceId: string) {
    const response = await fetch(`${this.baseURL}/admin/stripe/invoice/${invoiceId}`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async exportUsersCsv() {
    const response = await fetch(`${this.baseURL}/admin/users/export/csv`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Failed to export users');
      throw new Error(error || `HTTP ${response.status}`);
    }

    return response.text();
  }

  // Download endpoints
  async downloadExcel(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/excel`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadCSV(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/csv`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadText(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/text`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadWord(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/word`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadPowerPoint(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/powerpoint`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  // ElevenLabs endpoints
  async getVoices() {
    return this.request('/elevenlabs/voices');
  }

  async getModels() {
    return this.request('/elevenlabs/models');
  }
  async textToSpeech(data: {
    text: string;
    voice_id?: string;
    model_id?: string;
    voice_settings?: {
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
    };
  }) {
    return this.request('/elevenlabs/text-to-speech', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Deterministic text-to-speech for the chat composer's Voice mode. Unlike the
  // agentic path (which depended on a weak model choosing to call a tool), this
  // always produces the MP3 and persists it as a "Generation N" chat artifact.
  async generateSpeechMessage(data: {
    text: string;
    chatId?: string | null;
    voiceId?: string;
    modelId?: string;
    regenerate?: boolean;
    voiceSettings?: {
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
    };
  }): Promise<{
    ok: boolean;
    artifact: { id: string; filename: string; mime: string; downloadUrl: string; sizeBytes: number; kind?: string };
    content: string;
    state: any;
    assistantMessageId: string | null;
    chatId: string | null;
  }> {
    return this.request('/ai/generate-speech', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generateMusicMessage(data: {
    text: string;
    chatId?: string | null;
    durationSeconds?: number;
    style?: string;
    mood?: string;
    effect?: string;
    influence?: number;
    model?: string;
  }): Promise<{
    ok: boolean;
    provider?: string;
    model?: string;
    artifact: { id: string; filename: string; mime: string; downloadUrl: string; sizeBytes: number; kind?: string; model?: string };
    content: string;
    state: any;
    assistantMessageId: string | null;
    chatId: string | null;
  }> {
    return this.request('/ai/generate-music', {
      method: 'POST',
      body: JSON.stringify(data),
      // Music generation runs synchronously inside the request and can take a
      // while for long (3–4 min) tracks. Give it a generous ceiling and never
      // retry — a retry would double-bill ElevenLabs credits.
      timeoutMs: 300000,
      maxRetries: 0,
    });
  }

  async speechToText(audioFile: File, model_id?: string) {
    const formData = new FormData();
    formData.append('audio', audioFile);
    if (model_id) {
      formData.append('model_id', model_id);
    }

    return this.request('/elevenlabs/speech-to-text', {
      method: 'POST',
      body: formData,
    });
  }

  async transcribeGrokVoice(audioFile: File, data: { model?: string; language?: string } = {}): Promise<GrokVoiceTranscriptEnvelope> {
    const formData = new FormData();
    formData.append('audio', audioFile);
    if (data.model) formData.append('model', data.model);
    if (data.language) formData.append('language', data.language);

    return this.request('/voice/grok/transcribe', {
      method: 'POST',
      body: formData,
    });
  }

  async createGrokVoiceSession(data: {
    chatId?: string | null
    mode?: 'advanced_voice' | 'dictation' | 'hands_free'
  } = {}): Promise<GrokVoiceSessionEnvelope> {
    return this.request('/voice/grok/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async sendGrokVoiceTurn(
    sessionId: string,
    data: {
      text: string
      chatId?: string | null
      source?: 'stt' | 'typed' | 'system'
      respond?: boolean
    },
  ): Promise<GrokVoiceTurnEnvelope> {
    return this.request(`/voice/grok/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 60000,
    });
  }

  async stopGrokVoiceSession(sessionId: string): Promise<GrokVoiceSessionEnvelope> {
    return this.request(`/voice/grok/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
    });
  }



  async getVoiceSettings(voiceId: string) {
    return this.request(`/elevenlabs/voices/${voiceId}/settings`);
  }

  async getElevenLabsSubscription() {
    return this.request('/elevenlabs/user/subscription');
  }

  async getAudioFile(filename: string) {
    const response = await this.request(`/elevenlabs/audio/${filename}`);
    return response.blob();
  }
  // ...existing code...

  // ElevenLabs Music Generation
  async generateMusic(data: {
    text: string;
    duration?: number;
    prompt_influence?: number;
    normalize_output?: boolean;
  }) {
    return this.request('/elevenlabs/generate-music', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getMusicStyles() {
    return this.request('/elevenlabs/music-styles');
  }


  // // Web Search endpoints
  // async webSearch(data: { query: string; chatId?: string }) {
  //   return this.request('/search/web', {
  //     method: 'POST',
  //     body: JSON.stringify(data),
  //   });
  // }
  // Replace the webSearch method with this streaming version:

  // Web Search endpoints
  async webSearchStream(
    data: { query: string; chatId?: string; model?: string; provider?: string },
    onData: (chunk: any) => void,
    onComplete: (data: any) => void,
    onError: (error: Error) => void
  ) {
    const url = `${this.baseURL}/search/web`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      for await (const jsonData of streamSseJson<any>(response.body)) {
        onData(jsonData);
      }
    } catch (error: any) {
      console.error('Web search stream failed:', error);
      onError(error);
    }
  }
  // Update the video generation method
  // Update the generateVideo method:

  async generateVideo(data: {
    prompt: string;
    aspect_ratio?: 'auto' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
    resolution?: '480p' | '720p';
    duration?: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
    audio?: boolean;
    negative_prompt?: string;
    chatId?: string;
    files?: string[];
    image_url?: string;
    image_urls?: string[];
    model?: string;
  }, opts?: { signal?: AbortSignal }) {
    return this.request('/ai/generate-video', {
      method: 'POST',
      body: JSON.stringify(data),
      signal: opts?.signal,
      timeoutMs: 120000, // video submit + first-frame can exceed 30s
    });
  }
  // async getVideoStatus(operationId: string) {
  //   return this.request(`/video/status/${operationId}`);
  // }

  // ...existing code...
  async getVideoStatus(operationId: string) {
    // Was: return this.request(`/video/status/${operationId}`);
    return this.request(`/ai/video-status/${operationId}`);
  }
  async cancelVideoGeneration(operationId: string) {
    return this.request(`/ai/video-cancel/${encodeURIComponent(operationId)}`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 15000,
      maxRetries: 0,
      suppressFailureLog: true,
    });
  }
  async getVideoHistory(params?: {
    page?: number;
    limit?: number;
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/video/history${query ? `?${query}` : ''}`);
  }

  getVideoFile(filename: string) {
    return `${this.apiBaseURL}/video/watch/${filename}`;
  }

  async downloadVideo(filename: string) {
    const url = `${this.apiBaseURL}/video/download/${filename}`;
    const response = await fetch(url, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });
    if (!response.ok) {
      throw new Error('Failed to download video');
    }
    return response.blob();
  }
  async getAnonQuota() {
    localStorage.setItem('currentChatId', "")

    const res = await fetch(`${this.apiBaseURL}/ai/anon-quota`, {
      method: 'GET',
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error('Failed to fetch anonymous quota');
    }
    return res.json();
  }

  async getMediaLibrary(params?: { page?: number; limit?: number; type?: 'image' | 'video' | 'audio' | 'music' | 'webapp' | 'mobileapp' }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/library/media-library${query ? `?${query}` : ''}`);
  }

  // Fetch an agent-artifact (audio/music/web-app) as a Blob with the bearer
  // token attached. Plain <audio>/<iframe> tags can't send the Authorization
  // header and the artifact route is owner-scoped, so the library loads these
  // files here and renders them via object URLs. `downloadUrl` arrives as
  // "/api/agent/artifact/<id>?name=…"; the client baseURL already carries the
  // /api prefix, so strip it to avoid requesting /api/api/….
  async getMediaArtifactBlob(downloadUrl: string): Promise<Blob> {
    const path = downloadUrl.replace(/^\/api(?=\/)/, '');
    const res = await fetch(`${this.baseURL}${path}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`No se pudo cargar el archivo (${res.status})`);
    return res.blob();
  }

  async generateChart(data: { prompt: string; displayPrompt?: string; chatId?: string, fileId?: string }) {
    return this.request('/ai/generate-chart', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generateFigmaFlowchart(data: { prompt: string; displayPrompt?: string; chatId?: string; conversationHistory?: any[] }) {
    return this.request('/figma/generate_flowchart', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generatePlan(data: { prompt: string; chatId?: string; model?: string }) {
    return this.request('/plan/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // SSE streamer for the plan generator. The server emits progress events
  // so the chat can render live feedback instead of a silent spinner.
  // Events: { type: 'stage'|'tokens'|'final'|'error', ... }
  async solveMathStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/math/solve', data, onEvent, opts);
  }

  async generateVizStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/viz/generate', data, onEvent, opts);
  }

  async generateDocStream(
    data: {
      prompt: string;
      displayPrompt?: string;
      chatId?: string;
      model?: string;
      format?: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'svg' | 'csv' | 'html' | 'md' | 'markdown';
      template?: string;
      complexity?: 'simple' | 'standard' | 'high' | 'stress';
      files?: string[];
    },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/doc/generate', data, onEvent, opts);
  }

  async generateArtifactStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/artifact/generate', data, onEvent, opts);
  }

  async generatePlanStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/plan/generate', data, onEvent, opts);
  }

  // Shared SSE reader for POST-body → event-stream endpoints. Extracted
  // so the plan + math streamers share one implementation and any new
  // streaming route (compute, agent-step, etc.) can reuse it.
  async _sseStream(
    path: string,
    data: any,
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    let retriedAfterRefresh = false;
    let res: Response;

    while (true) {
      const token = this._getAccessTokenSnapshot();
      res = await fetch(`${this.baseURL}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
        signal: opts.signal,
      });

      if (res.ok) break;

      if (res.status === 401 && !retriedAfterRefresh && !isCredentialHandshake(path, 'POST')) {
        retriedAfterRefresh = true;
        const refreshed = await this._tryRefresh();
        if (refreshed) continue;
      }

      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }

    if (!res.body) throw new Error('Stream body missing');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = raw
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6))
          .join('\n');
        if (!payload) continue;
        try { onEvent(JSON.parse(payload)); } catch {}
      }
    }
  }

  // Web Development Streaming endpoint
  async generateWebDevStream(
    data: {
      prompt: string;
      displayPrompt?: string;
      chatId: string;
      provider?: string;
      model?: string;
      files?: string[];
      streamId: string;
    },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
  ) {
    const url = `${this.baseURL}/ai/generate-webdev`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      for await (const event of streamSseJson<any>(response.body, {
        stopOnDoneMessage: true,
        onMalformedMessage: (_raw, parseError) => {
          console.warn('Failed to parse SSE data:', parseError);
        },
      })) {
        if (event.content) {
          onData(event.content);
        }
        if (event.error) {
          onError(new Error(event.error));
          return;
        }
      }

      onClose();
    } catch (error) {
      console.error('WebDev streaming error:', error);
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Vector PPT Generation endpoint (Gamma-style, pure vector graphics)
  async generateVectorPPT(data: {
    prompt: string;
    displayPrompt?: string;
    chatId: string;
    provider?: string;
    model?: string;
    files?: string[];
  }) {
    return this.request('/ai/generate-vector-ppt', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PPT Generation endpoint (WITH IMAGES - OLD VERSION)
  async generatePPT(data: {
    prompt: string;
    displayPrompt?: string;
    chatId: string;
    provider?: string;
    model?: string;
  }) {
    return this.request('/ai/generate-ppt', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Download PPT file
  async downloadPPT(filename: string) {
    const url = `${this.apiBaseURL}/uploads/presentations/${filename}`;
    const response = await fetch(url, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      throw new Error('Failed to download presentation');
    }

    return response.blob();
  }

  // Gmail endpoints
  async getGmailStatus() {
    return this.request('/gmail/status');
  }

  async connectGmail() {
    return this.request('/gmail/connect');
  }

  async sendGmailEmail(data: {
    to: string;
    subject: string;
    message: string;
    cc?: string;
    bcc?: string;
  }) {
    return this.request('/gmail/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGmailEmails(params?: {
    maxResults?: number;
    query?: string;
    labelIds?: string[];
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/gmail/emails${query ? `?${query}` : ''}`);
  }

  async deleteGmailEmail(emailId: string) {
    return this.request(`/gmail/email/${emailId}`, {
      method: 'DELETE',
    });
  }

  // Prefer using replyGmail below which matches backend contract

  async searchGmailEmails(query: string, limit: number = 10) {
    const q = encodeURIComponent(query);
    return this.request(`/gmail/search?q=${q}&limit=${limit}`, {
      method: 'GET'
    });
  }

  // Mark email read/unread
  async markGmailEmail(messageId: string, read: boolean) {
    return this.request(`/gmail/email/${messageId}/mark`, {
      method: 'PATCH',
      body: JSON.stringify({ read })
    });
  }

  // Reply to an email (threaded)
  async replyGmail(data: { threadId: string; messageId: string; body: string }) {
    return this.request('/gmail/reply', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Star/unstar email
  async starGmailEmail(messageId: string, starred: boolean) {
    return this.request(`/gmail/email/${messageId}/star`, {
      method: 'PATCH',
      body: JSON.stringify({ starred })
    });
  }

  // Archive/unarchive email
  async archiveGmailEmail(messageId: string, archive: boolean) {
    return this.request(`/gmail/email/${messageId}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archive })
    });
  }

  // Gmail chat command endpoint
  async processGmailCommand(data: { command: string; chatId: string }) {
    return this.request('/gmail/chat-command', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Google Services (Calendar & Drive) endpoints
  async getGoogleServicesStatus() {
    return this.request('/auth/google-services/status');
  }

  async connectGoogleServices() {
    return this.request('/auth/google-services');
  }

  async disconnectGoogleServices() {
    return this.request('/auth/google-services/disconnect', {
      method: 'POST',
    });
  }

  async generateGoogleServicesResponse(data: { prompt: string; chatId?: string; model: string }) {
    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const payload = {
      ...data,
      timeZone: userTimeZone // <-- Har request ke sath timezone bhejein
    };

    return this.request('/ai/generate-google-services', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Spotify endpoints
  async getSpotifyAuthUrl() {
    return this.request('/spotify/connect');
  }

  async processSpotifyCommand(data: { prompt: string; chatId?: string }) {
    return this.request('/spotify/command', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSpotifyStatus() {
    return this.request('/spotify/status');
  }

  async startComputerUseChatIntegration(data: { message: string; chatId: string; sessionId?: string; mode?: 'browser' | 'chrome' | 'computer' }) {
    return this.request('/computer-use/chat-integration', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Professional document cycle (Ciclo profesional de agentes para documentos)
  async classifyDocumentCycle(data: {
    topic: string;
    documentType?: string;
    field?: string;
  }) {
    return this.request('/agent/document-cycle/classify', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Thesis Generation endpoints
  async generateThesis(data: { topics: string[]; chatId?: string }) {
    return this.request('/thesis/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getThesisStatus(sessionId: string) {
    return this.request(`/thesis/status/${sessionId}`);
  }

  async updateWordContent(chatId: string, content: string) {
    return this.request(`/chats/${chatId}/word-content`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  }

  async downloadThesis(sessionId: string) {
    const url = `${this.baseURL}/thesis/download/${sessionId}`;
    const headers = new Headers();
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to download thesis');
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `thesis-${sessionId}.docx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(downloadUrl);
    document.body.removeChild(a);
  }

  // ── Contabilidad (módulo contable PCGE) ────────────────────────────────────
  async getAccountingTrialBalance(params: { from?: string; to?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return this.request(`/accounting/trial-balance${qs ? `?${qs}` : ''}`);
  }
  async listAccountingJournalEntries(params: { from?: string; to?: string; take?: number } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    return this.request(`/accounting/journal-entries${qs ? `?${qs}` : ''}`);
  }
  async listAccountingInvoices(params: { docType?: string; status?: string; take?: number } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    return this.request(`/accounting/invoices${qs ? `?${qs}` : ''}`);
  }
  async getAccountingIncomeStatement(params: { from?: string; to?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return this.request(`/accounting/reports/income-statement${qs ? `?${qs}` : ''}`);
  }
  async getAccountingBalanceSheet(params: { asOf?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return this.request(`/accounting/reports/balance-sheet${qs ? `?${qs}` : ''}`);
  }
  async getAccountingCashFlow(params: { from?: string; to?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return this.request(`/accounting/reports/cash-flow${qs ? `?${qs}` : ''}`);
  }
  /** Download an accounting export (xlsx/pdf) with auth, triggering a browser save. */
  async downloadAccountingExport(path: string, filename: string) {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await fetch(`${this.baseURL}/accounting/export/${path}`, { method: 'GET', headers, credentials: 'include' });
    if (!response.ok) throw new Error('No se pudo generar la exportación');
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(downloadUrl);
    document.body.removeChild(a);
  }
}

export const apiClient = new ApiClient(API_BASE_URL);

// -----------------------------------------------------------------------------
// SWR-style cache for static-ish data (user profile, model list, plan info).
//
// Why parallel to existing methods, not a replacement:
//   - Existing call sites assume each call returns fresh data; reordering
//     reads to a cached promise could surface stale data in flows that
//     depend on side effects (e.g. just-saved profile changes).
//   - `apiClient.swr.*` is an opt-in surface for new code that wants
//     stale-while-revalidate semantics without breaking anything else.
//
// Semantics:
//   - Returns the cached value immediately if present (fresh or stale).
//   - In parallel kicks off a background revalidate when stale or on
//     window focus.
//   - Two-tier: in-memory (per-tab, instant) + sessionStorage (per-tab,
//     survives navigation but not full window close — matches OWASP
//     guidance for not persisting auth-bearing state to localStorage).
// -----------------------------------------------------------------------------

type SWREntry<T> = { value: T; storedAt: number };
type SWRFetcher<T> = () => Promise<T>;

const SWR_FRESH_MS = 30_000;    // value is fresh for 30s
const SWR_STALE_MS = 5 * 60_000; // stale but usable up to 5m
const SWR_NAMESPACE = 'sira:swr:v1';

class SWRCache {
  private mem = new Map<string, SWREntry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private listeners: Set<(key: string) => void> = new Set();
  private focusBound = false;

  private storageKey(key: string): string {
    return `${SWR_NAMESPACE}:${key}`;
  }

  private readSession<T>(key: string): SWREntry<T> | null {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    try {
      const raw = window.sessionStorage.getItem(this.storageKey(key));
      if (!raw) return null;
      return JSON.parse(raw) as SWREntry<T>;
    } catch {
      return null;
    }
  }

  private writeSession<T>(key: string, entry: SWREntry<T>): void {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      window.sessionStorage.setItem(this.storageKey(key), JSON.stringify(entry));
    } catch {
      // Quota / private mode — silently degrade to in-memory only.
    }
  }

  private bindFocusOnce(): void {
    if (this.focusBound || typeof window === 'undefined') return;
    this.focusBound = true;
    window.addEventListener('focus', () => {
      // Revalidate every entry that's older than the fresh threshold.
      const now = Date.now();
      this.mem.forEach((entry, key) => {
        if (now - entry.storedAt > SWR_FRESH_MS) {
          this.listeners.forEach((l) => l(key));
        }
      });
    });
  }

  get<T>(key: string): SWREntry<T> | null {
    if (this.mem.has(key)) return this.mem.get(key) as SWREntry<T>;
    const fromSession = this.readSession<T>(key);
    if (fromSession) this.mem.set(key, fromSession);
    return fromSession;
  }

  set<T>(key: string, value: T): void {
    const entry: SWREntry<T> = { value, storedAt: Date.now() };
    this.mem.set(key, entry);
    this.writeSession(key, entry);
  }

  invalidate(key: string): void {
    this.mem.delete(key);
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try { window.sessionStorage.removeItem(this.storageKey(key)); } catch { /* noop */ }
    }
  }

  async fetch<T>(key: string, fetcher: SWRFetcher<T>): Promise<T> {
    this.bindFocusOnce();
    const cached = this.get<T>(key);
    const now = Date.now();
    if (cached && now - cached.storedAt < SWR_FRESH_MS) {
      // Fresh — return immediately, no revalidation needed.
      return cached.value;
    }
    if (cached && now - cached.storedAt < SWR_STALE_MS) {
      // Stale-but-usable: return cached value AND kick off background revalidate.
      if (!this.inflight.has(key)) {
        const p = fetcher()
          .then((v) => { this.set(key, v); return v; })
          .catch(() => cached.value)
          .finally(() => { this.inflight.delete(key); });
        this.inflight.set(key, p);
      }
      return cached.value;
    }
    // Cold / fully expired: dedupe concurrent callers on the inflight promise.
    let inflight = this.inflight.get(key) as Promise<T> | undefined;
    if (!inflight) {
      inflight = fetcher()
        .then((v) => { this.set(key, v); return v; })
        .finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, inflight);
    }
    return inflight;
  }
}

const swrCache = new SWRCache();

// Augment apiClient with an `swr` surface. Add new entries here as the
// caller list grows — keep existing methods untouched.
type SWRSurface = {
  getModels: () => Promise<unknown>;
  invalidate: (key: string) => void;
  _cache: SWRCache;
};
(apiClient as unknown as { swr: SWRSurface }).swr = {
  getModels: () => swrCache.fetch('models', () => apiClient.getModels()),
  invalidate: (key: string) => swrCache.invalidate(key),
  _cache: swrCache,
};

export { swrCache };
export default apiClient;
