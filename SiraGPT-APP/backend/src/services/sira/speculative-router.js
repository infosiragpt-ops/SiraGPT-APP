/**
 * speculative-router — adaptive multi-tier model routing.
 *
 * Why this exists
 * ---------------
 * A single-model strategy is wasteful in both directions:
 *   - sending every "hi" to the flagship costs latency + dollars,
 *   - sending every "refactor my codebase" to the cheap tier loses
 *     the user trust.
 *
 * Codex CLI ties the user to one configured model per request.
 * Claude Code lets users toggle models manually but does not learn
 * from the workload. Cortex routes per-request based on a fast,
 * deterministic complexity classifier and falls back through a
 * cascade of providers when one trips a circuit breaker or returns
 * a hard error.
 *
 * Pipeline
 * --------
 *   1. classify(request)     → ComplexityScore { tier, score, reasons }
 *   2. resolveCascade(tier)  → Provider[] (preferred → fallback)
 *   3. invoke(req, cascade)  → first provider that succeeds; tracks
 *                              attempt metadata for downstream stats.
 *
 * The classifier is purely heuristic so the router is unit-testable
 * without an LLM. Callers may inject `learnedClassifier` to plug in
 * a fine-tuned model; when supplied it overrides the heuristic but
 * still passes through the deterministic baseline as a safety net.
 *
 * No code or APIs are copied from any third-party project. The
 * provider cascade contract is intentionally narrow and matches the
 * existing `ProviderRouter` shape used in `backend/src/router/`.
 */

"use strict";

const TIERS = Object.freeze({
  FAST: "fast",       // small/cheap (Haiku, gpt-4o-mini)
  STANDARD: "standard", // mid-range (Sonnet, gpt-4o)
  HEAVY: "heavy",     // flagship (Opus, gpt-5)
});

const DEFAULT_THRESHOLDS = Object.freeze({
  fast: 0.0,
  standard: 0.25,
  heavy: 0.5,
});

// Tokens-per-character estimate is intentionally rough — the classifier
// only needs an order-of-magnitude signal, not an exact count.
const TOKENS_PER_CHAR = 1 / 4;

const HEAVY_MARKERS = [
  /\brefactor(ing)?\b/i,
  /\barchitect\w*\b/i,
  /\bmigrat\w+\b/i,
  /\bplan\b/i,
  /\boptimi[sz]e\b/i,
  /\bsecurity audit\b/i,
  /\bdesign\b.*\b(system|service|architecture)\b/i,
  /\b(prove|derive|theorem|proof)\b/i,
  /\bmulti[- ]?step\b/i,
  /\bend[- ]?to[- ]?end\b/i,
];

const FAST_MARKERS = [
  /^(hi|hola|hey|gracias|thanks|ok|si|no)\b/i,
  /^(what is|qué es|que es|define)\b/i,
  /^(translate|traduce)\b/i,
];

const TOOL_USE_MARKERS = [
  /\b(call|invoke|use)\b.+\b(tool|function|api)\b/i,
  /\b(search|browse|fetch|crawl)\b/i,
  /\b(execute|run)\b.+\b(code|script|command)\b/i,
];

/**
 * Score the complexity of a request on [0,1].
 *
 * @param {object} req
 * @param {string} req.text
 * @param {Array}  [req.history]            — chat history items
 * @param {Array}  [req.attachments]
 * @param {boolean} [req.requiresTools]
 * @returns {{ score: number, tier: string, reasons: string[] }}
 */
