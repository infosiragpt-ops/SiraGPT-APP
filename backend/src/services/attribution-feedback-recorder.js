'use strict';

/**
 * attribution-feedback-recorder.js
 *
 * Captures user reactions on assistant responses ('helpful' / 'not_helpful'
 * / 'regenerate') and links them to the corresponding attribution trace
 * so the system can learn which attribution profiles led to good vs bad
 * outputs. Aggregated stats are exposed for ops dashboards and as input
 * to per-user adaptive weighting.
 *
 * Each entry:
 *   { id, userId, chatId, turnIndex, traceId, reaction, comment?, ts,
 *     traceSnapshot: { verdict, primaryIntent, driftClass, confidenceGrade, ... } }
 *
 * Bounded ring buffer (default 1000 entries). No I/O, no LLM.
 *
 * Public API:
 *   record({userId, chatId, turnIndex, traceId, reaction, comment?})
 *   list({chatId?, userId?, reaction?, limit?})
 *   aggregate({windowMs?, groupBy?})
 *   reset()
 */

const crypto = require('crypto');
const traceRecorder = require('./attribution-trace-recorder');

const MAX_ENTRIES = Number.parseInt(process.env.SIRAGPT_FEEDBACK_RECORDER_MAX || '1000', 10);
const VALID_REACTIONS = new Set(['helpful', 'not_helpful', 'regenerate', 'clarify', 'stop']);

const ENTRIES = [];
let HYDRATED = false;

let persistence = null;
const PERSIST_ENABLED = String(process.env.SIRAGPT_ATTRIBUTION_PERSIST || '').toLowerCase() === '1';
try { if (PERSIST_ENABLED) persistence = require('./attribution-persistence'); } catch (_e) { persistence = null; }

function hydrate() {
  if (HYDRATED || !persistence) { HYDRATED = true; return; }
  HYDRATED = true;
  try {
    const payload = persistence.load('feedback', 'global');
    if (payload && Array.isArray(payload.entries)) {
      for (const e of payload.entries) ENTRIES.push(e);
    }
  } catch (_e) { /* swallow */ }
}

function persistSoon() {
  if (!persistence) return;
  try {
    persistence.scheduleSave('feedback', 'global', { entries: ENTRIES.slice(-MAX_ENTRIES), savedAt: Date.now() });
  } catch (_e) { /* swallow */ }
}

function newId() { return `fb_${crypto.randomBytes(6).toString('hex')}`; }

function safeText(v, max = 240) { return String(v == null ? '' : v).slice(0, max); }

function record({
  userId = null,
  chatId = null,
  turnIndex = 0,
  traceId = null,
  reaction = null,
  comment = null,
} = {}) {
  if (!VALID_REACTIONS.has(reaction)) {
    return { ok: false, error: `reaction must be one of ${[...VALID_REACTIONS].join(',')}` };
  }
  const linkedTrace = traceId ? traceRecorder.get({ id: traceId }) : null;
  const snapshot = linkedTrace?.summarySnapshot || null;
  const entry = {
    id: newId(),
    userId: userId ? String(userId).slice(0, 64) : null,
    chatId: chatId ? String(chatId).slice(0, 64) : null,
    turnIndex,
    traceId: traceId ? String(traceId).slice(0, 64) : null,
    reaction,
    comment: comment ? safeText(comment, 480) : null,
    timestamp: Date.now(),
    traceSnapshot: snapshot,
  };
  hydrate();
  ENTRIES.push(entry);
  if (ENTRIES.length > MAX_ENTRIES) ENTRIES.splice(0, ENTRIES.length - MAX_ENTRIES);
  persistSoon();
  return { ok: true, entry };
}

function list({ chatId = null, userId = null, reaction = null, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  let out = ENTRIES.map((e, idx) => ({ ...e, _seq: idx }));
  if (chatId) out = out.filter((e) => e.chatId === chatId);
  if (userId) out = out.filter((e) => e.userId === userId);
  if (reaction) out = out.filter((e) => e.reaction === reaction);
  return out
    .sort((a, b) => (b.timestamp - a.timestamp) || (b._seq - a._seq))
    .slice(0, cap)
    .map(({ _seq, ...rest }) => rest);
}

function aggregate({ windowMs = null, groupBy = 'reaction' } = {}) {
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  const filtered = cutoff ? ENTRIES.filter((e) => e.timestamp >= cutoff) : ENTRIES;
  if (!filtered.length) return { count: 0, groups: {} };

  const groups = {};
  for (const e of filtered) {
    let key;
    switch (groupBy) {
      case 'intent':
        key = e.traceSnapshot?.primaryIntent || 'unknown';
        break;
      case 'driftClass':
        key = e.traceSnapshot?.driftClass || 'baseline';
        break;
      case 'confidenceGrade':
        key = e.traceSnapshot?.confidenceGrade || 'unknown';
        break;
      case 'verdict':
        key = e.traceSnapshot?.verdict || 'unknown';
        break;
      case 'reaction':
      default:
        key = e.reaction;
    }
    if (!groups[key]) groups[key] = { total: 0, byReaction: {} };
    groups[key].total += 1;
    groups[key].byReaction[e.reaction] = (groups[key].byReaction[e.reaction] || 0) + 1;
  }

  // Compute a helpfulness score per group: helpful / (helpful + not_helpful + regenerate)
  for (const g of Object.values(groups)) {
    const h = g.byReaction.helpful || 0;
    const nh = g.byReaction.not_helpful || 0;
    const rg = g.byReaction.regenerate || 0;
    const denom = h + nh + rg;
    g.helpfulnessScore = denom > 0 ? Number((h / denom).toFixed(3)) : null;
  }

  return { count: filtered.length, windowMs, groupBy, groups };
}

function reset() {
  ENTRIES.length = 0;
  HYDRATED = false;
  if (persistence) try { persistence.remove('feedback', 'global'); } catch (_e) { /* swallow */ }
}

function stats() {
  const byReaction = {};
  for (const e of ENTRIES) byReaction[e.reaction] = (byReaction[e.reaction] || 0) + 1;
  return { count: ENTRIES.length, byReaction };
}

module.exports = {
  record,
  list,
  aggregate,
  stats,
  reset,
  VALID_REACTIONS,
  MAX_ENTRIES,
};
