import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders } from "@/lib/next-api-cors"

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "skipped"

export interface HealthCheck {
  name: string
  status: HealthStatus
  critical: boolean
  latency_ms: number
  details?: Record<string, unknown>
}

const BACKEND_HEALTH_TIMEOUT_MS = 1_500
const startedAt = Date.now()

export function uptimeSeconds(): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000))
}

export function frontendCheck(): HealthCheck {
  return {
    name: "frontend",
    status: "healthy",
    critical: true,
    latency_ms: 0,
    details: {
      runtime: "nextjs",
    },
  }
}

export function summarizeHealth(checks: HealthCheck[]): HealthStatus {
  const criticalUnhealthy = checks.some((check) => check.critical && check.status === "unhealthy")
  const degraded = checks.some((check) => check.status === "degraded" || (!check.critical && check.status === "unhealthy"))
  return criticalUnhealthy ? "unhealthy" : degraded ? "degraded" : "healthy"
}

export function noStoreJson(request: NextRequest, body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers || {}),
    },
  })
  return applyNextApiCorsHeaders(request, response)
}

export async function backendHealthCheck(
  endpoint = "/health",
  timeoutMs = BACKEND_HEALTH_TIMEOUT_MS,
): Promise<HealthCheck> {
  const started = Date.now()
  const candidates = resolveBackendHealthUrls(endpoint)
  const failures: string[] = []

  for (const url of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      })

      const contentType = response.headers.get("content-type") || ""
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : null

      return {
        name: "backend",
        status: response.ok ? "healthy" : "unhealthy",
        critical: true,
        latency_ms: Date.now() - started,
        details: {
          http_status: response.status,
          backend_status: payload && typeof payload === "object" ? (payload as { status?: unknown }).status : undefined,
          endpoint,
          host: safeHost(url),
        },
      }
    } catch (error) {
      failures.push(`${safeHost(url)}:${error instanceof Error ? error.name : "FetchError"}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    name: "backend",
    status: "unhealthy",
    critical: true,
    latency_ms: Date.now() - started,
    details: {
      endpoint,
      attempts: failures,
    },
  }
}

export function resolveBackendHealthUrls(endpoint = "/health"): string[] {
  const bases = [
    process.env.BACKEND_INTERNAL_URL,
    process.env.SIRAGPT_INTERNAL_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    "http://127.0.0.1:5000",
    "http://127.0.0.1:5050",
  ]

  const seen = new Set<string>()
  const urls: string[] = []

  for (const base of bases) {
    const normalized = normalizeBackendBase(base)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(joinUrlPath(normalized, endpoint))
  }

  return urls
}

function normalizeBackendBase(raw?: string): string | null {
  const value = raw?.trim()
  if (!value || value.startsWith("/")) return null

  try {
    const url = new URL(value)
    url.hash = ""
    url.search = ""
    url.pathname = url.pathname.replace(/\/api\/?$/, "").replace(/\/+$/, "")
    return url.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

function joinUrlPath(base: string, endpoint: string): string {
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`.replace(/\/+/g, "/")
  return url.toString()
}

function safeHost(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return "unknown"
  }
}
