import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders, buildNextApiPreflightResponse } from "@/lib/next-api-cors"
import { frontendCheck, noStoreJson, uptimeSeconds } from "@/lib/next-health"

export function HEAD(request: NextRequest) {
  return applyNextApiCorsHeaders(request, new NextResponse(null, { status: 204 }))
}

export function GET(request: NextRequest) {
  return noStoreJson(request, {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime_s: uptimeSeconds(),
    checks: [frontendCheck()],
  })
}

export function OPTIONS(request: NextRequest) {
  return buildNextApiPreflightResponse(request)
}
