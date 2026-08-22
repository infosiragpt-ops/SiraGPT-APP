/** Shared redaction for route error.tsx shells. Never echo email, token, Stripe, or system prompts. */
export function redactRouteError(
  error: (Error & { digest?: string }) | null | undefined,
  kind: "billing" | "login" | "invite" | "gpts" | "settings",
): { digest?: string; safeName: string } {
  const digest = error?.digest && /^[A-Za-z0-9_-]{6,64}$/.test(error.digest) ? error.digest : undefined
  const raw = `${error?.name || ""} ${error?.message || ""}`
  if (kind === "billing" && /stripe|cus_|pi_|sk_live|email/i.test(raw)) {
    return { digest, safeName: "BillingError" }
  }
  if (kind === "login" && /@|email|password|token/i.test(raw)) {
    return { digest, safeName: "AuthError" }
  }
  if (kind === "invite" && /token|invite|bearer/i.test(raw)) {
    return { digest, safeName: "InviteError" }
  }
  if (kind === "gpts" && /system prompt|you are|instructions/i.test(raw)) {
    return { digest, safeName: "GptError" }
  }
  return { digest, safeName: error?.name || "Error" }
}

export function safeRouteErrorLog(kind: string, error: (Error & { digest?: string }) | null | undefined): void {
  try {
    const redacted = redactRouteError(error, kind as "billing")
    console.warn(`[${kind}] route error`, redacted.digest || redacted.safeName)
  } catch {
    /* ignore */
  }
}
