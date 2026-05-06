import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const DEV_FALLBACK_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
] as const

export function resolveNextApiAllowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const configured = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (configured.length > 0) return configured
  if (env.NODE_ENV === 'production') return []
  return [...DEV_FALLBACK_ORIGINS]
}

export function isNextApiOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) return true
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin)
}

export function applyNextApiCorsHeaders(
  request: NextRequest,
  response: NextResponse,
  allowedOrigins = resolveNextApiAllowedOrigins(),
): NextResponse {
  const origin = request.headers.get('origin')
  response.headers.set('Vary', appendVary(response.headers.get('Vary'), 'Origin'))
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.headers.set('Access-Control-Max-Age', '86400')

  if (!origin) return response
  if (!isNextApiOriginAllowed(origin, allowedOrigins)) return response

  response.headers.set('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin)
  return response
}

export function buildNextApiPreflightResponse(request: NextRequest): NextResponse {
  const allowedOrigins = resolveNextApiAllowedOrigins()
  const origin = request.headers.get('origin')
  const allowed = isNextApiOriginAllowed(origin, allowedOrigins)
  const response = new NextResponse(null, { status: allowed ? 204 : 403 })
  return applyNextApiCorsHeaders(request, response, allowedOrigins)
}

function appendVary(existing: string | null, value: string): string {
  const parts = new Set(
    String(existing || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
  parts.add(value)
  return [...parts].join(', ')
}
