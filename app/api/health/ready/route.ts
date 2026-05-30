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
  const backend = await backendHealthCheck("/health/live", 1_000)
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
