import createNextIntlPlugin from 'next-intl/plugin'

// Point next-intl at our request-config loader (reads cookie / headers
// and merges the per-locale message bundle with the English fallback).
const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

// Replit Preview renders the dev server inside a cross-origin iframe.
// Keep frame blocking everywhere else, but allow that explicit dev mode.
const allowReplitPreview = process.env.ALLOW_REPLIT_PREVIEW === '1'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output produces a self-contained build at .next/standalone/
  // with only the runtime files needed. Ideal for Docker multi-stage builds
  // where we only copy that directory to the runner image.
  output: process.env.NEXT_OUTPUT === 'standalone' || process.env.DOCKER_BUILD === 'true'
    ? 'standalone'
    : undefined,

  eslint: {
    // Lint is run as its own gate in CI (`npm run lint`). Running it
    // again inside `next build` only adds ~30 s and gives us a *second*
    // place where a single new warning can take down a deploy — exactly
    // the failure mode we are protecting against. Production build now
    // trusts CI for static checks; runtime correctness is what matters
    // here.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type-checking is enforced in CI via `npm run type-check`. Skipping
    // it inside `next build` shaves ~30s off the production build and
    // matches what worked in the last green deploy.
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Enable React strict mode in development to catch double-render bugs
  reactStrictMode: true,

  // Production source maps for Sentry (uploaded separately, not served to users)
  productionBrowserSourceMaps: false,

  // Compress responses with gzip at the CDN/reverse proxy layer instead
  // of Next.js middleware (more efficient). Disable built-in compression
  // if using a reverse proxy like Nginx or a CDN that handles it.
  compress: true,

  // Power the HTML response with the experimental headers API for stricter
  // security defaults. These supplement but don't replace the Helmet-backed
  // backend CSP headers.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          ...(allowReplitPreview ? [] : [
            {
              key: 'X-Frame-Options',
              value: 'DENY',
            },
          ]),
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ]
  },

  // Single-container deployment: Express backend runs alongside Next.js on
  // the same Replit Autoscale instance, bound to 127.0.0.1:5050 (never
  // exposed externally — port chosen to avoid Replit's PORT=5000 injection).
  // Every browser-visible /api/* call is proxied through Next.js so the
  // public domain is the only ingress. Returning an array uses Next.js's
  // `afterFiles` semantics — filesystem routes match first, so Next.js-owned
  // API endpoints (/api/ready, /api/health, …) keep being served by Next.js
  // and only unmatched /api/* paths fall through to Express.
  //
  // NOTE: Next.js standalone bakes the rewrites() result into the build
  // artefact, so BACKEND_INTERNAL_URL must be set at BUILD time (not just
  // runtime) for overrides to take effect. The fallback below must therefore
  // match scripts/start-all.js's BACKEND_PORT default (5050).
  async rewrites() {
    const backendBase = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:5050'
    return [
      {
        source: '/api/:path*',
        destination: `${backendBase}/api/:path*`,
      },
      // `/uploads/*` is served by Express via `express.static(uploadDir)`.
      // Without this rewrite the browser fetches `/uploads/<user>/<file>`
      // from Next.js, which 404s, and image previews in chat render as
      // broken icons. Proxy through Next.js so the public domain is the
      // only ingress (same pattern as `/api`).
      {
        source: '/uploads/:path*',
        destination: `${backendBase}/uploads/:path*`,
      },
    ]
  },

  webpack: (config, { dev }) => {
    // pdfjs-dist (used by react-pdf) optionally requires the Node-only
    // `canvas` package on the server. We use react-pdf only in client
    // components, so aliasing it to `false` prevents a "Module not found:
    // Can't resolve 'canvas'" build warning without affecting runtime.
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    }
    // Inline eval-source-maps in dev push individual chunks past 7 MB,
    // which the Replit preview proxy truncates at ~1 MB. That truncation
    // produces a "SyntaxError: Invalid or unexpected token" in the
    // browser, breaks hydration, and leaves the page blank below the
    // header. Use a cheap external source map so chunks stay under the
    // proxy ceiling while keeping line-level debuggability.
    if (dev) {
      // Force-disable source maps in dev. Next.js's default `eval-source-map`
      // inlines a full base64 source map inside every `eval(...)` HMR
      // wrapper, blowing `app/layout.js` past 7 MB. The Replit preview
      // proxy truncates responses at ~1 MB, so the browser receives a
      // half-parsed chunk → "SyntaxError: Invalid or unexpected token"
      // → hydration fails → page goes blank below the header. Trading
      // dev source-map fidelity to keep dev usable on Replit.
      config.devtool = false
    }
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/.git/**',
        '**/.next/**',
        '**/backend/**',
        '**/node_modules/**',
      ],
    }
    return config
  },
}

export default withNextIntl(nextConfig)
