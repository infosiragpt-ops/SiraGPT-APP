/**
 * Push notification client scaffold.
 *
 * Strategy:
 *   - On Capacitor native, use `@capacitor/push-notifications` if available
 *     (FCM on Android, APNs on iOS).
 *   - On web, fall back to the standard Push API + Service Worker subscription
 *     (VAPID public key delivered by the backend).
 *
 * The backend stores tokens via `POST /api/push/subscribe` (see
 * `backend/src/routes/push.js`).
 */

export type PushTokenInfo = {
  token: string
  platform: "ios" | "android" | "web"
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
}

export type PushSubscribeOptions = {
  /** Backend base URL (default same-origin). */
  apiBase?: string
  /** VAPID public key (web push). If absent, we'll fetch it from `/api/push/vapid-key`. */
  vapidPublicKey?: string
  /** Auth bearer token. */
  authToken?: string
  /** Custom fetch (for tests). */
  fetchImpl?: typeof fetch
}

export type PushSubscribeResult = {
  ok: boolean
  via: "fcm" | "web-push" | "none"
  info?: PushTokenInfo
  error?: string
}

function isCapacitorNative(): boolean {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }
    return !!g.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

function detectPlatform(): "ios" | "android" | "web" {
  try {
    const g = globalThis as unknown as { Capacitor?: { getPlatform?: () => string } }
    const p = g.Capacitor?.getPlatform?.()
    if (p === "ios") return "ios"
    if (p === "android") return "android"
  } catch {
    /* ignore */
  }
  return "web"
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function postSubscribe(
  apiBase: string,
  info: PushTokenInfo,
  authToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  const res = await fetchImpl(`${apiBase}/api/push/subscribe`, {
    method: "POST",
    headers,
    body: JSON.stringify(info),
  })
  if (!res.ok) throw new Error(`subscribe failed: ${res.status}`)
}

async function registerFCM(
  opts: PushSubscribeOptions,
  fetchImpl: typeof fetch,
): Promise<PushSubscribeResult | null> {
  if (!isCapacitorNative()) return null
  try {
    const spec = "@capacitor/push-notifications"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    const Push = mod?.PushNotifications
    if (!Push) return null

    const perm = await Push.requestPermissions()
    if (perm?.receive !== "granted") {
      return { ok: false, via: "fcm", error: "permission denied" }
    }

    const token = await new Promise<string>((resolve, reject) => {
      const okHandle = Push.addListener("registration", (t: any) => {
        resolve(String(t?.value ?? ""))
        okHandle?.remove?.()
      })
      Push.addListener("registrationError", (e: any) => {
        reject(new Error(e?.error ?? "registration error"))
      })
      Push.register().catch(reject)
    })

    const info: PushTokenInfo = { token, platform: detectPlatform() }
    await postSubscribe(opts.apiBase ?? "", info, opts.authToken, fetchImpl)
    return { ok: true, via: "fcm", info }
  } catch (err) {
    return { ok: false, via: "fcm", error: err instanceof Error ? err.message : String(err) }
  }
}

async function registerWebPush(
  opts: PushSubscribeOptions,
  fetchImpl: typeof fetch,
): Promise<PushSubscribeResult> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, via: "none", error: "web push not supported" }
  }
  const permission = await Notification.requestPermission()
  if (permission !== "granted") {
    return { ok: false, via: "web-push", error: "permission denied" }
  }

  let vapid = opts.vapidPublicKey
  if (!vapid) {
    try {
      const res = await fetchImpl(`${opts.apiBase ?? ""}/api/push/vapid-key`)
      if (res.ok) {
        const json = (await res.json()) as { publicKey?: string }
        vapid = json?.publicKey
      }
    } catch {
      /* ignore */
    }
  }

  const reg = await navigator.serviceWorker.ready
  const subscribeOptions: PushSubscriptionOptionsInit = { userVisibleOnly: true }
  if (vapid) {
    // Cast to BufferSource — TS bundlers disagree on the ArrayBuffer variance
    // around Uint8Array; the runtime call accepts Uint8Array fine.
    subscribeOptions.applicationServerKey = urlBase64ToUint8Array(vapid) as unknown as BufferSource
  }
  const sub = await reg.pushManager.subscribe(subscribeOptions)

  const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string }; endpoint?: string }
  const info: PushTokenInfo = {
    token: json.endpoint ?? sub.endpoint ?? "",
    platform: "web",
    endpoint: json.endpoint ?? sub.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  }
  await postSubscribe(opts.apiBase ?? "", info, opts.authToken, fetchImpl)
  return { ok: true, via: "web-push", info }
}

export async function subscribe(opts: PushSubscribeOptions = {}): Promise<PushSubscribeResult> {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null)
  if (!fetchImpl) return { ok: false, via: "none", error: "fetch unavailable" }

  const fcm = await registerFCM(opts, fetchImpl)
  if (fcm) return fcm

  return registerWebPush(opts, fetchImpl)
}

export async function unsubscribe(opts: PushSubscribeOptions = {}): Promise<{ ok: boolean }> {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null)
  if (!fetchImpl) return { ok: false }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`
    const res = await fetchImpl(`${opts.apiBase ?? ""}/api/push/unsubscribe`, {
      method: "POST",
      headers,
    })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
}

export function isPushSupported(): boolean {
  if (isCapacitorNative()) return true
  if (typeof window === "undefined") return false
  return "serviceWorker" in navigator && "PushManager" in window
}
