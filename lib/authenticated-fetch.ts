import { getNormalizedApiBaseUrl } from "./api-base-url"
import { sanitizeFetchHeaders } from "./fetch-sanitize"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const CSRF_COOKIE_NAME = "csrf_token"
const CSRF_PATH = "/auth/csrf-token"

export type AuthenticatedFetchFactoryOptions = {
  apiBaseUrl?: string
  fetchImpl?: typeof fetch
  getBearerToken?: () => string | null | Promise<string | null>
  readCsrfCookie?: () => string | null
}

export type AuthenticatedRequestOptions = {
  /**
   * `undefined` uses the factory/localStorage token. `null` explicitly forces
   * cookie-only auth (needed by login/register and stale-bearer refresh).
   */
  bearerToken?: string | null
  /** Disable only when a caller has already started consuming a response. */
  retryCsrfInvalid?: boolean
  /**
   * The transport refetches a trusted GET once after a 502/503/504 or a 429
   * (bounded wait, Retry-After honoured). A caller with its own retry policy
   * (ApiClient) passes `false` so a rate-limited server is not hit twice per
   * attempt.
   */
  retryTransient?: boolean
  /** Keep token-only clients in sync when browser storage is unavailable. */
  onTokenRefreshed?: (token: string) => void
}

export type AuthenticatedFetch = {
  (
    input: RequestInfo | URL,
    init?: RequestInit,
    requestOptions?: AuthenticatedRequestOptions,
  ): Promise<Response>
  prepare(
    input: RequestInfo | URL,
    init?: RequestInit,
    requestOptions?: AuthenticatedRequestOptions,
  ): Promise<RequestInit>
  csrfManager: CsrfTokenManager
  sessionGuard: SessionGuard
}

export const SESSION_EXPIRED_EVENT = "siragpt:session-expired"
/**
 * After `/auth/refresh` answers 401 or a non-CSRF 403 the session is over: the
 * refresh cookie is gone or revoked and no retry mints a token until someone
 * logs in again. Production 2026-10-07: a logged-out tab kept its pollers
 * (credits badge, computer activity, login-handoff) and every 401 fired a
 * fresh refresh — about 20 failed requests per minute for 2 h 20 m from one
 * user. The guard remembers the definitive failure and the 401 branch stops
 * refreshing until the bearer changes, a credential handshake succeeds, a
 * login clears it or the cooldown expires (Chrome wakes a background tab
 * once a minute, so the cooldown is well above one minute).
 */
export const AUTH_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

export type SessionGuard = {
  /** True while a definitive refresh failure is remembered for this bearer. */
  isBlocked(bearer?: string | null): boolean
  /** Remember a definitive refresh failure; notifies the app once per block. */
  block(bearer?: string | null): void
  clear(): void
}

export type AuthSessionSnapshot = { epoch: number; storage: string | null }
let authSessionEpoch = 0

/** Identity changes invalidate pending work, including logout followed by login. */
export function invalidateAuthSession(): void { authSessionEpoch += 1 }

export function captureAuthSession(): AuthSessionSnapshot {
  let storage: string | null = null
  try {
    if (typeof window !== "undefined") storage = JSON.stringify([
      window.localStorage.getItem("auth-token"),
      window.localStorage.getItem("siragpt:refresh-family"),
      window.localStorage.getItem("siragpt:refresh-version"),
    ])
  } catch { /* unavailable storage: epoch still protects this tab */ }
  return { epoch: authSessionEpoch, storage }
}

function sameAuthSession(a: AuthSessionSnapshot, b: AuthSessionSnapshot): boolean {
  return a.epoch === b.epoch && a.storage === b.storage
}

export function isAuthSessionCurrent(snapshot: AuthSessionSnapshot): boolean {
  return sameAuthSession(snapshot, captureAuthSession())
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", event => {
    if (event.key === null || ["auth-token", "siragpt:refresh-family", "siragpt:refresh-version"].includes(event.key)) {
      invalidateAuthSession()
    }
  })
}

type RefreshMarker = { session: AuthSessionSnapshot; bearer: string | null }
type RefreshOutcome = { ok: boolean; definitive: boolean; token?: string | null; marker?: RefreshMarker; csrfResponse?: Response }

