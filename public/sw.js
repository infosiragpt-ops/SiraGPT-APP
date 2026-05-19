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
 *     are served cache-first (long-lived static assets).
 *   - GET HTML navigations fall back to /offline when the network fails.
 *   - Everything else (POST, /api, third-party) is passed straight to
 *     fetch — never cached, never intercepted beyond default behavior.
 *
 * Bump CACHE_VERSION whenever the static asset list below changes; the
 * old caches are deleted on activate.
 */
const CACHE_VERSION = 'sira-v1'
const STATIC_CACHE = `${CACHE_VERSION}-static`
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`

const PRECACHE_URLS = [
  '/offline',
  '/sira-gpt-192.png',
  '/sira-gpt-512.png',
  '/manifest.webmanifest',
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

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/sira-gpt-') ||
    url.pathname === '/manifest.webmanifest'
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never touch API / Next.js data fetches — those are dynamic.
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/_next/data/')) return

  // Cache-first for hashed static assets.
  if (isCacheableStatic(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  // Network-first for HTML navigations, with offline fallback.
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
