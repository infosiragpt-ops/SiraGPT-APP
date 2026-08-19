import { authenticatedFetch } from "../../authenticated-fetch"
import type { CodexAccess, CodexHealth } from "./types"

const BASE = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")}/codex`

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export type CodexRequestInit = RequestInit & { timeoutMs?: number }

export function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function boundedRequestSignal(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!externalSignal) return timeoutSignal

  const anySignal = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal
    }
  ).any
  if (anySignal) return anySignal([externalSignal, timeoutSignal])

  // Compatibility fallback for browsers that have AbortSignal.timeout() but
  // not AbortSignal.any(): either user cancellation or the hard deadline wins.
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (externalSignal.aborted || timeoutSignal.aborted) {
    abort()
  } else {
    externalSignal.addEventListener("abort", abort, { once: true })
    timeoutSignal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

export async function requestCodex<T>(path: string, init?: CodexRequestInit): Promise<T> {
  // A hung backend must never freeze the composer's busy latch: every JSON
  // call gets a hard timeout (SSE streaming goes through run-stream.ts, not
  // req(), so this is safe globally). Preview startup is the exception: the
  // backend may legitimately wait up to 90s for a cold install, so that caller
  // opts into a larger bounded timeout.
  const { timeoutMs = 20_000, ...requestInit } = init || {}
  const res = await authenticatedFetch(`${BASE}${path}`, {
    credentials: "include",
    headers: authHeaders(),
    ...requestInit,
    signal: boundedRequestSignal(requestInit.signal, timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((body as any)?.message || (body as any)?.error || `codex http ${res.status}`), { status: res.status, body })
  return body as T
}

export function codexErrorCode(error: unknown): string | null {
  const candidate = error as {
    code?: unknown
    body?: { error?: unknown; code?: unknown }
    status?: unknown
  } | null
  if (typeof candidate?.code === "string" && candidate.code.trim()) return candidate.code.trim()
  if (typeof candidate?.body?.error === "string" && candidate.body.error.trim()) return candidate.body.error.trim()
  if (typeof candidate?.body?.code === "string" && candidate.body.code.trim()) return candidate.body.code.trim()
  return candidate?.status === 404 ? "project_not_found" : null
}

export function codexIdentityIssue(
  error: unknown,
  fallbackCode = "company_association_unavailable",
): { code: string; message: string } {
  const code = codexErrorCode(error) || fallbackCode
  const message = code === "company_project_not_found"
    ? "No se encontró el Project de esta empresa o ya no tienes acceso."
    : code === "project_not_found"
      ? "El proyecto Codex asociado ya no existe."
      : "No se pudo comprobar la asociación persistente."
  return { code, message }
}

export async function getPublicHealth(): Promise<CodexHealth> {
  const res = await fetch(`${BASE}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(new Error((body as any)?.error || `codex http ${res.status}`), {
      status: res.status,
      body,
    })
  }
  return body as CodexHealth
}

export const coreCodexApi = {
  // no-store: the flag can change; a cached 304 (enabled:false) would strand
  // the UI on the old /code flow even after the flag is turned on.
  health: getPublicHealth,
  access: () => requestCodex<CodexAccess>("/access", { cache: "no-store" }),
} as const
