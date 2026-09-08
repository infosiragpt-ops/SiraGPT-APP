
/** OLA200_WAVE_G FE-096 — mobile RunningChatsBar stop must reach POST /api/ai/stop-stream. */
export function mobileStopStreamUrl(apiRoot = "/api"): string {
  return `${String(apiRoot).replace(/\/$/, "")}/ai/stop-stream`
}
export async function postMobileStopStream(fetchImpl: typeof fetch, args: { chatId?: string | null; runId?: string | null; apiRoot?: string; signal?: AbortSignal } = {}) {
  const url = mobileStopStreamUrl(args.apiRoot)
  try {
    const resp = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ chatId: args.chatId || null, runId: args.runId || null }), signal: args.signal })
    return { ok: resp.ok || resp.status === 404, reached: true, status: resp.status }
  } catch {
    return { ok: false, reached: false, status: 0 }
  }
}
