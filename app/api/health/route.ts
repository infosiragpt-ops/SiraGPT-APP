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
  return applyNextApiCorsHeaders(request, new NextResponse(null, { status: 204 }))
}

export async function GET(request: NextRequest) {
  const backend = await backendHealthCheck("/health")
  // Surface the backend's 16 nested probes (database, redis, queue,
  // model_providers, …) as first-class checks so /admin/health can render
  // its per-service cards; the backend summary entry keeps its name for
  // existing consumers. summarizeHealth propagates "degraded" honestly.
  const nested = Array.isArray(backend.details?.checks)
    ? (backend.details.checks as ReturnType<typeof frontendCheck>[])
    : []
  const checks = [frontendCheck(), backend, ...nested]
  const status = summarizeHealth(checks)

  return noStoreJson(request, {
    status,
    timestamp: new Date().toISOString(),
    uptime_s: uptimeSeconds(),
    checks,
  })
}

export function OPTIONS(request: NextRequest) {
  return buildNextApiPreflightResponse(request)
}
