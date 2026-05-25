'use strict';

/**
 * attribution-trace-recorder.js
 *
 * Bounded ring buffer of recent attribution-suite bundles. Lets ops
 * answer "what did the system see when chat X went sideways at turn Y?"
 * without standing up a full logging pipeline.
 *
 * Each trace entry:
 *   {
 *     id, userId, chatId, turnIndex, timestamp,
 *     prompt (truncated), verdict, telemetry,
 *     summarySnapshot: { primaryIntent, multiHopDepth, planNodes,
 *                        conflicts, driftClass, beliefsObserved,
 *                        beliefsContradicted, faithfulnessGrade,
 *                        confidenceScore?, confidenceGrade? }
 *   }
 *
 * Bounded by `MAX_TRACES` (default 500). Eviction is oldest-first.
 *
 * No I/O, no LLM. Hot-path cost is < 1 ms.
 */

const crypto = require('crypto');

const MAX_TRACES = Number.parseInt(process.env.SIRAGPT_TRACE_RECORDER_MAX || '500', 10);
const PROMPT_PREVIEW_CHARS = 240;

const TRACES = []; // newest at the end

function safeText(v, max = PROMPT_PREVIEW_CHARS) {
  return String(v == null ? '' : v).slice(0, max);
}

function newId() {
  return `trace_${crypto.randomBytes(6).toString('hex')}`;
}

function record({
  userId = null,
  chatId = null,
  turnIndex = 0,
  prompt = '',
  bundle = null,
  confidence = null,
} = {}) {
  if (!bundle) return null;
  const entry = {
    id: newId(),
    userId: userId ? String(userId).slice(0, 64) : null,
    chatId: chatId ? String(chatId).slice(0, 64) : null,
    turnIndex,
    timestamp: Date.now(),
    promptPreview: safeText(prompt),
    verdict: bundle.verdict || 'allow',
    telemetry: bundle.telemetry || {},
    summarySnapshot: {
      primaryIntent: bundle.telemetry?.primaryIntent || null,
      multiHopDepth: bundle.telemetry?.multiHopDepth || 0,
      planNodes: bundle.telemetry?.planNodes || 0,
      conflicts: bundle.telemetry?.conflicts || 0,
      driftClass: bundle.telemetry?.driftClass || 'baseline',
      beliefsObserved: bundle.telemetry?.beliefsObserved || 0,
      beliefsContradicted: bundle.telemetry?.beliefsContradicted || 0,
      faithfulnessGrade: bundle.telemetry?.faithfulnessGrade || null,
      confidenceScore: confidence?.score ?? null,
      confidenceGrade: confidence?.grade ?? null,
    },
  };
  TRACES.push(entry);
  if (TRACES.length > MAX_TRACES) TRACES.splice(0, TRACES.length - MAX_TRACES);
  return entry;
}

function list({ chatId = null, userId = null, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  let out = TRACES.map((t, idx) => ({ ...t, _seq: idx }));
  if (chatId) out = out.filter((t) => t.chatId === chatId);
  if (userId) out = out.filter((t) => t.userId === userId);
  // Recency by timestamp; same-millisecond ties break on insertion order
  // (newer last) so callers get deterministic ordering on hot turns.
  return out
    .sort((a, b) => (b.timestamp - a.timestamp) || (b._seq - a._seq))
    .slice(0, cap)
    .map(({ _seq, ...rest }) => rest);
}

function get({ id } = {}) {
  if (!id) return null;
  return TRACES.find((t) => t.id === id) || null;
}

function stats() {
  if (!TRACES.length) return { count: 0 };
  const byVerdict = {};
  const byDrift = {};
  for (const t of TRACES) {
    byVerdict[t.verdict] = (byVerdict[t.verdict] || 0) + 1;
    const d = t.summarySnapshot.driftClass || 'baseline';
    byDrift[d] = (byDrift[d] || 0) + 1;
  }
  return {
    count: TRACES.length,
    oldest: TRACES[0].timestamp,
    newest: TRACES[TRACES.length - 1].timestamp,
    byVerdict,
    byDrift,
  };
}

function reset() { TRACES.length = 0; }

module.exports = {
  record,
  list,
  get,
  stats,
  reset,
  MAX_TRACES,
};
