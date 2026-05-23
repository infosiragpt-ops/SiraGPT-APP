/**
 * map-reduce — exhaustive analysis pipeline for documents that don't fit
 * in a single LLM context window.
 *
 * Rationale
 * ---------
 * The default RAG path retrieves top-K chunks and feeds them to the model.
 * That works for "what does the doc say about X?" but fails for queries that
 * inherently require reading the full document:
 *
 *   - "compara la sección 3 con la 7"
 *   - "cuántos casos de fraude aparecen en total"
 *   - "lista todos los nombres de empresas mencionadas"
 *   - "resume cada capítulo"
 *
 * For these queries we run a map-reduce pipeline:
 *
 *   map    → for every chunk emit a partial answer + evidence + confidence
 *   reduce → consolidate partials into a single grounded answer with citations
 *
 * Public surface
 * --------------
 *   classifyQuery(query)            → { mode, score, matchedKeywords }
 *   shouldUseMapReduce(query, opts) → boolean
 *   mapPhase(doc, query, chunks)    → { results: PartialResult[], stats }
 *   reducePhase(query, mapResults)  → { answer, citations, confidence, stats }
 *   runMapReduce(opts)              → full pipeline w/ cache, cost cap, SSE
 *   createMapReduceCache(opts)      → bounded LRU keyed by (docId, queryHash)
 *
 * The module accepts an injected `llm` adapter so tests can mock it. The
 * adapter must expose:
 *
 *   await llm.complete({ system, prompt, maxTokens }) → { text, usage }
 *
 * where `usage` is `{ promptTokens, completionTokens }`.
 */

"use strict";

const crypto = require("crypto");

// ────────────────────────────────────────────────────────────────────────────
// Classifier
// ────────────────────────────────────────────────────────────────────────────

/**
 * Keyword groups that strongly signal the user wants exhaustive coverage.
 * Each entry is normalized (lower-case, no diacritics) before matching.
 */
const EXHAUSTIVE_KEYWORDS = Object.freeze([
  // Spanish — totals & enumeration
  "todos", "todas", "total", "totales", "cuantos", "cuantas",
  "lista completa", "lista todas", "lista todos",
  "enumera", "enumerar", "enumeracion",
  "cuenta", "contar", "cuantifica", "cuantificar",
  "compara", "comparar", "comparacion", "diferencias", "similitudes",
  "resumen completo", "resume todo", "resume cada",
  "cada capitulo", "cada seccion", "cada parte",
  "exhaustivo", "exhaustiva",
  // English — totals & enumeration
  "all of", "every", "each", "list all", "list every",
  "how many", "count all", "count of",
  "compare", "contrast", "differences between",
  "summarize each", "summarize every", "full summary",
  "exhaustive",
]);

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Classify a query as either "exhaustive" (needs map-reduce) or
 * "retrieval" (top-K retrieval is sufficient).
 *
 * The score is the count of distinct keyword/phrase matches. We use a
 * conservative threshold (≥1) because false positives are cheap-ish
 * (slightly more cost) while false negatives are expensive (wrong answer).
 */
