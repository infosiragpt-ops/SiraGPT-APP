const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#0f172a"/>
  <path d="M18 42V22h10.5c6.8 0 11.5 4 11.5 10s-4.7 10-11.5 10H18Zm7-6h3.5c2.9 0 4.5-1.5 4.5-4s-1.6-4-4.5-4H25v8Z" fill="#f8fafc"/>
  <path d="M45 42h-7l7-20h7l-7 20Z" fill="#38bdf8"/>
</svg>`

export const dynamic = "force-static"

export function GET() {
  return new Response(icon, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
