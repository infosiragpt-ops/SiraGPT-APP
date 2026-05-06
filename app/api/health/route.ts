import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders, buildNextApiPreflightResponse } from "@/lib/next-api-cors"

type HealthStatus = "healthy" | "degraded" | "unhealthy" | "skipped"

interface HealthCheck {
  name: string
  status: HealthStatus
  critical: boolean
  latency_ms: number
  details?: Record<string, unknown>
}

const startedAt = Date.now()
const BACKEND_HEALTH_TIMEOUT_MS = 1_500

export async function HEAD(request: NextRequest) {
  return applyNextApiCorsHeaders(request, new NextResponse(null, { status: 204 }))
}

export async function GET(request: NextRequest) {
  const checks = [frontendCheck(), await backendCheck()]
  const criticalUnhealthy = checks.some((check) => check.critical && check.status === "unhealthy")
  const degraded = checks.some((check) => check.status === "degraded")
  const status: HealthStatus = criticalUnhealthy ? "unhealthy" : degraded ? "degraded" : "healthy"

  const response = NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    uptime_s: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    checks,
  })

  return applyNextApiCorsHeaders(request, response)
}

export function OPTIONS(request: NextRequest) {
  return buildNextApiPreflightResponse(request)
}

function frontendCheck(): HealthCheck {
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

async function backendCheck(): Promise<HealthCheck> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BACKEND_HEALTH_TIMEOUT_MS)

  try {
    const response = await fetch(resolveBackendHealthUrl(), {
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
      },
    }
  } catch (error) {
    return {
      name: "backend",
      status: "unhealthy",
      critical: true,
      latency_ms: Date.now() - started,
      details: {
        error: error instanceof Error ? error.name : "FetchError",
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

function resolveBackendHealthUrl(): string {
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
  const url = new URL(configuredApiUrl, "http://localhost:5000")

  if (url.pathname.endsWith("/api")) {
    url.pathname = url.pathname.slice(0, -"/api".length) || "/"
  }

  url.pathname = joinPath(url.pathname, "health")
  url.search = ""
  url.hash = ""

  return url.toString()
}

function joinPath(basePath: string, suffix: string): string {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath
  return `${normalizedBase}/${suffix}`.replace(/\/+/g, "/")
}
