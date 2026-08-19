import { NextResponse, type NextRequest } from "next/server"
import { applyNextApiCorsHeaders } from "@/lib/next-api-cors"
import { loadRegistry, reloadRegistry, agentToInfo } from "@/server/agents/registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  try {
    const agents = loadRegistry()
    const info = agents.map(agentToInfo)
    return applyNextApiCorsHeaders(
      request,
      NextResponse.json({ agents: info, count: info.length }, { status: 200 })
    )
  } catch (e) {
    return applyNextApiCorsHeaders(
      request,
      NextResponse.json({ error: "Failed to load agents" }, { status: 500 })
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const agents = reloadRegistry()
    const info = agents.map(agentToInfo)
    return applyNextApiCorsHeaders(
      request,
      NextResponse.json({ agents: info, count: info.length, reloaded: true }, { status: 200 })
    )
  } catch (e) {
    return applyNextApiCorsHeaders(
      request,
      NextResponse.json({ error: "Failed to reload agents" }, { status: 500 })
    )
  }
}