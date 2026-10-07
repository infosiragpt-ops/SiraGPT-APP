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
 * After `/auth/refresh` itself answers 401/403 the session is over: the
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

type RefreshOutcome = { ok: boolean; definitive: boolean }

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

async function isCsrfInvalid(response: Response): Promise<boolean> {
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
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly readCsrfCookie: () => string | null

  constructor(options: CsrfTokenManagerOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl
    this.readCsrfCookie = options.readCsrfCookie
  }

  clear(): void {
    this.epoch += 1
    this.cachedToken = null
    this.inFlight = null
  }

  async getToken(forceRefresh = false): Promise<string | null> {
    if (typeof window === "undefined") return null
    if (forceRefresh) this.clear()

    if (this.cachedToken) return this.cachedToken
    if (!forceRefresh) {
      const cookieToken = normalizeToken(this.readCsrfCookie())
      if (cookieToken) return cookieToken
    }
    if (this.inFlight) return this.inFlight

    const requestEpoch = this.epoch
    const request = (async () => {
      try {
        const response = await this.fetchImpl(`${this.apiBaseUrl}${CSRF_PATH}`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        })
        if (!response.ok) return null
        const body = await response.json().catch(() => null) as { csrfToken?: unknown } | null
        const token = normalizeToken(body?.csrfToken) || normalizeToken(this.readCsrfCookie())
        if (token && this.epoch === requestEpoch) this.cachedToken = token
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

let refreshFlight: Promise<RefreshOutcome> | null = null

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

async function singleFlightRefresh(
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<RefreshOutcome> {
  if (refreshFlight) return refreshFlight
  refreshFlight = (async (): Promise<RefreshOutcome> => {
    try {
      const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" })
      try {
        if (typeof window !== "undefined") {
          const family = window.localStorage.getItem("siragpt:refresh-family")
          const version = window.localStorage.getItem("siragpt:refresh-version")
          if (family) headers.set("x-refresh-family", family)
          if (version) headers.set("x-refresh-version", version)
        }
      } catch { /* private mode */ }
      const res = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers,
      })
      // 401/403 from the refresh endpoint itself is final: the refresh
      // cookie is missing, expired or revoked. 5xx and network errors are not.
      if (!res.ok) return { ok: false, definitive: res.status === 401 || res.status === 403 }
      const data = await res.json().catch(() => null) as { token?: unknown } | null
      const token = typeof data?.token === "string" && data.token.trim() ? data.token.trim() : null
      if (token && typeof window !== "undefined") {
        try { window.localStorage.setItem("auth-token", token) } catch { /* ignore */ }
      }
      return { ok: Boolean(token) || res.ok, definitive: false }
    } catch {
      return { ok: false, definitive: false }
    }
  })()
  try {
    return await refreshFlight
  } finally {
    refreshFlight = null
  }
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
    const prepared = await prepare(input, init, requestOptions)
    let response = await fetchImpl(input, prepared)
    const method = resolveMethod(input, prepared)
    if (
      method === "GET"
      && isTrustedSiraApiUrl(input, apiBaseUrl)
      && (response.status === 502 || response.status === 503 || response.status === 504)
    ) {
      try { await new Promise((r) => setTimeout(r, 250)) } catch { /* ignore */ }
      response = await fetchImpl(input, prepared)
    }
    if (
      method === "GET"
      && isTrustedSiraApiUrl(input, apiBaseUrl)
      && response.status === 429
    ) {
      const ra = Number(response.headers.get("Retry-After") || 0)
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(2000, ra * 1000) : 400
      try { await new Promise((r) => setTimeout(r, waitMs)) } catch { /* ignore */ }
      response = await fetchImpl(input, prepared)
    }
    const usedBearer = new Headers(prepared.headers).has("Authorization")

    if (
      requestOptions.retryCsrfInvalid !== false
      && MUTATING_METHODS.has(method)
      && !usedBearer
      && isTrustedSiraApiUrl(input, apiBaseUrl)
      && await isCsrfInvalid(response)
    ) {
      const fresh = await csrfManager.getToken(true)
      if (!fresh) return response
      const retryHeaders = new Headers(prepared.headers)
      retryHeaders.set("X-CSRF-Token", fresh)
      return fetchImpl(input, { ...prepared, headers: retryHeaders })
    }

    if (response.ok && isSessionHandshakePath(input, apiBaseUrl)) sessionGuard.clear()

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
      const refreshed = await singleFlightRefresh(apiBaseUrl, fetchImpl)
      if (refreshed.ok) {
        const retried = await prepare(input, init, requestOptions)
        return fetchImpl(input, retried)
      }
      if (refreshed.definitive) sessionGuard.block(sentBearer)
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
