'use strict';

/**
 * Contrastive document pairs for RLCD export / steering.
 *
 * Groups chosen + rejected document answers that share a prompt hash
 * (or an existing pairId). This is a calibration helper, not ICLR
 * contrastive distillation. Fail-open. PII-scrubbed by the caller.
 */

function promptKey(event) {
  return String(
    (event && (event.promptHash || event.promptText || event.request)) || '',
  ).trim();
}

function confidenceOf(event) {
  const rlcd = event && event.judgeScore && event.judgeScore.rlcd;
  const n = Number(rlcd && rlcd.confidence);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function isDocumentEvent(event) {
  return String((event && event.agent) || '') === 'document';
}

function isChosen(event) {
  return event && (event.label === 'chosen' || event.helpful === true);
}

function isRejected(event) {
  return event && (event.label === 'rejected' || event.helpful === false);
}

function textOf(event) {
  if (!event) return '';
  const raw = event.responseText || event.response || '';
  return typeof raw === 'string' ? raw : (() => {
    try { return JSON.stringify(raw); } catch { return String(raw || ''); }
  })();
}

/**
 * Build contrastive pairs from preference events.
 * Prefers explicit pairId groups, then same-prompt chosen/rejected leftovers.
 */
function buildDocumentPairs(events, { limit = 40 } = {}) {
  try {
    const list = (Array.isArray(events) ? events : []).filter(isDocumentEvent);
    const pairs = [];
    const used = new Set();

    const byPair = new Map();
    for (const e of list) {
      if (!e.pairId) continue;
      let g = byPair.get(e.pairId);
      if (!g) {
        g = { chosen: null, rejected: null };
        byPair.set(e.pairId, g);
      }
      if (isChosen(e)) g.chosen = e;
      if (isRejected(e)) g.rejected = e;
    }
    for (const [pairId, g] of byPair) {
      if (!g.chosen || !g.rejected) continue;
      used.add(g.chosen.id || g.chosen.runId);
      used.add(g.rejected.id || g.rejected.runId);
      pairs.push(shapePair(g.chosen, g.rejected, pairId));
      if (pairs.length >= limit) return pairs;
    }

    const byPrompt = new Map();
    for (const e of list) {
      const id = e.id || e.runId;
      if (used.has(id)) continue;
      const key = promptKey(e);
      if (!key) continue;
      let g = byPrompt.get(key);
      if (!g) {
        g = { chosen: [], rejected: [] };
        byPrompt.set(key, g);
      }
      if (isChosen(e)) g.chosen.push(e);
      else if (isRejected(e)) g.rejected.push(e);
    }
    for (const g of byPrompt.values()) {
      const n = Math.min(g.chosen.length, g.rejected.length);
      for (let i = 0; i < n; i += 1) {
        pairs.push(shapePair(g.chosen[i], g.rejected[i], null));
        if (pairs.length >= limit) return pairs;
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

function shapePair(chosen, rejected, pairId) {
  const chosenC = confidenceOf(chosen);
  const rejectedC = confidenceOf(rejected);
  return {
    pairId: pairId || null,
    prompt: String(chosen.promptText || chosen.request || rejected.promptText || rejected.request || '').slice(0, 800),
    chosen: textOf(chosen).slice(0, 1200),
    rejected: textOf(rejected).slice(0, 1200),
    chosenConfidence: chosenC,
    rejectedConfidence: rejectedC,
    delta: chosenC != null && rejectedC != null
      ? Math.round((chosenC - rejectedC) * 1000) / 1000
      : null,
    agent: 'document',
    overconfidentReject: rejectedC != null && rejectedC >= 0.7,
  };
}

function pickSteeringPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  return pairs.find((p) => p.overconfidentReject) || pairs[0] || null;
}

module.exports = {
  buildDocumentPairs,
  pickSteeringPair,
  confidenceOf,
};
