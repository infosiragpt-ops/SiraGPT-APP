"use client"

/**
 * mfa-totp — client for the existing backend 2FA TOTP endpoints.
 *
 * Backend surface (already shipped; this is just the typed wire-up):
 *   POST /api/users/me/2fa/totp/setup            → { otpauthUrl, qrPngBase64 }
 *   POST /api/auth/2fa/totp/verify { code }      → activates totpEnabled
 *   POST /api/users/me/2fa/totp/recovery-codes   → { codes: string[] } (one-time)
 *   DELETE /api/users/me/2fa/totp                → disable
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface TotpSetupResponse {
  otpauthUrl: string
  qrPngBase64?: string
  secret?: string
}

export interface TotpRecoveryCodesResponse {
  codes: string[]
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonOrThrow<T>(res: Response, action: string): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error((data as { error?: string })?.error || `${action}: ${res.status}`) as Error & {
      status?: number
      code?: string
    }
    err.status = res.status
    err.code = (data as { code?: string })?.code
    throw err
  }
  return data as T
}

/** Begin TOTP enrolment. Returns the otpauth URL + a QR PNG (base64). */
export async function setupTotp(): Promise<TotpSetupResponse> {
  const res = await fetch(`${API_ROOT}/users/me/2fa/totp/setup`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
  })
  return jsonOrThrow<TotpSetupResponse>(res, "setupTotp")
}

/** Verify a 6-digit code from the user's authenticator app + flip
 * `totpEnabled=true` on the server. */
export async function verifyTotp(code: string): Promise<{ ok: true }> {
  const res = await fetch(`${API_ROOT}/auth/2fa/totp/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ code }),
  })
  return jsonOrThrow<{ ok: true }>(res, "verifyTotp")
}

/** Regenerate recovery codes. Returns the plaintext set ONCE — the
 * server only stores the hashes. The UI must surface them
 * immediately + instruct the user to save them offline. */
export async function regenerateRecoveryCodes(): Promise<TotpRecoveryCodesResponse> {
  const res = await fetch(`${API_ROOT}/users/me/2fa/totp/recovery-codes`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
  })
  return jsonOrThrow<TotpRecoveryCodesResponse>(res, "regenerateRecoveryCodes")
}

/** Disable TOTP completely. Server requires password reverification
 * for sensitive actions, but the endpoint surface is the same. */
export async function disableTotp(): Promise<{ ok: true }> {
  const res = await fetch(`${API_ROOT}/users/me/2fa/totp`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeader(),
  })
  return jsonOrThrow<{ ok: true }>(res, "disableTotp")
}
