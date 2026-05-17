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
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
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

  webpack: (config) => {
    // pdfjs-dist (used by react-pdf) optionally requires the Node-only
    // `canvas` package on the server. We use react-pdf only in client
    // components, so aliasing it to `false` prevents a "Module not found:
    // Can't resolve 'canvas'" build warning without affecting runtime.
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
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