type CsrfTokenManagerOptions = {
  apiBaseUrl: string
  fetchImpl: typeof fetch
  readCsrfCookie: () => string | null
}

function defaultReadCsrfCookie(): string | null {
  if (typeof document === "undefined") return null
  const match = (document.cookie || "").match(
    new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`),
  )
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1] || null
  }
}

function defaultBearerToken(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem("auth-token")
  } catch {
    return null
  }
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function runtimeBaseUrl(apiBaseUrl: string): string {
  if (typeof window !== "undefined" && window.location?.href) {
    return window.location.href
  }
  try {
    return new URL(apiBaseUrl, "http://localhost").toString()
  } catch {
    return "http://localhost/"
  }
}

function toUrl(input: RequestInfo | URL, base: string): URL | null {
  try {
    if (typeof input === "string") return new URL(input, base)
    if (typeof URL !== "undefined" && input instanceof URL) return new URL(input.toString())
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url, base)
    return null
  } catch {
    return null
  }
}

function isPathWithin(pathname: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/"
  if (normalizedRoot === "/") return true
  return pathname === normalizedRoot || pathname.startsWith(`${normalizedRoot}/`)
}

export function isTrustedSiraApiUrl(
  input: RequestInfo | URL,
  apiBaseUrl = getNormalizedApiBaseUrl(),
): boolean {
  const runtimeBase = runtimeBaseUrl(apiBaseUrl)
  const candidate = toUrl(input, runtimeBase)
  const api = toUrl(apiBaseUrl, runtimeBase)
  if (!candidate || !api) return false

  if (candidate.origin === api.origin && isPathWithin(candidate.pathname, api.pathname)) {
    return true
  }

  // Same-origin Next routes under /api are also Sira API transports (the
  // browser may use a Next rewrite while NEXT_PUBLIC_API_URL points directly
  // at Express). Never trust another path merely because its origin matches.
  if (typeof window !== "undefined") {
    const browserOrigin = window.location?.origin
    if (browserOrigin && candidate.origin === browserOrigin && isPathWithin(candidate.pathname, "/api")) {
      return true
    }
  }

  return false
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method).toUpperCase()
  if (typeof Request !== "undefined" && input instanceof Request) {
    return String(input.method || "GET").toUpperCase()
  }
  return "GET"
}

function mergeRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers()
  if (typeof Request !== "undefined" && input instanceof Request) {
    new Headers(sanitizeFetchHeaders(input.headers)).forEach((value, name) => {
      headers.set(name, value)
    })
  }
  new Headers(sanitizeFetchHeaders(init?.headers)).forEach((value, name) => {
    headers.set(name, value)
  })
  return headers
}

export async function isCsrfInvalid(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  try {
    const body = await response.clone().json() as { error?: unknown; code?: unknown }
    return body?.error === "csrf_invalid" || body?.code === "csrf_invalid"
  } catch {
    return false
  }
}

export class CsrfTokenManager {
  private cachedToken: string | null = null
  private inFlight: Promise<string | null> | null = null
  private epoch = 0
  private observedCookie: string | null = null
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly readCsrfCookie: () => string | null

  constructor(options: CsrfTokenManagerOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl
    this.readCsrfCookie = options.readCsrfCookie
    this.observedCookie = normalizeToken(this.readCsrfCookie())
  }

  clear(): void {
    this.epoch += 1
    this.cachedToken = null
    this.inFlight = null
  }

  /** Changes only with CSRF credentials or an explicit cache reset, not time. */
  get revision(): number {
    const cookie = normalizeToken(this.readCsrfCookie())
    if (cookie !== this.observedCookie) {
      this.observedCookie = cookie
      this.clear()
    }
    return this.epoch
  }

  async getToken(forceRefresh = false): Promise<string | null> {
    if (typeof window === "undefined") return null
    void this.revision
    if (forceRefresh) this.clear()

    if (this.cachedToken) return this.cachedToken
    if (!forceRefresh) {
      const cookieToken = normalizeToken(this.readCsrfCookie())
      if (cookieToken) return cookieToken
    }
    if (this.inFlight) return this.inFlight

    const requestEpoch = this.epoch
    const requestCookie = this.observedCookie
    const request = (async () => {
      try {
        const response = await this.fetchImpl(`${this.apiBaseUrl}${CSRF_PATH}`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        })
        if (!response.ok) return null
        const body = await response.json().catch(() => null) as { csrfToken?: unknown } | null
        const cookie = normalizeToken(this.readCsrfCookie())
        // The cookie may have rotated in this response or in another tab.
        // A late response cannot assign its old body to newer credentials.
        if (this.epoch !== requestEpoch || cookie !== requestCookie) {
          void this.revision
          return this.cachedToken || cookie
        }
        const token = normalizeToken(body?.csrfToken) || cookie
        if (token) {
          if (this.cachedToken !== token) this.epoch += 1
          this.cachedToken = token
        }
        return token
      } catch {
        return null
      }
    })()

    this.inFlight = request
    try {
      return await request
    } finally {
      if (this.inFlight === request) this.inFlight = null
    }
  }
}

function defaultFetch(): typeof fetch {
  // Resolve the global at dispatch time. Besides making the transport work
  // with test/runtime fetch instrumentation installed after module import,
  // this avoids retaining a stale implementation after a polyfill swap.
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch
}


function isAuthRefreshPath(input: RequestInfo | URL, apiBaseUrl: string): boolean {
  const url = toUrl(input, runtimeBaseUrl(apiBaseUrl))
  if (!url) return false
  return /\/auth\/refresh\/?$/.test(url.pathname)
}

// A 2xx on one of these proves the session is alive again (cookie login,
// OAuth callback, a minted token): the guard lets the next 401 refresh.
const SESSION_HANDSHAKE_PATH_RE = /\/auth\/(?:me|login|register|refresh)\/?$/

function isSessionHandshakePath(input: RequestInfo | URL, apiBaseUrl: string): boolean {
  const url = toUrl(input, runtimeBaseUrl(apiBaseUrl))
  if (!url) return false
  return SESSION_HANDSHAKE_PATH_RE.test(url.pathname)
}

function bearerFromHeaders(headers: HeadersInit | undefined): string | null {
  const value = new Headers(headers).get("Authorization") || ""
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? normalizeToken(match[1]) : null
}

function createSessionGuard(
  getBearer: () => string | null,
  cooldownMs: number = AUTH_REFRESH_FAILURE_COOLDOWN_MS,
  now: () => number = () => Date.now(),
): SessionGuard {
  let armed = false
  let until = 0
  let bearerAtFailure: string | null = null
  const resolveBearer = (bearer: string | null | undefined): string | null => {
    if (bearer !== undefined) return normalizeToken(bearer)
    try {
      return normalizeToken(getBearer())
    } catch {
      return null
    }
  }
  return {
    isBlocked(bearer) {
      if (!armed) return false
      if (now() >= until || resolveBearer(bearer) !== bearerAtFailure) {
        armed = false
        return false
      }
      return true
    },
    block(bearer) {
      const wasArmed = armed
      armed = true
      until = now() + cooldownMs
      bearerAtFailure = resolveBearer(bearer)
      if (!wasArmed && typeof window !== "undefined") {
        try {
          window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
        } catch {
          /* noop */
        }
      }
    },
    clear() {
      armed = false
      until = 0
      bearerAtFailure = null
    },
  }
}

/** Longest the transport itself waits before its single transient refetch. */
export const TRANSIENT_RETRY_MAX_WAIT_MS = 2_000

/**
 * RFC 9110 `Retry-After` → milliseconds from now, or null when the header is
 * absent or unparseable. Both forms: delta-seconds (`30`) and HTTP-date
 * (`Fri, 31 Dec 2030 23:59:59 GMT`). Negative deltas / past dates clamp to 0.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: () => number = Date.now): number | null {
  if (typeof headerValue !== "string") return null
  const trimmed = headerValue.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : null
  }
  const epoch = Date.parse(trimmed)
  if (Number.isNaN(epoch)) return null
  return Math.max(0, epoch - now())
}

function transientRetryWaitMs(retryAfter: string | null, fallbackMs: number): number {
  const parsed = parseRetryAfterMs(retryAfter)
  if (parsed === null || parsed <= 0) return fallbackMs
  return Math.min(TRANSIENT_RETRY_MAX_WAIT_MS, parsed)
}

export function createAuthenticatedFetch(
  options: AuthenticatedFetchFactoryOptions = {},
): AuthenticatedFetch {
  const apiBaseUrl = (options.apiBaseUrl || getNormalizedApiBaseUrl()).replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl || defaultFetch()
  const getBearerToken = options.getBearerToken || defaultBearerToken
  const csrfManager = new CsrfTokenManager({
    apiBaseUrl,
    fetchImpl,
    readCsrfCookie: options.readCsrfCookie || defaultReadCsrfCookie,
  })
  const sessionGuard = createSessionGuard(() => {
    const token = getBearerToken()
    return typeof token === "string" ? token : null
  })

  const readMarker = async (): Promise<RefreshMarker> => {
    const session = captureAuthSession()
    const bearer = normalizeToken(await getBearerToken())
    return { session, bearer }
  }
  const sameMarker = (a: RefreshMarker, b: RefreshMarker) =>
    sameAuthSession(a.session, b.session) && a.bearer === b.bearer
  const markerCurrent = async (marker: RefreshMarker, rotatedToken?: string | null) => {
    const current = await readMarker()
    return sameAuthSession(marker.session, current.session)
      && (marker.bearer === current.bearer || Boolean(rotatedToken && current.bearer === rotatedToken))
      && isAuthSessionCurrent(current.session)
  }
  let refreshFlight: { before: RefreshMarker; promise: Promise<RefreshOutcome> } | null = null
  let lastRefresh: { before: RefreshMarker; result: RefreshOutcome } | null = null
  let csrfFailure: { marker: RefreshMarker; revision: number; response: Response } | null = null

  const currentCsrfFailure = (marker: RefreshMarker): Response | null => {
    if (!csrfFailure) return null
    if (!sameMarker(csrfFailure.marker, marker) || csrfFailure.revision !== csrfManager.revision) {
      csrfFailure = null
      return null
    }
    return csrfFailure.response.clone()
  }
  const rememberCsrfFailure = async (marker: RefreshMarker, revision: number, response: Response) => {
    // Keep the real cause for pollers, without declaring the session expired.
    // A changed identity, cookie or explicit cache reset permits recovery.
    if (await markerCurrent(marker) && revision === csrfManager.revision) {
      csrfFailure = { marker, revision, response: response.clone() }
    }
  }

  const singleFlightRefresh = async (before: RefreshMarker): Promise<RefreshOutcome> => {
    // A delayed 401 from a concurrent request may arrive after our refresh
    // finished. Reuse only that same session's still-current rotation.
    if (lastRefresh && sameMarker(lastRefresh.before, before)
      && lastRefresh.result.marker && await markerCurrent(lastRefresh.result.marker, lastRefresh.result.token)) return lastRefresh.result
    if (refreshFlight && sameMarker(refreshFlight.before, before)) return refreshFlight.promise
    if (!await markerCurrent(before)) return { ok: false, definitive: false }
    if (refreshFlight && sameMarker(refreshFlight.before, before)) return refreshFlight.promise
    const csrfResponse = currentCsrfFailure(before)
    if (csrfResponse) return { ok: false, definitive: false, csrfResponse }
    const flight = { before, promise: Promise.resolve<RefreshOutcome>({ ok: false, definitive: false }) }
    flight.promise = (async (): Promise<RefreshOutcome> => {
      try {
        const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" })
        try {
          const family = window.localStorage.getItem("siragpt:refresh-family")
          const version = window.localStorage.getItem("siragpt:refresh-version")
          if (family) headers.set("x-refresh-family", family)
          if (version) headers.set("x-refresh-version", version)
        } catch { /* storage unavailable */ }
        // Refresh uses the cookie session, so it needs the same CSRF boundary
        // as other cookie-only mutations. Token preparation may outlive logout.
        const csrf = await csrfManager.getToken()
        if (!await markerCurrent(before)) return { ok: false, definitive: false }
        if (csrf) headers.set("X-CSRF-Token", csrf)
        let csrfRevision = csrfManager.revision
        let res = await fetchImpl(apiBaseUrl + "/auth/refresh", { method: "POST", credentials: "include", headers })
        if (!await markerCurrent(before)) return { ok: false, definitive: false }
        if (await isCsrfInvalid(res)) {
          const fresh = await csrfManager.getToken(true)
          if (!await markerCurrent(before)) return { ok: false, definitive: false }
          csrfRevision = csrfManager.revision
          if (!fresh) {
            await rememberCsrfFailure(before, csrfRevision, res)
            return { ok: false, definitive: false, csrfResponse: res }
          }
          headers.set("X-CSRF-Token", fresh)
          res = await fetchImpl(apiBaseUrl + "/auth/refresh", { method: "POST", credentials: "include", headers })
          if (!await markerCurrent(before)) return { ok: false, definitive: false }
        }
        // A CSRF rejection does not prove that the authenticated session expired.
        if (await isCsrfInvalid(res)) {
          await rememberCsrfFailure(before, csrfRevision, res)
          return { ok: false, definitive: false, csrfResponse: res }
        }
        if (!res.ok) return {
          ok: false,
          definitive: res.status === 401 || res.status === 403,
        }
        const data = await res.json().catch(() => null) as { token?: unknown } | null
        const token = normalizeToken(data?.token)
        if (!await markerCurrent(before)) return { ok: false, definitive: false }
        if (token && typeof window !== "undefined") {
          try { window.localStorage.setItem("auth-token", token) } catch { /* memory-only replay */ }
        }
        const result: RefreshOutcome = { ok: true, definitive: false, token, marker: await readMarker() }
        lastRefresh = { before, result }
        return result
      } catch { return { ok: false, definitive: false } }
    })()
    refreshFlight = flight
    try { return await flight.promise }
    finally { if (refreshFlight === flight) refreshFlight = null }
  }

  const prepare = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
    requestOptions: AuthenticatedRequestOptions = {},
  ): Promise<RequestInit> => {
    const headers = mergeRequestHeaders(input, init)
    const trusted = isTrustedSiraApiUrl(input, apiBaseUrl)
    const method = resolveMethod(input, init)

    if (!trusted) {
      // A caller accidentally routing an external URL through this helper must
      // never carry Sira credentials. External/public clients should normally
      // use raw fetch, but this guard makes that mistake non-exploitable.
      headers.delete("Authorization")
      headers.delete("X-CSRF-Token")
      headers.delete("X-CSRF-Retry")
      return { ...init, headers, credentials: "omit" }
    }

    const hasExplicitBearer = Object.prototype.hasOwnProperty.call(requestOptions, "bearerToken")
    const bearer = normalizeToken(
      hasExplicitBearer
        ? requestOptions.bearerToken
        : await getBearerToken(),
    )
    if (hasExplicitBearer && requestOptions.bearerToken === null) headers.delete("Authorization")
    if (bearer && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${bearer}`)
    }

    if (
      MUTATING_METHODS.has(method)
      && !headers.has("Authorization")
      && !headers.has("X-CSRF-Token")
    ) {
      const csrf = await csrfManager.getToken()
      if (csrf) headers.set("X-CSRF-Token", csrf)
    }

    return { ...init, headers, credentials: "include" }
  }

  const authenticated = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
    requestOptions: AuthenticatedRequestOptions = {},
  ): Promise<Response> => {
    const marker = await readMarker()
    const refreshRequest = resolveMethod(input, init) === "POST"
      && isTrustedSiraApiUrl(input, apiBaseUrl) && isAuthRefreshPath(input, apiBaseUrl)
    if (refreshRequest) {
      const failure = currentCsrfFailure(marker)
      if (failure) return failure
    }
    // Retain an unconsumed template; native fetch consumes Request bodies.
    const template = typeof Request !== "undefined" && input instanceof Request ? input.clone() : input
    const dispatch = (prepared: RequestInit) => fetchImpl(
      typeof Request !== "undefined" && template instanceof Request ? template.clone() : template, prepared,
    )
    const prepared = await prepare(input, init, requestOptions)
    let csrfRevision = csrfManager.revision
    let response = await dispatch(prepared)
    const method = resolveMethod(input, prepared)
    const transientRetryAllowed = requestOptions.retryTransient !== false
      && method === "GET"
      && isTrustedSiraApiUrl(input, apiBaseUrl)
    if (
      transientRetryAllowed
      && (response.status === 502 || response.status === 503 || response.status === 504)
    ) {
      // A restart answers 502/504 with no hint; a 503 may say when to return.
      const waitMs = response.status === 503
        ? transientRetryWaitMs(response.headers.get("Retry-After"), 250)
        : 250
      try { await new Promise((r) => setTimeout(r, waitMs)) } catch { /* ignore */ }
      if (prepared.signal?.aborted) return response
      response = await dispatch(prepared)
    }
    if (transientRetryAllowed && response.status === 429) {
      const waitMs = transientRetryWaitMs(response.headers.get("Retry-After"), 400)
      try { await new Promise((r) => setTimeout(r, waitMs)) } catch { /* ignore */ }
      if (prepared.signal?.aborted) return response
      response = await dispatch(prepared)
    }
    const usedBearer = new Headers(prepared.headers).has("Authorization")
    let csrfRecoveryAttempted = false

    if (
      requestOptions.retryCsrfInvalid !== false
      && MUTATING_METHODS.has(method)
      && !usedBearer
      && isTrustedSiraApiUrl(input, apiBaseUrl)
      && await isCsrfInvalid(response)
    ) {
      csrfRecoveryAttempted = true
      const fresh = await csrfManager.getToken(true)
      csrfRevision = csrfManager.revision
      if (fresh) {
        const retryHeaders = new Headers(prepared.headers)
        retryHeaders.set("X-CSRF-Token", fresh)
        response = await dispatch({ ...prepared, headers: retryHeaders })
      }
    }

    if (refreshRequest && await isCsrfInvalid(response)) {
      await rememberCsrfFailure(marker, csrfRevision, response)
    }
    if (response.ok && isSessionHandshakePath(input, apiBaseUrl) && await markerCurrent(marker)) {
      sessionGuard.clear()
      csrfFailure = null
    }
    if (csrfRecoveryAttempted) return response

    if (
      response.status === 401
      && isTrustedSiraApiUrl(input, apiBaseUrl)
      && !isAuthRefreshPath(input, apiBaseUrl)
    ) {
      // The request itself is always sent (its 401 is the caller's answer);
      // only the automatic refresh is withheld while the session is known
      // to be over for the bearer this request carried.
      const sentBearer = bearerFromHeaders(prepared.headers)
      if (sessionGuard.isBlocked(sentBearer)) return response
      const refreshed = await singleFlightRefresh(marker)
      if (refreshed.ok && refreshed.marker && await markerCurrent(refreshed.marker, refreshed.token)) {
        if (prepared.signal?.aborted) return response
        const retryHeaders = new Headers(prepared.headers)
        retryHeaders.delete("Authorization")
        const bearerToken = requestOptions.bearerToken === null ? null : refreshed.token ?? null
        if (bearerToken) retryHeaders.set("Authorization", `Bearer ${bearerToken}`)
        const retried = await prepare(input, { ...prepared, headers: retryHeaders }, { ...requestOptions, bearerToken })
        if (prepared.signal?.aborted || !await markerCurrent(refreshed.marker, refreshed.token)) return response
        if (refreshed.token) requestOptions.onTokenRefreshed?.(refreshed.token)
        if (!isAuthSessionCurrent(refreshed.marker.session)) return response
        return dispatch(retried)
      }
      if (refreshed.csrfResponse && await markerCurrent(marker)) return refreshed.csrfResponse.clone()
      if (refreshed.definitive && await markerCurrent(marker)) sessionGuard.block(sentBearer)
    }

    return response
  }

  authenticated.prepare = prepare
  authenticated.csrfManager = csrfManager
  authenticated.sessionGuard = sessionGuard
  return authenticated
}

export const authenticatedFetch = createAuthenticatedFetch()

/** True while the shared transport remembers a definitive refresh failure. */
export function isAuthRefreshBlocked(bearer?: string | null): boolean {
  return authenticatedFetch.sessionGuard.isBlocked(bearer)
}

/** Record a definitive refresh failure seen outside the transport (ApiClient). */
export function blockAuthRefresh(bearer?: string | null): void {
  authenticatedFetch.sessionGuard.block(bearer)
}

/** A login (or a test) starts the session over: refreshes are allowed again. */
export function clearAuthRefreshBlock(): void {
  authenticatedFetch.sessionGuard.clear()
}

export function prepareAuthenticatedRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
  requestOptions?: AuthenticatedRequestOptions,
): Promise<RequestInit> {
  return authenticatedFetch.prepare(input, init, requestOptions)
}

export function clearAuthenticatedFetchCsrfCache(): void {
  authenticatedFetch.csrfManager.clear()
}
