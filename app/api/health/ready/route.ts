import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders, buildNextApiPreflightResponse } from "@/lib/next-api-cors"
import {
  backendHealthCheck,
  frontendCheck,
  noStoreJson,
  summarizeHealth,
  uptimeSeconds,
} from "@/lib/next-health"

export async function HEAD(request: NextRequest) {
  // Liveness probe consumed by useBackendReady's client poller. The old
  // 1_000ms cap was aggressive enough that a cold-compiled route, a GC pause,
  // or a momentarily busy event loop returned a false 503 — which flipped the
  // login/register UI to the "server is starting" banner even though the
  // backend was up. 3_000ms still fails fast during a genuine outage (the
  // backend isn't listening, so the fetch refuses immediately) but tolerates
  // transient slowness on a healthy backend.
  const backend = await backendHealthCheck("/health/live", 3_000)
  return applyNextApiCorsHeaders(request, new NextResponse(null, {
    status: backend.status === "healthy" ? 204 : 503,
  }))
}

export async function GET(request: NextRequest) {
  const checks = [frontendCheck(), await backendHealthCheck("/health/ready")]
  const status = summarizeHealth(checks)

  return noStoreJson(request, {
    status,
    timestamp: new Date().toISOString(),
    uptime_s: uptimeSeconds(),
    checks,
  }, {
    status: status === "unhealthy" ? 503 : 200,
  })
}

export function OPTIONS(request: NextRequest) {
  return buildNextApiPreflightResponse(request)
}
