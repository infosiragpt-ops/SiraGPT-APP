/**
 * context-compactor — first-class contract for shrinking the context
 * a single chat turn carries into the model. Closes gap §14.6 in
 * docs/architecture/PIPELINE.md.
 *
 * Why this exists
 * ---------------
 * Context shrinking has been split across three places:
 *   - `services/context-window.js` (`fitMessagesToContext`) — token
 *     budget + head/tail preservation + breadcrumb on truncation.
 *   - `services/gist-memory.js` — triple-shaped long-term memory.
 *   - `task-envelope-builder.js` — picks history + memory + RAG and
 *     hands it to downstream modules.
 *
 * Each piece has its own contract, but no single module owns the
 * decision "given a turn, here is the smallest context that still
 * captures the user's intent." `compactContext` is that owner. It
 * delegates to the existing modules — does not reimplement them —
 * and returns one report a caller can act on.
 *
 * Pipeline (left-to-right; each step preserves the contract of the
 * previous):
 *
 *     raw turn input
 *           │
 *           ▼
 *     1. dedupe near-identical messages (content-hash, exact only —
 *        no embedding-based dedup yet, that lives in RAG)
 *           │
 *           ▼
 *     2. fit messages to model context window (existing
 *        `fitMessagesToContext`)
 *           │
 *           ▼
 *     3. summarize the dropped middle when a `summarizer` is
 *        injected; otherwise emit a breadcrumb only
 *           │
 *           ▼
 *     4. rank RAG chunks by score, cap at `maxChunks`
 *           │
 *           ▼
 *     5. cap memory gists at `maxGists` (gist-memory already
 *        prunes; here we apply the per-turn ceiling)
 *           │
 *           ▼
 *     compacted context + report
 *
 * Caller passes `summarizer` when an LLM client is available; the
 * default behaviour is fully deterministic so this module is unit-
 * testable offline. The `task-envelope-builder` is the planned first
 * integration site; until then `compactContext` stands alone with a
 * clean contract.
 */

const {
  fitMessagesToContext,
  estimateTokens,
  getCompletionLimit,
  normalizeReservedCompletionTokens,
} = require("../context-window");
const { buildCompactionPreamble } = require("../agents/hermes-context-patterns");

const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_MAX_GISTS = 12;
const DEFAULT_RESERVED_COMPLETION_TOKENS = 1024;
// Share of the model's completion limit that summarizer output may consume.
// Keeps the model's response budget free even on long-history compactions.
const DEFAULT_SUMMARY_OUTPUT_SHARE = 0.25;
// Floor below which summarizer output is no longer useful.
const MIN_SUMMARY_OUTPUT_TOKENS = 256;

/**
 * Clamp the requested reserve for a summarizer's output to what the
 * target model can actually emit in a single response. Mirrors the
 * fix openclaw v2026.5.7 shipped: high-context compaction must not
 * request `max_tokens` greater than the model's output ceiling.
 *
 * The result is the minimum of:
 *   - the caller's requested reserve,
 *   - `share * getCompletionLimit(model)` (default 25%),
 *   - the model's hard completion ceiling.
 *
 * Floored at MIN_SUMMARY_OUTPUT_TOKENS unless the model's own ceiling
 * is even smaller (in which case the model wins).
 */
function clampSummaryReserve(reservedCompletionTokens, model, share = DEFAULT_SUMMARY_OUTPUT_SHARE) {
  const requested = Number(reservedCompletionTokens);
  const safeRequested = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : DEFAULT_RESERVED_COMPLETION_TOKENS;
  const ceiling = getCompletionLimit(model);
  const safeShare = Number.isFinite(share) && share > 0 && share <= 1
    ? share
    : DEFAULT_SUMMARY_OUTPUT_SHARE;
  const shareCap = Math.max(1, Math.floor(ceiling * safeShare));
  const capped = Math.min(safeRequested, shareCap, ceiling);
  if (ceiling < MIN_SUMMARY_OUTPUT_TOKENS) return Math.max(1, capped);
  return Math.max(MIN_SUMMARY_OUTPUT_TOKENS, capped);
}