function classifyQuery(query) {
  const text = normalizeText(query);
  if (!text) return { mode: "retrieval", score: 0, matchedKeywords: [] };

  const matched = [];
  for (const kw of EXHAUSTIVE_KEYWORDS) {
    if (kw.includes(" ")) {
      if (text.includes(kw)) matched.push(kw);
    } else {
      // word-boundary match for single tokens to avoid e.g. "todos" inside
      // an unrelated word.
      const re = new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`);
      if (re.test(text)) matched.push(kw);
    }
  }

  const score = matched.length;
  return {
    mode: score >= 1 ? "exhaustive" : "retrieval",
    score,
    matchedKeywords: matched,
  };
}

function shouldUseMapReduce(query, { minScore = 1 } = {}) {
  const { score } = classifyQuery(query);
  return score >= minScore;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────────────

function hashQuery(query) {
  return crypto
    .createHash("sha256")
    .update(normalizeText(query))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Bounded LRU cache keyed by `${docId}:${queryHash}`. Stores the final
 * reduce output along with map partials so a hit can short-circuit the
 * whole pipeline.
 */
function createMapReduceCache({ maxEntries = 256, ttlMs = 60 * 60 * 1000 } = {}) {
  const store = new Map();

  function makeKey(docId, query) {
    return `${docId}:${hashQuery(query)}`;
  }

  function get(docId, query) {
    const key = makeKey(docId, query);
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > ttlMs) {
      store.delete(key);
      return null;
    }
    // refresh LRU order
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(docId, query, value) {
    const key = makeKey(docId, query);
    if (store.has(key)) store.delete(key);
    store.set(key, { value, storedAt: Date.now() });
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
  }

  function clear() { store.clear(); }
  function size() { return store.size; }

  return { get, set, clear, size, makeKey };
}

// ────────────────────────────────────────────────────────────────────────────
// Cost accounting
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-million-token pricing snapshot. The caller can override via
 * `pricing` in `runMapReduce` if a different model is used.
 *
 * These are conservative defaults — actual cost tracking should pull
 * from the provider's billing layer; this is just for the per-query cap.
 */
const DEFAULT_PRICING = Object.freeze({
  inputPerMillion: 3.0,    // USD per 1M input tokens
  outputPerMillion: 15.0,  // USD per 1M output tokens
});

function estimateUsdCost(usage, pricing = DEFAULT_PRICING) {
  const inTok = usage.promptTokens || 0;
  const outTok = usage.completionTokens || 0;
  return (inTok / 1_000_000) * pricing.inputPerMillion +
         (outTok / 1_000_000) * pricing.outputPerMillion;
}

function readCostCapUsd() {
  const raw = process.env.MAP_REDUCE_MAX_USD;
  if (!raw) return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5;
}

class CostCapExceededError extends Error {
  constructor(spentUsd, capUsd) {
    super(`map-reduce cost cap exceeded: $${spentUsd.toFixed(4)} > $${capUsd.toFixed(4)}`);
    this.name = "CostCapExceededError";
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Map phase
// ────────────────────────────────────────────────────────────────────────────

const MAP_SYSTEM_PROMPT =
  "You are a careful analyst. You will receive ONE chunk of a larger " +
  "document and a user question. Answer ONLY from this chunk. If the " +
  "chunk does not address the question, say so. Output strict JSON with " +
  "keys: evidence (array of short verbatim quotes), partial_answer (string), " +
  "confidence (number 0..1). No prose outside the JSON.";

function buildMapPrompt(query, chunk) {
  const chunkText = typeof chunk === "string" ? chunk : chunk.text || "";
  const chunkId = typeof chunk === "object" && chunk ? (chunk.id || chunk.chunk_id || "") : "";
  return [
    `Question: ${query}`,
    "",
    `Chunk${chunkId ? ` [${chunkId}]` : ""}:`,
    "<<<",
    chunkText,
    ">>>",
    "",
    "Respond with strict JSON only.",
  ].join("\n");
}

/**
 * Best-effort JSON extraction. LLMs occasionally wrap output in markdown
 * fences or trailing prose. We tolerate that.
 */
function parseMapOutput(text) {
  if (!text || typeof text !== "string") return null;
  let candidate = text.trim();

  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const sliced = candidate.slice(firstBrace, lastBrace + 1);

  try {
    const obj = JSON.parse(sliced);
    if (typeof obj !== "object" || obj === null) return null;
    return {
      evidence: Array.isArray(obj.evidence) ? obj.evidence.map(String) : [],
      partial_answer: typeof obj.partial_answer === "string" ? obj.partial_answer : "",
      confidence: typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Run the map phase. For each chunk we ask the LLM to extract evidence
 * relevant to the query.
 *
 * Concurrency is bounded — the LLM provider is the bottleneck and
 * unbounded fan-out triggers rate limits.
 */
async function mapPhase(doc, query, chunks, {
  llm,
  concurrency = 4,
  costTracker = null,
  costCapUsd = readCostCapUsd(),
  pricing = DEFAULT_PRICING,
  onProgress = null,
  signal = null,
} = {}) {
  if (!llm || typeof llm.complete !== "function") {
    throw new TypeError("mapPhase requires an llm adapter with .complete()");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { results: [], stats: { mapped: 0, skipped: 0, usage: { promptTokens: 0, completionTokens: 0 }, costUsd: 0 } };
  }

  const results = new Array(chunks.length);
  const usage = { promptTokens: 0, completionTokens: 0 };
  let costUsd = costTracker ? costTracker.spentUsd : 0;
  let skipped = 0;
  let mapped = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const idx = cursor++;
      if (signal && signal.aborted) {
        skipped++;
        continue;
      }
      if (costUsd >= costCapUsd) {
        skipped++;
        continue;
      }
      const chunk = chunks[idx];
      const prompt = buildMapPrompt(query, chunk);
      let resp;
      try {
        resp = await llm.complete({
          system: MAP_SYSTEM_PROMPT,
          prompt,
          maxTokens: 400,
        });
      } catch (err) {
        results[idx] = {
          chunkId: chunkIdOf(chunk, idx),
          ok: false,
          error: err && err.message ? err.message : String(err),
          evidence: [],
          partial_answer: "",
          confidence: 0,
        };
        skipped++;
        continue;
      }
      const u = resp && resp.usage ? resp.usage : { promptTokens: 0, completionTokens: 0 };
      usage.promptTokens += u.promptTokens || 0;
      usage.completionTokens += u.completionTokens || 0;
      const stepCost = estimateUsdCost(u, pricing);
      costUsd += stepCost;
      if (costTracker) costTracker.spentUsd = costUsd;

      const parsed = parseMapOutput(resp && resp.text);
      if (!parsed) {
        results[idx] = {
          chunkId: chunkIdOf(chunk, idx),
          ok: false,
          error: "unparsable map output",
          evidence: [],
          partial_answer: "",
          confidence: 0,
        };
        skipped++;
      } else {
        results[idx] = {
          chunkId: chunkIdOf(chunk, idx),
          ok: true,
          ...parsed,
        };
        mapped++;
      }

      if (typeof onProgress === "function") {
        try {
          onProgress({
            type: "map_progress",
            mapped,
            skipped,
            total: chunks.length,
            costUsd,
            chunkId: results[idx].chunkId,
          });
        } catch { /* swallow listener errors */ }
      }

      if (costUsd >= costCapUsd) {
        // Soft-stop: remaining chunks will be skipped by the loop guard.
        // We don't throw because partial results are still useful.
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, () => worker());
  await Promise.all(workers);

  // Compact the results: holes (chunks skipped before being assigned) are
  // surfaced as not-ok entries so the reducer can still see total coverage.
  const compact = [];
  for (let i = 0; i < chunks.length; i++) {
    if (results[i]) {
      compact.push(results[i]);
    } else {
      compact.push({
        chunkId: chunkIdOf(chunks[i], i),
        ok: false,
        error: "skipped (cost cap or abort)",
        evidence: [],
        partial_answer: "",
        confidence: 0,
      });
    }
  }

  return {
    results: compact,
    stats: { mapped, skipped, usage, costUsd, total: chunks.length, docId: doc && doc.id },
  };
}

function chunkIdOf(chunk, idx) {
  if (chunk && typeof chunk === "object") {
    return chunk.id || chunk.chunk_id || `chunk-${idx}`;
  }
  return `chunk-${idx}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Reduce phase
// ────────────────────────────────────────────────────────────────────────────

const REDUCE_SYSTEM_PROMPT =
  "You are a synthesizer. You will receive a user question and an array " +
  "of partial findings extracted from different chunks of one document. " +
  "Consolidate them into a single, well-grounded answer. Cite chunk IDs " +
  "in square brackets next to each claim, e.g. [chunk-3]. If findings " +
  "conflict, surface the conflict. Output strict JSON with keys: " +
  "answer (string with inline [chunk-id] citations), citations (array of " +
  "chunk IDs you actually used), confidence (number 0..1).";

function buildReducePrompt(query, mapResults) {
  const useful = mapResults.filter(r => r.ok && (r.partial_answer || r.evidence.length));
  const lines = [
    `Question: ${query}`,
    "",
    `Partial findings (${useful.length} of ${mapResults.length} chunks contributed):`,
  ];
  for (const r of useful) {
    lines.push(JSON.stringify({
      chunk_id: r.chunkId,
      partial_answer: r.partial_answer,
      evidence: r.evidence,
      confidence: r.confidence,
    }));
  }
  lines.push("", "Respond with strict JSON only.");
  return lines.join("\n");
}

function parseReduceOutput(text) {
  if (!text || typeof text !== "string") return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const obj = JSON.parse(candidate.slice(first, last + 1));
    if (!obj || typeof obj !== "object") return null;
    return {
      answer: typeof obj.answer === "string" ? obj.answer : "",
      citations: Array.isArray(obj.citations) ? obj.citations.map(String) : [],
      confidence: typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0,
    };
  } catch {
    return null;
  }
}

async function reducePhase(query, mapResults, {
  llm,
  costTracker = null,
  costCapUsd = readCostCapUsd(),
  pricing = DEFAULT_PRICING,
  onProgress = null,
} = {}) {
  if (!llm || typeof llm.complete !== "function") {
    throw new TypeError("reducePhase requires an llm adapter with .complete()");
  }
  if (typeof onProgress === "function") {
    try { onProgress({ type: "reduce_started", contributing: mapResults.filter(r => r.ok).length }); }
    catch { /* swallow */ }
  }

  const remaining = costCapUsd - (costTracker ? costTracker.spentUsd : 0);
  if (remaining <= 0) {
    return {
      answer: "",
      citations: [],
      confidence: 0,
      stats: {
        usage: { promptTokens: 0, completionTokens: 0 },
        costUsd: costTracker ? costTracker.spentUsd : 0,
        skipped: true,
        reason: "cost_cap_exhausted_before_reduce",
      },
    };
  }

  const prompt = buildReducePrompt(query, mapResults);
  const resp = await llm.complete({
    system: REDUCE_SYSTEM_PROMPT,
    prompt,
    maxTokens: 1200,
  });
  const u = resp && resp.usage ? resp.usage : { promptTokens: 0, completionTokens: 0 };
  const stepCost = estimateUsdCost(u, pricing);
  if (costTracker) costTracker.spentUsd += stepCost;

  const parsed = parseReduceOutput(resp && resp.text) || {
    answer: "",
    citations: [],
    confidence: 0,
  };

  return {
    ...parsed,
    stats: {
      usage: u,
      costUsd: costTracker ? costTracker.spentUsd : stepCost,
      skipped: false,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Full pipeline: classify → cache lookup → map → reduce → cache write.
 *
 * Streams events via `onEvent`:
 *   { type: "classified", mode, score, matchedKeywords }
 *   { type: "cache_hit",  source }                         (only when hit)
 *   { type: "map_started", total }
 *   { type: "map_progress", mapped, skipped, total, costUsd, chunkId }
 *   { type: "reduce_started", contributing }
 *   { type: "done", answer, costUsd, durationMs }
 *
 * The exact event shape is stable — `chat-controller.js` can forward
 * these to SSE without translation.
 */
async function runMapReduce({
  doc,
  query,
  chunks,
  llm,
  cache = null,
  costCapUsd = readCostCapUsd(),
  pricing = DEFAULT_PRICING,
  concurrency = 4,
  onEvent = null,
  signal = null,
  forceMode = null,
} = {}) {
  if (!doc || !doc.id) throw new TypeError("runMapReduce requires doc.id");
  if (!query || typeof query !== "string") throw new TypeError("runMapReduce requires a query string");
  if (!Array.isArray(chunks)) throw new TypeError("runMapReduce requires chunks array");

  const start = Date.now();
  const emit = (ev) => {
    if (typeof onEvent === "function") {
      try { onEvent(ev); } catch { /* swallow */ }
    }
  };

  const classification = classifyQuery(query);
  const mode = forceMode || classification.mode;
  emit({ type: "classified", ...classification, mode });

  if (mode !== "exhaustive") {
    return {
      mode,
      classification,
      skipped: true,
      reason: "query classified as retrieval",
    };
  }

  if (cache) {
    const hit = cache.get(doc.id, query);
    if (hit) {
      emit({ type: "cache_hit", source: "map_reduce_cache" });
      return { ...hit, fromCache: true, durationMs: Date.now() - start };
    }
  }

  const costTracker = { spentUsd: 0 };

  emit({ type: "map_started", total: chunks.length });
  const mapOut = await mapPhase(doc, query, chunks, {
    llm,
    concurrency,
    costTracker,
    costCapUsd,
    pricing,
    signal,
    onProgress: emit,
  });

  const reduceOut = await reducePhase(query, mapOut.results, {
    llm,
    costTracker,
    costCapUsd,
    pricing,
    onProgress: emit,
  });

  const result = {
    mode: "exhaustive",
    classification,
    answer: reduceOut.answer,
    citations: reduceOut.citations,
    confidence: reduceOut.confidence,
    mapResults: mapOut.results,
    stats: {
      mapped: mapOut.stats.mapped,
      skipped: mapOut.stats.skipped,
      total: mapOut.stats.total,
      costUsd: costTracker.spentUsd,
      costCapUsd,
      reduceSkipped: reduceOut.stats.skipped,
      durationMs: Date.now() - start,
    },
  };

  if (cache) cache.set(doc.id, query, result);
  emit({ type: "done", answer: result.answer, costUsd: result.stats.costUsd, durationMs: result.stats.durationMs });
  return result;
}

module.exports = {
  // classifier
  classifyQuery,
  shouldUseMapReduce,
  EXHAUSTIVE_KEYWORDS,
  // cache
  createMapReduceCache,
  hashQuery,
  // phases
  mapPhase,
  reducePhase,
  // orchestrator
  runMapReduce,
  // cost
  estimateUsdCost,
  DEFAULT_PRICING,
  CostCapExceededError,
  // internals exported for tests
  _internal: {
    parseMapOutput,
    parseReduceOutput,
    buildMapPrompt,
    buildReducePrompt,
    normalizeText,
  },
};
