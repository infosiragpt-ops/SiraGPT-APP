import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders } from "@/lib/next-api-cors"

/**
 * Ultra-light readiness probe. Returns 200 the moment the Next.js
 * process is able to serve a request. Intentionally does NOT touch
 * the backend, database, Redis, or any other dependency — those are
 * covered by `/api/health`, which is the richer diagnostic endpoint
 * meant for monitoring dashboards, not for deployment health checks.
 *
 * Point Replit Deployments' health check at this route so a slow
 * backend or transient network hiccup does not block promotion of
 * a new container during a republish.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const startedAt = Date.now()

export function GET(request: NextRequest) {
  const response = NextResponse.json(
    {
      status: "ready",
      uptime_s: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  )
  return applyNextApiCorsHeaders(request, response)
}
