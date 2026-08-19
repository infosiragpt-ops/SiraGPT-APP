/*
 * sw.js — minimal offline-fallback service worker for siraGPT.
 *
 * Scope: scaffolded only. Not auto-registered from layout.tsx to
 * honor CLAUDE.md rule #1 (don't modify visual components). A future
 * change can call `registerSiraServiceWorker()` from
 * lib/sw-register.ts inside any client component.
 *
 * Strategy:
 *   - Pre-cache the offline fallback page + brand icons during install.
 *   - GET requests for same-origin /_next/static, /icons, /sira-gpt-*.png
 *     are served cache-first (long-lived static assets, content-hashed).
 *   - GET HTML navigations fall back to /offline when the network fails.
 *   - Everything else (POST, /api, /_next/data, third-party, auth-bearing
 *     requests) is passed straight to fetch — never cached, never
 *     intercepted beyond default behavior.
 *
 * Cache versioning / bump strategy:
 *   - CACHE_VERSION is composed of a manually-bumped SCHEMA tag plus an
 *     optional BUILD_ID that the deploy pipeline can inject by string
 *     replacement (sed -i "s/__SIRAGPT_BUILD_ID__/$GIT_SHA/g" public/sw.js)
 *     so each deploy invalidates stale caches automatically.
 *   - Any cache that does not match the current CACHE_VERSION prefix is
 *     deleted on activate.
 *   - Bump SCHEMA_VERSION whenever the PRECACHE_URLS list or fetch policy
 *     changes shape (e.g. adding new pre-cached assets).
 */
const SCHEMA_VERSION = 'sira-v2'
// Placeholder replaced at deploy time. Falls back to 'dev' for local builds
// so the SW still functions without the substitution step.
const BUILD_ID = '__SIRAGPT_BUILD_ID__'.startsWith('__') ? 'dev' : '__SIRAGPT_BUILD_ID__'
const CACHE_VERSION = `${SCHEMA_VERSION}-${BUILD_ID}`
const STATIC_CACHE = `${CACHE_VERSION}-static`
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`

const PRECACHE_URLS = [
  '/offline',
  '/sira-gpt-192.png',
  '/sira-gpt-512.png',
  '/manifest.webmanifest',
]

// Paths that must never be intercepted or cached even if they happen to
// match a static-looking pattern. Treated as a deny-list applied before
// any cache logic so a misconfigured asset can't leak into the SW cache.
const NEVER_CACHE_PREFIXES = [
  '/api/',
  '/_next/data/',
  '/_next/image', // dynamic image optimizer
  '/auth/',
  '/login',
  '/logout',
  '/oauth/',
  '/stripe/',
  '/webhooks/',
  '/sse',
  '/socket.io',
  '/admin/',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(CACHE_VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function isNeverCache(url) {
  for (const prefix of NEVER_CACHE_PREFIXES) {
    if (url.pathname === prefix || url.pathname.startsWith(prefix)) return true
  }
  return false
}

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false
  if (isNeverCache(url)) return false
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/sira-gpt-') ||
    url.pathname === '/manifest.webmanifest'
  )
}

function hasAuthHeaders(request) {
  // Defensive: any credentialed/authorized request bypasses the cache so
  // we never persist a user-scoped response on a shared device.
  if (request.headers.has('authorization')) return true
  if (request.headers.has('cookie')) return true
  return false
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // Hard deny-list — pass straight through, never inspect/clone the body.
  if (isNeverCache(url)) return

  // Only ever cache same-origin assets.
  if (url.origin !== self.location.origin) return

  // Auth-bearing requests are never cached.
  if (hasAuthHeaders(request)) return

  // Cache-first for hashed static assets.
  if (isCacheableStatic(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            // Only cache opaque-safe, successful, basic responses. Skip
            // partials, redirects, errors, and opaque cross-origin frames.
            if (
              response &&
              response.ok &&
              response.status === 200 &&
              (response.type === 'basic' || response.type === 'default')
            ) {
              const copy = response.clone()
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  // Network-first for HTML navigations, with offline fallback. Never write
  // navigation responses to cache — they may contain user-scoped HTML.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/offline').then((cached) => cached || new Response('Offline', { status: 503 })),
      ),
    )
  }
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
