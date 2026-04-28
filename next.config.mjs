import createNextIntlPlugin from 'next-intl/plugin'

// Point next-intl at our request-config loader (reads cookie / headers
// and merges the per-locale message bundle with the English fallback).
const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
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
