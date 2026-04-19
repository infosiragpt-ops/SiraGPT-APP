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
    return config
  },
}

export default nextConfig
