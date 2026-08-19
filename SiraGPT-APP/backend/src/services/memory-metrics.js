'use strict';

/**
 * memory-metrics — tiny in-memory counters for the autonomous-memory system,
 * so the recall/store/forget decisions are observable (dashboards, /metrics).
 * Zero deps, process-local, best-effort: recording must never throw.
 */

const counters = {
  turns: 0,            // turns that ran the memory engine
  stored: 0,           // facts persisted
  superseded: 0,       // stale single-valued facts replaced
  forgotten: 0,        // facts removed via "forget"/Olvidar
  recallDecisions: 0,  // turns where recall was warranted
  recalled: 0,         // memory items surfaced to the model/UI
  recallEmpty: 0,      // recall warranted but nothing relevant found
};

let lastReason = '';
let lastAt = 0;

function record(event, n = 1) {
  try {
    const inc = Number.isFinite(n) ? n : 1;
    if (event === 'turn') counters.turns += 1;
    else if (event === 'stored') counters.stored += inc;
    else if (event === 'superseded') counters.superseded += inc;
    else if (event === 'forgotten') counters.forgotten += inc;
    else if (event === 'recall_decision') counters.recallDecisions += 1;
    else if (event === 'recalled') counters.recalled += inc;
    else if (event === 'recall_empty') counters.recallEmpty += 1;
    lastAt = Date.now();
  } catch { /* metrics never break the caller */ }
}

function recordReason(reason) {
  if (typeof reason === 'string' && reason) lastReason = reason.slice(0, 200);
}

function snapshot() {
  const recallHitRate = counters.recallDecisions > 0
    ? Number((1 - counters.recallEmpty / counters.recallDecisions).toFixed(3))
    : null;
  const avgRecalledPerHit = (counters.recallDecisions - counters.recallEmpty) > 0
    ? Number((counters.recalled / (counters.recallDecisions - counters.recallEmpty)).toFixed(2))
    : null;
  return {
    ...counters,
    recallHitRate,
    avgRecalledPerHit,
    lastReason,
    lastAt: lastAt || null,
  };
}

function toPrometheusText() {
  const s = snapshot();
  const lines = [
    '# HELP sira_memory_turns_total Turns that ran the memory engine.',
    '# TYPE sira_memory_turns_total counter',
    `sira_memory_turns_total ${s.turns}`,
    '# HELP sira_memory_stored_total Facts persisted.',
    '# TYPE sira_memory_stored_total counter',
    `sira_memory_stored_total ${s.stored}`,
    '# HELP sira_memory_superseded_total Stale single-valued facts replaced.',
    '# TYPE sira_memory_superseded_total counter',
    `sira_memory_superseded_total ${s.superseded}`,
    '# HELP sira_memory_forgotten_total Facts removed via forget.',
    '# TYPE sira_memory_forgotten_total counter',
    `sira_memory_forgotten_total ${s.forgotten}`,
    '# HELP sira_memory_recalled_total Memory items surfaced.',
    '# TYPE sira_memory_recalled_total counter',
    `sira_memory_recalled_total ${s.recalled}`,
  ];
  return `${lines.join('\n')}\n`;
}

function reset() {
  for (const k of Object.keys(counters)) counters[k] = 0;
  lastReason = '';
  lastAt = 0;
}

module.exports = { record, recordReason, snapshot, toPrometheusText, reset };