function classifyHeuristic(req = {}) {
  const text = typeof req.text === "string" ? req.text : "";
  const reasons = [];
  let score = 0;

  const tokens = Math.ceil(text.length * TOKENS_PER_CHAR);
  if (tokens > 4000) {
    score += 0.4;
    reasons.push(`long_input(${tokens}t)`);
  } else if (tokens > 1200) {
    score += 0.28;
    reasons.push(`mid_input(${tokens}t)`);
  } else if (tokens > 300) {
    score += 0.12;
    reasons.push(`short_input(${tokens}t)`);
  }

  const historyLen = Array.isArray(req.history) ? req.history.length : 0;
  if (historyLen > 30) {
    score += 0.15;
    reasons.push(`long_history(${historyLen})`);
  } else if (historyLen > 10) {
    score += 0.05;
    reasons.push(`mid_history(${historyLen})`);
  }

  const attachments = Array.isArray(req.attachments) ? req.attachments.length : 0;
  if (attachments >= 5) {
    score += 0.2;
    reasons.push(`many_attachments(${attachments})`);
  } else if (attachments > 0) {
    score += 0.1;
    reasons.push(`attachments(${attachments})`);
  }

  let heavyHits = 0;
  for (const re of HEAVY_MARKERS) {
    if (re.test(text)) heavyHits += 1;
  }
  if (heavyHits) {
    score += Math.min(0.5, 0.2 * heavyHits);
    reasons.push(`heavy_markers(${heavyHits})`);
  }

  let fastHits = 0;
  for (const re of FAST_MARKERS) {
    if (re.test(text)) fastHits += 1;
  }
  if (fastHits) {
    score -= 0.25;
    reasons.push(`fast_markers(${fastHits})`);
  }

  let toolHits = 0;
  for (const re of TOOL_USE_MARKERS) {
    if (re.test(text)) toolHits += 1;
  }
  if (toolHits || req.requiresTools === true) {
    score += 0.15;
    reasons.push(`tool_use(${toolHits || "explicit"})`);
  }

  if (score < 0) score = 0;
  if (score > 1) score = 1;

  let tier = TIERS.FAST;
  if (score >= DEFAULT_THRESHOLDS.heavy) tier = TIERS.HEAVY;
  else if (score >= DEFAULT_THRESHOLDS.standard) tier = TIERS.STANDARD;

  return { score, tier, reasons };
}

/**
 * Build a provider cascade for a tier. The cascade orders providers
 * preferred → fallback. Callers may override per call.
 *
 * @param {string} tier
 * @param {object} catalog                  — { fast: string[], standard: string[], heavy: string[] }
 * @returns {string[]}
 */
function resolveCascade(tier, catalog) {
  if (!catalog || typeof catalog !== "object") {
    throw new TypeError("speculative-router.resolveCascade: catalog required");
  }
  const fast = Array.isArray(catalog.fast) ? catalog.fast : [];
  const standard = Array.isArray(catalog.standard) ? catalog.standard : [];
  const heavy = Array.isArray(catalog.heavy) ? catalog.heavy : [];

  if (tier === TIERS.HEAVY) {
    return dedup([...heavy, ...standard, ...fast]);
  }
  if (tier === TIERS.STANDARD) {
    return dedup([...standard, ...heavy, ...fast]);
  }
  return dedup([...fast, ...standard, ...heavy]);
}

function dedup(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string" || !x.length || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * Invoke a provider cascade. The first provider whose `invoke`
 * resolves wins. Errors are classified retryable / fatal via
 * `isRetryable`; fatal errors short-circuit the cascade.
 *
 * @param {object} args
 * @param {object} args.request                    — opaque request
 * @param {string[]} args.cascade                  — provider ids
 * @param {(id: string, req) => Promise<*>} args.invoker
 * @param {(err) => boolean} [args.isRetryable]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ ok: boolean, providerId: string|null, attempts: object[], result?: *, error?: object }>}
 */
async function invokeCascade({ request, cascade, invoker, isRetryable, signal }) {
  if (!Array.isArray(cascade) || !cascade.length) {
    throw new TypeError("speculative-router.invokeCascade: non-empty cascade required");
  }
  if (typeof invoker !== "function") {
    throw new TypeError("speculative-router.invokeCascade: invoker function required");
  }
  const retryablePred = typeof isRetryable === "function" ? isRetryable : defaultIsRetryable;
  const attempts = [];
  let lastError = null;

  for (const providerId of cascade) {
    if (signal && signal.aborted) {
      attempts.push({ providerId, ok: false, error: { name: "AbortError", message: "aborted" } });
      lastError = { name: "AbortError", message: "aborted" };
      break;
    }
    const startedAt = Date.now();
    try {
      const result = await invoker(providerId, request);
      attempts.push({ providerId, ok: true, elapsedMs: Date.now() - startedAt });
      return { ok: true, providerId, attempts, result };
    } catch (err) {
      const serialized = serializeError(err);
      attempts.push({
        providerId,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: serialized,
      });
      lastError = serialized;
      if (!retryablePred(err)) break;
    }
  }
  return { ok: false, providerId: null, attempts, error: lastError };
}

