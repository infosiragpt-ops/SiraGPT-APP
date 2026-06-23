import { NextResponse, type NextRequest } from "next/server"

import { buildNextApiPreflightResponse } from "@/lib/next-api-cors"
import { noStoreJson } from "@/lib/next-health"
import { getPublishingConsoleState, runPublishingAction } from "@/lib/publishing-console"
import type { PublishingActionId } from "@/lib/publishing-console-types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const state = await getPublishingConsoleState()
  return noStoreJson(request, state)
}

export async function POST(request: NextRequest) {
  let action: PublishingActionId | undefined

  try {
    const body = (await request.json()) as { action?: PublishingActionId }
    action = body.action
  } catch {
    return noStoreJson(request, { ok: false, message: "Invalid publishing action payload." }, { status: 400 })
  }

  if (!action) {
    return noStoreJson(request, { ok: false, message: "Missing publishing action." }, { status: 400 })
  }

  const result = await runPublishingAction(action)
  return noStoreJson(request, result, { status: result.ok ? 200 : 400 })
}

export function OPTIONS(request: NextRequest) {
  return buildNextApiPreflightResponse(request)
}

export function HEAD() {
  return new NextResponse(null, { status: 204 })
}
