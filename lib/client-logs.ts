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
}

const MAX_MESSAGE = 700
const SENSITIVE_KEY_RE = /password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|session|csrf/i

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

export function reportClientLog(payload: ClientLogPayload): void {
  if (typeof window === "undefined") return

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

export function reportErrorBoundary(label: string, error: Error): void {
  reportClientLog({
    source: "render",
    severity: "error",
    action: "error_boundary",
    component: label,
    message: error.message,
    stack: error.stack,
  })
}
