/** @type {import('next').NextConfig} */
const nextConfig = {
  // experimental: {
  //   appDir: true,
  // },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    domains: ["placeholder.svg"],
    unoptimized: true,
  },
  env: {
    CUSTOM_KEY: "my-value",
  },
}

module.exports = nextConfig


//for Images
// reactStrictMode: true,
//   images: {
//     // Apne backend domain ko yahan add karein
//     remotePatterns: [
//       {
//         protocol: 'http', // Ya 'https' agar production mein HTTPS use kar rahe hain
//         hostname: 'localhost', // Development ke liye
//         port: '5000', // Apne backend port ko yahan specify karein
//         pathname: '/uploads/images/**', // Jis path se images serve ho rahi hain
//       },
//       // Production deployment ke liye apna actual domain add karein, maslan:
//       // {
//       //   protocol: 'https',
//       //   hostname: 'your-production-api-domain.com',
//       //   port: '', // Agar default HTTPS port (443) hai
//       //   pathname: '/uploads/images/**',
//       // },
//     ],
//   },
//   env: {
//     NEXT_PUBLIC_API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:5000',
//   },