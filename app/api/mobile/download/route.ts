import { NextRequest, NextResponse } from "next/server"
import { parseMobilePlatform, resolveMobileRelease } from "@/lib/mobile-releases"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const rawPlatform = request.nextUrl.searchParams.get("platform")
  const platform = parseMobilePlatform(rawPlatform)
  if (!platform) return NextResponse.json({ error: "unsupported_platform" }, { status: 400 })

  const release = await resolveMobileRelease(platform)
  if (!release) {
    return NextResponse.json(
      { error: "mobile_release_unavailable", platform, downloadsPage: "/descargas" },
      { status: 404 },
    )
  }

  const response = NextResponse.redirect(release.downloadUrl, 307)
  response.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600")
  response.headers.set("X-SiraGPT-Release", release.releaseTag)
  return response
}
