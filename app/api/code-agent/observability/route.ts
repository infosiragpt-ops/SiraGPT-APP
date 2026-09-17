/**
 * code-agent · observability store API.
 *
 * - POST /api/code-agent/observability: append one run to the daily JSONL log
 *   under `.data/code-agent/observability/`. Server-only (uses `node:fs` via
 *   the store helper), so it must NOT be imported by any client bundle.
 * - GET /api/code-agent/observability: return the stored line count and a
 *   small tail (newest lines) for debugging.
 *
 * Writes are best-effort: a failure to persist never fails the request loudly.
 */
import { NextResponse, type NextRequest } from "next/server"
import { appendObservabilityLine, readObservabilityLines } from "@/lib/code-agent/observability-store"

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 })
  }
  const run = (body as { run?: unknown })?.run
  if (run == null) {
    return NextResponse.json({ ok: false, error: "missing run" }, { status: 400 })
  }
  const persisted = appendObservabilityLine(run)
  return NextResponse.json({ ok: persisted, stored: persisted ? 1 : 0 })
}

export async function GET() {
  const lines = readObservabilityLines()
  return NextResponse.json({
    ok: true,
    stored: lines.length,
    tail: lines.slice(-5),
  })
}