'use strict';

/**
 * misunderstanding-signals
 *
 * Captura señales IMPLÍCITAS de que el sistema no entendió bien al
 * usuario. Sin esto, las mejoras de comprensión vuelan a ciegas: la
 * mayoría de usuarios no da feedback explícito, pero sí abandona,
 * regenera, o reescribe.
 *
 * Detectores (todos puros, sin side effects):
 *   1. regenerate_after_N_tokens  — usuario regenera tras >N tokens producidos
 *      (sugiere "se equivocó tarde")
 *   2. abandoned_stream            — stream abortado por cliente antes de completar
 *   3. manual_prompt_edit          — siguiente turno similar al anterior <60s
 *                                    (el usuario reescribió porque no le gustó)
 *   4. correction_followup         — siguiente turno contiene regex de corrección
 *                                    ("no", "en español", "eso no es")
 *   5. negative_feedback_in_60s    — feedback=disliked en <60s tras la respuesta
 *
 * El módulo expone funciones puras de detección (`detect*`) y un
 * recorder con ring buffer in-memory por usuario + opcional sink
 * Langfuse via `recordGeneration` / `scoreTrace`.
 *
 * Estrictamente fire-and-forget: cualquier excepción se traga.
 */

const MAX_SIGNALS_PER_USER = 200;
const DEFAULT_REGENERATE_TOKENS_THRESHOLD = 50;
const DEFAULT_NEGATIVE_WINDOW_MS = 60_000;
const DEFAULT_EDIT_WINDOW_MS = 60_000;
const DEFAULT_EDIT_SIMILARITY_THRESHOLD = 0.7;