/**
 * One-shot route+invoke. Intended as the main entry point.
 *
 * @param {object} args
 * @param {string} args.text
 * @param {Array}  [args.history]
 * @param {Array}  [args.attachments]
 * @param {boolean} [args.requiresTools]
 * @param {object} args.catalog
 * @param {(id, req) => Promise<*>} args.invoker
 * @param {(req) => Promise<{score:number, tier:string, reasons:string[]}>} [args.learnedClassifier]
 * @param {object} [args.thresholds]
 * @param {(err) => boolean} [args.isRetryable]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ ok: boolean, classification: object, providerId: string|null, attempts: object[], result?: *, error?: object }>}
 */
async function route(args) {
  const {
    text,
    history,
    attachments,
    requiresTools,
    catalog,
    invoker,
    learnedClassifier,
    thresholds,
    isRetryable,
    signal,
  } = args || {};

  const heuristic = classifyHeuristic({ text, history, attachments, requiresTools });
  let classification = heuristic;
  if (typeof learnedClassifier === "function") {
    try {
      const learned = await learnedClassifier({ text, history, attachments, requiresTools });
      classification = mergeClassifications(heuristic, learned, thresholds);
    } catch (_err) {
      // Learned classifier failure → silently fall back to heuristic.
    }
  } else if (thresholds) {
    classification = applyThresholds(heuristic, thresholds);
  }

  const cascade = resolveCascade(classification.tier, catalog);
  const invocation = await invokeCascade({
    request: { text, history, attachments },
    cascade,
    invoker,
    isRetryable,
    signal,
  });

  return Object.freeze({
    ok: invocation.ok,
    classification,
    providerId: invocation.providerId,
    attempts: invocation.attempts,
    result: invocation.result,
    error: invocation.error,
  });
}

function mergeClassifications(heuristic, learned, thresholds) {
  if (!learned || typeof learned !== "object") return heuristic;
  const score = pickScore(learned.score, heuristic.score);
  const reasons = [
    ...(Array.isArray(heuristic.reasons) ? heuristic.reasons : []),
    ...(Array.isArray(learned.reasons) ? learned.reasons : []),
  ];
  const merged = { score, reasons, tier: heuristic.tier };
  return applyThresholds(merged, thresholds);
}

function pickScore(learned, fallback) {
  if (typeof learned !== "number" || !Number.isFinite(learned)) return fallback;
  if (learned < 0) return 0;
  if (learned > 1) return 1;
  return learned;
}

function applyThresholds(classification, thresholds) {
  const t = {
    standard: thresholds && Number.isFinite(thresholds.standard) ? thresholds.standard : DEFAULT_THRESHOLDS.standard,
    heavy: thresholds && Number.isFinite(thresholds.heavy) ? thresholds.heavy : DEFAULT_THRESHOLDS.heavy,
  };
  let tier = TIERS.FAST;
  if (classification.score >= t.heavy) tier = TIERS.HEAVY;
  else if (classification.score >= t.standard) tier = TIERS.STANDARD;
  return { ...classification, tier };
}

function defaultIsRetryable(err) {
  if (!err) return false;
  const code = err.code || (err.cause && err.cause.code);
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") return true;
  const status = err.status || err.statusCode;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (err.name === "AbortError") return false;
  return false;
}

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    status: err.status || err.statusCode || null,
    code: err.code || null,
  };
}

module.exports = {
  TIERS,
  DEFAULT_THRESHOLDS,
  classifyHeuristic,
  resolveCascade,
  invokeCascade,
  route,
  // Exposed for tests
  _internals: { mergeClassifications, applyThresholds, defaultIsRetryable, dedup },
};
