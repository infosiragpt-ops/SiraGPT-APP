import { NextRequest, NextResponse } from "next/server"
import {
  parseDesktopChannel,
  parseDesktopPlatform,
  resolveDesktopRelease,
} from "@/lib/desktop-releases"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const rawPlatform = request.nextUrl.searchParams.get("platform")
  const platform = parseDesktopPlatform(rawPlatform)
  if (!platform) return NextResponse.json({ error: "unsupported_platform" }, { status: 400 })

  const channel = parseDesktopChannel(request.nextUrl.searchParams.get("channel"))
  const release = await resolveDesktopRelease(platform, channel)
  if (!release) {
    return NextResponse.json(
      { error: "desktop_release_unavailable", platform, channel, downloadsPage: "/descargas" },
      { status: 404 },
    )
  }

  const response = NextResponse.redirect(release.downloadUrl, 307)
  response.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600")
  response.headers.set("X-SiraGPT-Release", release.releaseTag)
  return response
}