// Correction follow-up regex (multi-language). Capturas comunes que indican
// el usuario está corrigiendo la interpretación previa.
const CORRECTION_FOLLOWUP_RE = /^\s*[¡¿]?\s*(?:no\b|eso\s+no\b|en\s+(?:español|ingl[eé]s|portugu[eé]s|franc[eé]s|alem[aá]n|italiano)\b|en\s+espanol\b|no\s+es\s+(?:eso|lo)\b|me\s+refer[ií]a\b|quer[ií]a\s+decir\b|no\s+es\s+lo\s+que\b|that['’]?s\s+not\b|i\s+meant\b|in\s+(?:spanish|english|french|german|italian)\b)/i;

const VALID_SIGNALS = Object.freeze([
  'regenerate_after_n_tokens',
  'abandoned_stream',
  'manual_prompt_edit',
  'correction_followup',
  'negative_feedback_in_60s',
]);

// ─── Pure detectors ──────────────────────────────────────────────────

function detectRegenerateAfterTokens({ regenerate, tokensGenerated, threshold = DEFAULT_REGENERATE_TOKENS_THRESHOLD } = {}) {
  return Boolean(regenerate) && Number(tokensGenerated || 0) > threshold;
}

function detectAbandonedStream({ completed, tokensGenerated }) {
  // Abandonado solo cuenta si se generaron >5 tokens (filtra disconnects iniciales).
  return completed === false && Number(tokensGenerated || 0) > 5;
}

function detectCorrectionFollowup({ currentPrompt } = {}) {
  if (!currentPrompt || typeof currentPrompt !== 'string') return false;
  return CORRECTION_FOLLOWUP_RE.test(currentPrompt.trim());
}

function detectNegativeFeedbackWindow({ feedback, msSinceResponse, windowMs = DEFAULT_NEGATIVE_WINDOW_MS } = {}) {
  if (feedback !== 'disliked') return false;
  const elapsed = Number(msSinceResponse);
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  return elapsed <= windowMs;
}

/**
 * detectManualPromptEdit
 *
 * Detección "soft" sin embeddings (para ser puramente local): usa
 * Jaccard sobre palabras únicas. Si el caller provee cosine via
 * `similarity` (de feedback-ledger embedder), se prefiere ese.
 */
function detectManualPromptEdit({
  currentPrompt,
  previousPrompt,
  msSincePrevious,
  similarity = null,
  windowMs = DEFAULT_EDIT_WINDOW_MS,
  similarityThreshold = DEFAULT_EDIT_SIMILARITY_THRESHOLD,
} = {}) {
  if (!currentPrompt || !previousPrompt) return false;
  const elapsed = Number(msSincePrevious);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > windowMs) return false;
  if (typeof similarity === 'number' && Number.isFinite(similarity)) {
    return similarity >= similarityThreshold;
  }
  // Fallback Jaccard.
  const j = jaccardWords(currentPrompt, previousPrompt);
  return j >= similarityThreshold;
}

function jaccardWords(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const w of ta) if (tb.has(w)) intersect++;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function tokenize(s) {
  const out = new Set();
  for (const tok of String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (tok && tok.length >= 2) out.add(tok);
  }
  return out;
}

// ─── In-memory ring buffer per user ──────────────────────────────────

const userBuffers = new Map(); // userId -> Array<{signal, ts, payload}>

function pushBuffer(userId, entry) {
  if (!userId) return;
  let buf = userBuffers.get(userId);
  if (!buf) {
    buf = [];
    userBuffers.set(userId, buf);
  }
  buf.push(entry);
  if (buf.length > MAX_SIGNALS_PER_USER) {
    buf.splice(0, buf.length - MAX_SIGNALS_PER_USER);
  }
}

function getRecentMisunderstandings({ userId, windowMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const buf = userBuffers.get(userId);
  if (!buf || buf.length === 0) return [];
  const cutoff = Date.now() - windowMs;
  return buf.filter((e) => e.ts >= cutoff);
}

function _clearAllForTests() {
  userBuffers.clear();
}

// ─── Recorder ────────────────────────────────────────────────────────

/**
 * Optional Langfuse sink — set once at boot.
 * Shape: { scoreTrace(traceId, {name, value, comment}) }
 */
let langfuseSink = null;
function setLangfuseSink(sink) {
  langfuseSink = sink && typeof sink.scoreTrace === 'function' ? sink : null;
}

/**
 * recordSignal — fire-and-forget. Non-blocking. Swallows all errors.
 *
 * @param {object} args
 * @param {string} args.signal — one of VALID_SIGNALS
 * @param {string} [args.userId]
 * @param {string} [args.sessionId]
 * @param {string} [args.turnId]
 * @param {string} [args.traceId] — to correlate with Langfuse trace
 * @param {object} [args.payload]
 */
function recordSignal({ signal, userId, sessionId, turnId, traceId, payload = {} } = {}) {
  try {
    if (!VALID_SIGNALS.includes(signal)) return false;
    const entry = {
      signal,
      ts: Date.now(),
      userId: userId || null,
      sessionId: sessionId || null,
      turnId: turnId || null,
      traceId: traceId || null,
      payload: payload && typeof payload === 'object' ? payload : {},
    };
    pushBuffer(userId, entry);
    if (langfuseSink && traceId) {
      try {
        langfuseSink.scoreTrace(traceId, {
          name: `misunderstanding.${signal}`,
          value: 1,
          comment: JSON.stringify({ turnId, payload: entry.payload }).slice(0, 500),
        });
      } catch (_) { /* swallow */ }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * recordFromContext — convenience wrapper that runs ALL detectors
 * against a single context object and records each positive signal.
 *
 * Designed to be called once at stream close or once per new turn.
 * Pure side-effect surface: caller never has to remember which detector
 * to call.
 */
function recordFromContext(ctx = {}) {
  const recorded = [];
  const base = {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    traceId: ctx.traceId,
  };

  if (detectRegenerateAfterTokens(ctx)) {
    recordSignal({
      ...base,
      signal: 'regenerate_after_n_tokens',
      payload: { tokensGenerated: ctx.tokensGenerated, threshold: ctx.threshold || DEFAULT_REGENERATE_TOKENS_THRESHOLD },
    });
    recorded.push('regenerate_after_n_tokens');
  }
  if (detectAbandonedStream(ctx)) {
    recordSignal({
      ...base,
      signal: 'abandoned_stream',
      payload: { tokensGenerated: ctx.tokensGenerated },
    });
    recorded.push('abandoned_stream');
  }
  if (detectCorrectionFollowup(ctx)) {
    recordSignal({
      ...base,
      signal: 'correction_followup',
      payload: { currentPrompt: String(ctx.currentPrompt || '').slice(0, 200) },
    });
    recorded.push('correction_followup');
  }
  if (detectNegativeFeedbackWindow(ctx)) {
    recordSignal({
      ...base,
      signal: 'negative_feedback_in_60s',
      payload: { msSinceResponse: ctx.msSinceResponse, messageId: ctx.messageId },
    });
    recorded.push('negative_feedback_in_60s');
  }
  if (detectManualPromptEdit(ctx)) {
    recordSignal({
      ...base,
      signal: 'manual_prompt_edit',
      payload: {
        msSincePrevious: ctx.msSincePrevious,
        similarity: typeof ctx.similarity === 'number' ? Number(ctx.similarity.toFixed(3)) : null,
      },
    });
    recorded.push('manual_prompt_edit');
  }
  return recorded;
}

// ─── Aggregations ────────────────────────────────────────────────────

function aggregateByUser(userId, windowMs) {
  const recent = getRecentMisunderstandings({ userId, windowMs });
  const counts = Object.create(null);
  for (const e of recent) counts[e.signal] = (counts[e.signal] || 0) + 1;
  return { userId, total: recent.length, byType: counts, windowMs };
}

function globalSnapshot({ topN = 50 } = {}) {
  const out = [];
  for (const [userId, buf] of userBuffers.entries()) {
    out.push({ userId, signals: buf.length, last: buf[buf.length - 1]?.ts || 0 });
  }
  out.sort((a, b) => b.signals - a.signals);
  return out.slice(0, topN);
}

module.exports = {
  // pure detectors (exported for testability)
  detectRegenerateAfterTokens,
  detectAbandonedStream,
  detectCorrectionFollowup,
  detectNegativeFeedbackWindow,
  detectManualPromptEdit,
  jaccardWords,
  // recorder + reads
  recordSignal,
  recordFromContext,
  getRecentMisunderstandings,
  aggregateByUser,
  globalSnapshot,
  setLangfuseSink,
  // constants
  VALID_SIGNALS,
  MAX_SIGNALS_PER_USER,
  DEFAULT_REGENERATE_TOKENS_THRESHOLD,
  DEFAULT_NEGATIVE_WINDOW_MS,
  DEFAULT_EDIT_WINDOW_MS,
  DEFAULT_EDIT_SIMILARITY_THRESHOLD,
  CORRECTION_FOLLOWUP_RE,
  // internals for tests
  _clearAllForTests,
  _userBuffers: userBuffers,
};
