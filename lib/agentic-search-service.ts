"use client"

/**
 * agentic-search-service — client adapter for POST /api/search/agentic.
 *
 * The endpoint is SSE: every batch / status / final-summary event
 * is a `data: {...}\n\n` frame. We expose:
 *
 *   - `runStream` — fire-and-forget callbacks (batch / status / done)
 *     for the chat-interface integration that just wants to keep a
 *     single message bubble in sync.
 *   - `runIterator` — async generator for any caller that wants to
 *     `for await` the events directly (e.g. a dedicated UI panel).
 *
 * Why a stand-alone service (instead of folding into web-search-service):
 * the existing /api/search/web flow is the legacy AI-search path; the
 * agentic flow has a different event vocabulary and lifecycle. Mixing
 * them under one service-level type would force every caller to pay
 * for the union — easier to keep them independent.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface AgenticSource {
  source: string
  title: string
  authors?: string[]
  year?: number
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  doi?: string
  url?: string
  pdfUrl?: string
  abstract?: string
  citationCount?: number
  openAccess?: boolean
  rerankScore?: number
}

export type AgenticEvent =
  | { type: "start"; query: string; target: number; batchSize: number; topK: number; providers: string[]; startedAt: number }
  | { type: "batch"; batchN: number; round: number; provider: string; requested: number; received: number; unique: number; duplicates: number; totalCollected: number; target: number; sources: AgenticSource[] }
  | { type: "batch_error"; batchN: number; provider: string; error: string; totalCollected: number }
  | { type: "provider_done"; provider: string; contributed: number; reason: string }
  | { type: "collection_done"; totalCollected: number; deduped: number; requestedCalls: number; providerStats: Record<string, { contributed: number; errors: number; exhausted: boolean; offset: number }>; elapsedMs: number }
  | { type: "ranking_start"; message: string; pool: number; topK: number }
  | { type: "rerank_error"; error: string }
  | { type: "selected"; topK: number; rerankerWasUsed: boolean; sources: AgenticSource[] }
  | { type: "summary"; markdown: string }
  | { type: "done"; stats: { totalCollected: number; dedupedCount: number; selectedCount: number; elapsedMs?: number; rerankerWasUsed?: boolean } }
  | { type: "saved"; dbMessage: any }
  | { type: "persist_error"; error: string }
  | { type: "aborted"; reason: string; provider?: string; round?: number }
  | { type: "error"; message: string }

export interface AgenticRunArgs {
  query: string
  chatId?: string
  target?: number          // 10..1000, default 500
  batchSize?: number       // 5..50, default 10
  topK?: number            // 1..100, default 25
  providers?: string[]     // subset of [scopus, openalex, scielo, semantic, crossref, pubmed, doaj]
  language?: string
  signal?: AbortSignal
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Async iterator over SSE events. Throws on network / HTTP errors.
 * `signal` lets the caller cancel mid-run; the server handler tears
 * down the orchestrator on `req.on("close")`.
 */
export async function* runIterator(args: AgenticRunArgs): AsyncGenerator<AgenticEvent> {
  const { signal, ...body } = args
  const resp = await fetch(`${API_ROOT}/search/agentic`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const j = await resp.json()
      if (j?.error) msg = j.error
      else if (j?.errors?.[0]?.msg) msg = j.errors[0].msg
    } catch {
      /* non-JSON */
    }
    throw new Error(msg)
  }
  if (!resp.body) throw new Error("Stream body missing")

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = raw.split("\n").find(l => l.startsWith("data: "))
        if (!dataLine) continue
        try {
          yield JSON.parse(dataLine.slice(6)) as AgenticEvent
        } catch {
          /* malformed frame — skip */
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * Callback wrapper. The chat-interface uses this — single
 * mutate-the-message-bubble callback so the UI doesn't need to
 * understand every event type.
 */
export async function runStream(
  args: AgenticRunArgs,
  callbacks: {
    onEvent?: (evt: AgenticEvent) => void
    onProgressText?: (text: string) => void   // appendable progress lines
    onSummary?: (markdown: string) => void    // final markdown report
    onSelected?: (sources: AgenticSource[]) => void
    onDone?: (stats: { totalCollected: number; dedupedCount: number; selectedCount: number; elapsedMs?: number }) => void
    onError?: (err: Error) => void
  } = {},
): Promise<void> {
  try {
    for await (const evt of runIterator(args)) {
      callbacks.onEvent?.(evt)
      switch (evt.type) {
        case "start":
          callbacks.onProgressText?.(
            `🤖 **Iniciando búsqueda agéntica:** "${evt.query}"\n` +
            `   Objetivo: ${evt.target} fuentes · Lote: ${evt.batchSize} · Top final: ${evt.topK}\n` +
            `   Proveedores: ${evt.providers.join(", ")}\n\n`
          )
          break
        case "batch":
          callbacks.onProgressText?.(
            `🟡 \`[${String(evt.batchN).padStart(2, "0")}]\` **${evt.provider}** → +${evt.unique} nuevas` +
            (evt.duplicates > 0 ? ` (·${evt.duplicates} dup)` : "") +
            ` · ${evt.totalCollected}/${evt.target}\n`
          )
          break
        case "batch_error":
          callbacks.onProgressText?.(`⚠️ \`[${evt.batchN}]\` ${evt.provider} falló: ${evt.error}\n`)
          break
        case "provider_done":
          callbacks.onProgressText?.(`✓ **${evt.provider}** agotado (${evt.contributed} contribuidas, ${evt.reason})\n`)
          break
        case "collection_done":
          callbacks.onProgressText?.(
            `\n✅ **Recopilación completa:** ${evt.totalCollected} fuentes ` +
            `(${evt.deduped} únicas) en ${(evt.elapsedMs / 1000).toFixed(1)}s\n\n`
          )
          break
        case "ranking_start":
          callbacks.onProgressText?.(`🧠 ${evt.message}\n\n`)
          break
        case "rerank_error":
          callbacks.onProgressText?.(`⚠️ Reranking parcial: ${evt.error} (se usa orden heurístico)\n`)
          break
        case "selected":
          callbacks.onSelected?.(evt.sources)
          callbacks.onProgressText?.(`✨ **Top ${evt.topK} seleccionado**${evt.rerankerWasUsed ? " con reranker LLM" : " (heurístico)"}.\n\n---\n\n`)
          break
        case "summary":
          callbacks.onSummary?.(evt.markdown)
          break
        case "done":
          callbacks.onDone?.(evt.stats)
          break
        case "aborted":
          callbacks.onProgressText?.(`\n🛑 Búsqueda cancelada (${evt.reason}).\n`)
          break
        case "error":
          callbacks.onError?.(new Error(evt.message))
          break
        default:
          break
      }
    }
  } catch (err: any) {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err?.message || err)))
  }
}

export const agenticSearchService = { runStream, runIterator }
