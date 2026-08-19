"use client"

import { authenticatedFetch } from "./authenticated-fetch"
import { streamSseJson } from "./sse-client"
import { getNormalizedApiBaseUrl } from "./api-base-url"

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

const API_ROOT = getNormalizedApiBaseUrl()

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
  retrievalScore?: number
  qualityScore?: number
  sources?: string[]
  sourceCount?: number
  doiStatus?: "missing" | "format_valid" | "format_invalid"
  publicationStage?: "preprint" | "published_article" | "conference_paper" | "thesis" | "dataset" | "unknown"
  peerReviewStatus?: "confirmed" | "likely_peer_reviewed" | "not_peer_reviewed" | "unknown"
  studyType?: string
  integrityStatus?: "clear" | "corrected" | "expression_of_concern" | "withdrawn" | "retracted" | "unknown"
  integrityAlerts?: string[]
  doiResolutionStatus?: "resolved" | "not_found" | "timeout" | "unavailable" | "aborted" | "invalid" | "missing"
  doiResolvedUrl?: string
  doiResolutionHttpStatus?: number
  doiCheckedAt?: string
  doiResolutionCacheHit?: boolean
  editorialStatus?: string
  screening?: { decision: "include" | "exclude" | "uncertain"; reasons: string[]; stage: string }
  riskOfBias?: { level: "high" | "some_concerns" | "unknown"; basis: string; recommendedTool: string; requiresFullTextAssessment: boolean }
}

export interface AgenticSystematicReview {
  protocol: {
    active: boolean
    framework?: "pico" | "spider" | null
    fields: Record<string, string>
    missingFields: string[]
    searchExpression: string
    inclusionCriteria: { automatic: string[]; manual: string[] }
    exclusionCriteria: { automatic: string[]; manual: string[] }
    scope: string
    fullTextReviewRequired: boolean
  }
  prisma: {
    scope: string
    identification: { recordsIdentified: number }
    deduplication: { uniqueRecords: number; duplicatesRemoved: number }
    screening: { recordsScreened: number; recordsExcluded: number; recordsUncertain: number; exclusionReasons: Record<string, number> }
    retrieval: { reportsSought: number; fullTextAssessmentPending: number }
    eligibility: { fullTextReportsAssessed: number; fullTextReportsExcluded: number }
    included: { studiesInPreliminarySynthesis: number }
  }
  certainty: { level: string; basis: string; reasons: string[]; requiresFullTextAssessment: boolean }
  screeningDecisions: Array<{ source: string; title: string; doi?: string | null; year?: number | null; screening: AgenticSource["screening"] }>
}

export interface AgenticDiscipline {
  id: string
  label: string
  confidence: "explicit" | "high" | "medium" | "low" | "default"
  score: number
  matchedTerms: string[]
  controlledVocabulary: string[]
  providerPriority: string[]
  explicit: boolean
}

export interface AgenticSearchLimits {
  requestedTarget: number
  batchSize: number
  maxCandidates: number
  maxRounds: number
  queryVariants: number
  providerCount: number
}

export interface AgenticProviderStats {
  contributed: number
  confirmations?: number
  errors: number
  exhausted: boolean
  offset: number
  calls: number
  durationMs: number
  received: number
  filtered: number
  selected: number
  meanSelectedQuality: number | null
}

export type AgenticEvent =
  | { type: "start"; query: string; target: number; batchSize: number; topK: number; providers: string[]; queries?: string[]; filters?: Record<string, unknown>; language?: string; discipline?: AgenticDiscipline; limits?: AgenticSearchLimits; protocol?: AgenticSystematicReview["protocol"]; startedAt: number }
  | { type: "batch"; batchN: number; round: number; provider: string; query?: string; requested: number; received: number; unique: number; duplicates: number; confirmations?: number; filtered?: number; totalCollected: number; target: number; sources: AgenticSource[] }
  | { type: "batch_error"; batchN: number; provider: string; error: string; totalCollected: number }
  | { type: "provider_done"; provider: string; contributed: number; reason: string; calls?: number; received?: number; filtered?: number; errors?: number; durationMs?: number }
  | { type: "collection_done"; totalCollected: number; totalMatches?: number; deduped: number; filtered?: number; integrityFiltered?: number; queries?: string[]; filters?: Record<string, unknown>; discipline?: AgenticDiscipline; stopReason?: string; roundsExecuted?: number; limits?: AgenticSearchLimits; requestedCalls: number; providerStats: Record<string, AgenticProviderStats>; elapsedMs: number }
  | { type: "ranking_start"; message: string; pool: number; candidatePool?: number; topK: number }
  | { type: "rerank_error"; error: string }
  | { type: "validation_start"; message: string; candidates: number }
  | { type: "validation_done"; resolved: number; notFound: number; unavailable: number }
  | { type: "validation_error"; error: string }
  | ({ type: "systematic_review" } & AgenticSystematicReview)
  | { type: "selected"; topK: number; rerankerWasUsed: boolean; sources: AgenticSource[] }
  | { type: "summary"; markdown: string }
  | { type: "done"; stats: { totalCollected: number; totalMatches?: number; dedupedCount: number; selectedCount: number; validatedCount?: number; validDoiCount?: number; resolvedDoiCount?: number; unresolvedDoiCount?: number; preprintCount?: number; integrityFilteredCount?: number; systematicReview?: boolean; screeningExcludedCount?: number; screeningUncertainCount?: number; elapsedMs?: number; rerankerWasUsed?: boolean; searchAudit?: { stopReason: string; target: number; targetReached: boolean; roundsExecuted: number; requestedCalls: number; returnedMatches: number; uniqueCandidates: number; filtered: number; integrityFiltered: number; limits: AgenticSearchLimits; discipline: AgenticDiscipline; providers: Record<string, AgenticProviderStats> } } }
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
  providers?: string[]     // subset of the worldwide scientific provider registry
  language?: string
  discipline?: string
  resolveDois?: boolean
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
  const resp = await authenticatedFetch(`${API_ROOT}/search/agentic`, {
    method: "POST",
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

  for await (const event of streamSseJson<AgenticEvent>(resp.body, { signal })) {
    yield event
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
            (evt.discipline && evt.discipline.id !== "general" ? `   Área: ${evt.discipline.label} · vocabulario controlado: ${evt.discipline.controlledVocabulary.length}\n` : "") +
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
        case "validation_start":
          callbacks.onProgressText?.(`🔎 ${evt.message}\n`)
          break
        case "validation_done":
          callbacks.onProgressText?.(`✓ DOI comprobados: ${evt.resolved} resueltos, ${evt.notFound} no localizados, ${evt.unavailable} no disponibles.\n\n`)
          break
        case "validation_error":
          callbacks.onProgressText?.(`⚠️ La comprobación DOI no pudo completarse: ${evt.error}\n`)
          break
        case "systematic_review":
          callbacks.onProgressText?.(
            `📋 **Cribado sistemático:** ${evt.prisma.screening.recordsScreened} registros · ` +
            `${evt.prisma.screening.recordsExcluded} excluidos · ${evt.prisma.screening.recordsUncertain} en duda.\n\n`
          )
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
