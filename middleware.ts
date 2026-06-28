import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import Negotiator from 'negotiator'
import { match as matchLocale } from '@formatjs/intl-localematcher'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  localeForCountry,
} from './lib/i18n/locales'
import { countryCodeFromHeaders } from './lib/i18n/locale-resolution'
import { applyNextApiCorsHeaders, buildNextApiPreflightResponse } from './lib/next-api-cors'

const LOCALE_COOKIE = 'NEXT_LOCALE'
const ONE_YEAR = 60 * 60 * 24 * 365
const CODE_RUNNER_PROXY_RE = /^\/api\/code-runner\/[^/]+\/proxy(?:\/|$)/
const ALLOW_FRAME_PREVIEW = process.env.ALLOW_REPLIT_PREVIEW === '1'

// Server Action IDs in Next.js are 40-char lowercase hex SHA-1 digests.
// Anything else hitting the `Next-Action` header is either a stale client
// from a previous deployment or — much more commonly — a security scanner
// probing for server actions. We don't use Server Actions in this app
// (no "use server" directives), so we can safely 410 these and stop the
// log noise without affecting any real user flow.
const SERVER_ACTION_ID_RE = /^[a-f0-9]{40}$/

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Short-circuit bogus / stale Server Action POSTs before Next.js's
  // runtime turns them into a "Failed to find Server Action" error.
  const nextActionHeader = request.headers.get('next-action')
  if (nextActionHeader !== null) {
    if (!SERVER_ACTION_ID_RE.test(nextActionHeader)) {
      return applyFrameHeaders(pathname, new NextResponse(null, { status: 410 }))
    }
    // Even if it matches the hash shape, this app doesn't ship any
    // server actions, so the action will never resolve. Treat as gone.
    return applyFrameHeaders(pathname, new NextResponse(null, { status: 410 }))
  }

  // API + Next internals skip locale handling but keep CORS for /api.
  if (pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') {
      return applyFrameHeaders(pathname, buildNextApiPreflightResponse(request))
    }
    const res = NextResponse.next()
    return applyFrameHeaders(pathname, applyNextApiCorsHeaders(request, res))
  }

  // Expose the current pathname to RSC via a request header. The root
  // layout's generateMetadata() reads this to emit a per-route canonical
  // tag — fixing the Lighthouse "rel=canonical points to homepage"
  // warning without forcing every page to declare its own metadata.
  const reqHeaders = new Headers(request.headers)
  reqHeaders.set('x-pathname', pathname)

  // If the user already has a supported locale cookie, do nothing
  // (besides forwarding the new header).
  const existing = request.cookies.get(LOCALE_COOKIE)?.value
  if (isSupportedLocale(existing)) {
    return applyFrameHeaders(pathname, NextResponse.next({ request: { headers: reqHeaders } }))
  }

  // 2) Negotiate from Accept-Language using IETF precedence.
  const accept = request.headers.get('accept-language') || ''
  let resolved: string | undefined
  if (accept) {
    try {
      const headerShim = { 'accept-language': accept }
      const negotiator = new Negotiator({ headers: headerShim })
      const wanted = negotiator.languages()
      if (wanted && wanted.length > 0) {
        resolved = matchLocale(wanted, [...SUPPORTED_LOCALES], DEFAULT_LOCALE)
      }
    } catch {
      /* malformed accept-language → fall through */
    }
  }

  // 3) IP geolocation if Accept-Language was useless (curl, RSS readers,
  //    headless bots). Only fires once — the resolved locale is cached
  //    in the NEXT_LOCALE cookie for a year.
  if (!isSupportedLocale(resolved)) {
    const headerCountry = countryCodeFromHeaders(request.headers)
    if (headerCountry) {
      resolved = localeForCountry(headerCountry)
    }
  }

  if (!isSupportedLocale(resolved)) {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || request.headers.get('x-real-ip')
      || ''
    if (ip && !isPrivateIP(ip)) {
      try {
        // 1.2s budget — don't block first paint for slow geoloc.
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 1200)
        const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: ctrl.signal, cache: 'no-store' })
        clearTimeout(timer)
        if (r.ok) {
          const data: any = await r.json()
          const cc = (data?.country_code || data?.country) as string | undefined
          if (cc) resolved = localeForCountry(cc)
        }
      } catch {
        /* network / timeout / 429 — fall through to default */
      }
    }
  }

  const locale = isSupportedLocale(resolved) ? (resolved as string) : DEFAULT_LOCALE
  const res = NextResponse.next({ request: { headers: reqHeaders } })
  res.cookies.set(LOCALE_COOKIE, locale, { path: '/', maxAge: ONE_YEAR, sameSite: 'lax' })
  return applyFrameHeaders(pathname, res)
}

function applyFrameHeaders(pathname: string, response: NextResponse): NextResponse {
  if (CODE_RUNNER_PROXY_RE.test(pathname)) {
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
    response.headers.set('Content-Security-Policy', "frame-ancestors 'self'")
    return response
  }

  if (!ALLOW_FRAME_PREVIEW) {
    response.headers.set('X-Frame-Options', 'DENY')
  }

  return response
}

/** Skip geoloc for RFC1918 + loopback + link-local addresses. */
function isPrivateIP(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true
  if (ip.startsWith('169.254.')) return true
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true // ULA IPv6
  return false
}

export const config = {
  // Run on every page + api route, but skip static assets and Next
  // internals so the geoloc lookup doesn't fire for every image.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sira-gpt.png|icons/|.*\\..*).*)'],
}
