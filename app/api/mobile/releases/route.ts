import { NextRequest, NextResponse } from "next/server"
import {
  parseMobilePlatform,
  resolveMobileRelease,
  resolveMobileReleaseCatalog,
} from "@/lib/mobile-releases"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const platformParam = request.nextUrl.searchParams.get("platform")
  const platform = parseMobilePlatform(platformParam)

  if (platformParam && !platform) {
    return NextResponse.json({ error: "unsupported_platform" }, { status: 400 })
  }

  const payload = platform
    ? { platform, release: await resolveMobileRelease(platform) }
    : { releases: await resolveMobileReleaseCatalog() }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
  })
}
