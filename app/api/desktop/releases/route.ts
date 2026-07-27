import { NextRequest, NextResponse } from "next/server"
import {
  parseDesktopChannel,
  parseDesktopPlatform,
  resolveDesktopRelease,
  resolveDesktopReleaseCatalog,
} from "@/lib/desktop-releases"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const channel = parseDesktopChannel(request.nextUrl.searchParams.get("channel"))
  const platformParam = request.nextUrl.searchParams.get("platform")
  const platform = parseDesktopPlatform(platformParam)

  if (platformParam && !platform) {
    return NextResponse.json({ error: "unsupported_platform" }, { status: 400 })
  }

  const payload = platform
    ? { channel, platform, release: await resolveDesktopRelease(platform, channel) }
    : { channel, releases: await resolveDesktopReleaseCatalog(channel) }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
  })
}