/**
 * Stable content hash for dedup. Cheap and content-only — no role,
 * no metadata — so a system-prompt twin and a user-prompt twin both
 * collapse if their text matches verbatim.
 */
function contentHash(message) {
  if (!message || typeof message.content !== "string") return null;
  // Trivial djb2 — collision risk is acceptable for in-turn dedup
  // (n < 100 messages typical).
  let h = 5381;
  const s = `${message.role || ""}::${message.content}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

/**
 * Drop messages whose content-hash duplicates one already kept.
 * Order-stable: the first occurrence wins. Returns a new array.
 */
function dedupMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    const k = contentHash(m);
    if (k == null) {
      out.push(m);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

/**
 * Rank an array of RAG hits by `score` descending and keep the top
 * `max`. Tolerant of missing scores (treated as -Infinity, sorted to
 * the end). Returns a new array; the input is not mutated.
 */
function rankChunks(chunks, max = DEFAULT_MAX_CHUNKS) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const cap = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_CHUNKS;
  return [...chunks]
    .sort((a, b) => {
      const sa = Number.isFinite(a?.score) ? a.score : -Infinity;
      const sb = Number.isFinite(b?.score) ? b.score : -Infinity;
      return sb - sa;
    })
    .slice(0, cap);
}

/**
 * Cap memory gists. Trivial today (slice); kept as a separate
 * function so a future ranking strategy (recency, relevance score
 * from gist-memory) lands in one place.
 */
function rankGists(gists, max = DEFAULT_MAX_GISTS) {
  if (!Array.isArray(gists) || gists.length === 0) return [];
  const cap = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_GISTS;
  return gists.slice(0, cap);
}

/**
 * Top-level entry point.
 *
 * @param {object}   args
 * @param {Array}    [args.messages=[]]    — raw conversation history (system + user + assistant)
 * @param {string}   [args.model]          — model id; resolves the context window
 * @param {Array}    [args.ragChunks=[]]   — retrieved chunks; objects with `score` field
 * @param {Array}    [args.memoryGists=[]] — long-term memory entries
 * @param {number}   [args.reservedCompletionTokens=1024] — completion budget reservation
 * @param {number}   [args.maxChunks=8]    — RAG cap per turn
 * @param {number}   [args.maxGists=12]    — memory cap per turn
 * @param {Function} [args.summarizer]     — async ({droppedMessages}) → string
 * @returns {Promise<{
 *   messages: Array,
 *   ragChunks: Array,
 *   memoryGists: Array,
 *   summary: string|null,
 *   stats: {
 *     original_messages: number,
 *     deduped_messages: number,
 *     kept_messages: number,
 *     dropped_messages: number,
 *     dedup_collisions: number,
 *     total_tokens: number,
 *     budget: number,
 *     chunks_in: number,
 *     chunks_kept: number,
 *     gists_in: number,
 *     gists_kept: number,
 *     summarized: boolean
 *   }
 * }>}
 */
async function compactContext({
  messages = [],
  model = null,
  ragChunks = [],
  memoryGists = [],
  reservedCompletionTokens = DEFAULT_RESERVED_COMPLETION_TOKENS,
  maxChunks = DEFAULT_MAX_CHUNKS,
  maxGists = DEFAULT_MAX_GISTS,
  summarizer = null,
  summaryOutputShare = DEFAULT_SUMMARY_OUTPUT_SHARE,
} = {}) {
  const originalCount = Array.isArray(messages) ? messages.length : 0;

  // 1. Dedup. Cheap; runs first so the budget calculation downstream
  //    isn't fooled by repeated blocks.
  const deduped = dedupMessages(messages);
  const dedupCollisions = originalCount - deduped.length;

  // 2. Fit to the model's context window. Reuses the existing module
  //    so all of its head/tail/breadcrumb behaviour stays canonical.
  //    Reserve is normalized against both completion-limit and safe
  //    context-budget so we never request more than the model can emit.
  const normalizedReserve = normalizeReservedCompletionTokens(reservedCompletionTokens, model);
  const fitted = fitMessagesToContext(deduped, model, { reservedCompletionTokens: normalizedReserve });
  const droppedCount = fitted.droppedCount || 0;
  // Clamp the summarizer's output budget to a fraction of the model's
  // completion ceiling. This is the openclaw v2026.5.7 fix: callers
  // can pass arbitrary reserves, but the summarizer must never exceed
  // what the model is allowed to emit in a single response.
  const summaryMaxOutputTokens = clampSummaryReserve(normalizedReserve, model, summaryOutputShare);

  // 3. Summarize the dropped middle if a summarizer is wired AND
  //    something was dropped. The summarizer signature is
  //    `(args) => Promise<string>`; we hand it the dropped messages
  //    and let it decide the format. Failures are non-fatal — a
  //    failed summary just leaves `summary = null` and the breadcrumb
  //    that `fitMessagesToContext` already inserted carries the
  //    "n omitted messages" signal.
  let summary = null;
  let summarized = false;
  if (droppedCount > 0 && typeof summarizer === "function") {
    const droppedMessages = sliceDroppedMiddle(deduped, fitted.messages);
    try {
      const result = await summarizer({ droppedMessages, model, maxOutputTokens: summaryMaxOutputTokens });
      if (typeof result === "string" && result.trim()) {
        summary = buildCompactionPreamble({ priorSummary: result.trim() });
        summarized = true;
      }
    } catch (_e) {
      // swallow — observability is the caller's responsibility
      summary = null;
    }
  }

  // 4. Rank + cap RAG and memory.
  const rankedChunks = rankChunks(ragChunks, maxChunks);
  const cappedGists = rankGists(memoryGists, maxGists);

  return {
    messages: fitted.messages || [],
    ragChunks: rankedChunks,
    memoryGists: cappedGists,
    summary,
    stats: {
      original_messages: originalCount,
      deduped_messages: deduped.length,
      kept_messages: (fitted.messages || []).length,
      dropped_messages: droppedCount,
      dedup_collisions: dedupCollisions,
      total_tokens: fitted.totalTokens || 0,
      budget: fitted.budget || 0,
      chunks_in: Array.isArray(ragChunks) ? ragChunks.length : 0,
      chunks_kept: rankedChunks.length,
      gists_in: Array.isArray(memoryGists) ? memoryGists.length : 0,
      gists_kept: cappedGists.length,
      summarized,
      reserved_completion_tokens: normalizedReserve,
      summary_max_output_tokens: summaryMaxOutputTokens,
    },
  };
}

/**
 * Compute which messages from the deduped list got dropped by the
 * window-fitter. Returns the dropped slice in original order.
 *
 * `fitMessagesToContext` may insert a breadcrumb message that wasn't
 * in the input; we filter on hash identity to ignore it.
 */
function sliceDroppedMiddle(beforeFit, afterFit) {
  if (!Array.isArray(beforeFit) || !Array.isArray(afterFit)) return [];
  const keptHashes = new Set();
  for (const m of afterFit) {
    const h = contentHash(m);
    if (h != null) keptHashes.add(h);
  }
  return beforeFit.filter((m) => {
    const h = contentHash(m);
    return h != null && !keptHashes.has(h);
  });
}

module.exports = {
  compactContext,
  // Internal helpers exposed for unit tests + future re-use.
  dedupMessages,
  rankChunks,
  rankGists,
  contentHash,
  estimateTokens,
  clampSummaryReserve,
  // Defaults kept exported so callers / docs reference the canonical
  // numbers.
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_GISTS,
  DEFAULT_RESERVED_COMPLETION_TOKENS,
  DEFAULT_SUMMARY_OUTPUT_SHARE,
  MIN_SUMMARY_OUTPUT_TOKENS,
};
