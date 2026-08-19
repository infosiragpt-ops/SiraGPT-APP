'use strict';

/**
 * attribution-replay-runner.js
 *
 * Re-runs the attribution-suite against a stored trace's prompt to
 * detect engine drift over time. Compares the replayed telemetry against
 * the trace's recorded snapshot and emits a diff highlighting fields
 * that changed.
 *
 * Useful as:
 *   - regression guard in CI (replay a fixed set of golden traces,
 *     assert no field drifted by more than a threshold)
 *   - debugging tool (does engine X.Y behave differently on the same
 *     input than engine X.Y-1?)
 *   - dashboard ("stability score" — % of traces whose replay matches)
 *
 * The runner does NOT replay the full chat history (traces only store
 * a prompt preview); for context-sensitive replays the caller must
 * supply the original history.
 *
 * Pure orchestration on top of attribution-suite and trace-recorder.
 */

const traceRecorder = require('./attribution-trace-recorder');
const suite = require('./attribution-suite');

function diffSnapshots(original = {}, replay = {}) {
  const fields = new Set([...Object.keys(original || {}), ...Object.keys(replay || {})]);
  const diffs = {};
  for (const f of fields) {
    const a = original[f];
    const b = replay[f];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') {
      const delta = Math.abs(a - b);
      if (delta === 0) continue;
      diffs[f] = { from: a, to: b, delta: Number(delta.toFixed(3)) };
    } else if (a !== b) {
      diffs[f] = { from: a, to: b };
    }
  }
  return diffs;
}

/**
 * Replay a single trace by id.
 *
 * @param {object} args
 * @param {string} args.traceId
 * @param {Array}  [args.history]  optional override; if omitted, only
 *                                  the prompt itself is replayed
 * @param {number} [args.driftBudget]  max acceptable per-field delta
 *                                      for the "ok" flag (default 0.05)
 */
function replay({ traceId, history = null, driftBudget = 0.05 } = {}) {
  if (!traceId) return { ok: false, error: 'traceId is required' };
  const trace = traceRecorder.get({ id: traceId });
  if (!trace) return { ok: false, error: 'trace not found' };

  const replayed = suite.run({
    userId: trace.userId,
    chatId: trace.chatId,
    turnIndex: trace.turnIndex,
    prompt: trace.promptPreview,
    history: Array.isArray(history) ? history : [],
  });

  const original = trace.summarySnapshot || {};
  const fresh = {
    primaryIntent: replayed.telemetry?.primaryIntent || null,
    multiHopDepth: replayed.telemetry?.multiHopDepth || 0,
    planNodes: replayed.telemetry?.planNodes || 0,
    conflicts: replayed.telemetry?.conflicts || 0,
    driftClass: replayed.telemetry?.driftClass || 'baseline',
    beliefsObserved: replayed.telemetry?.beliefsObserved || 0,
    beliefsContradicted: replayed.telemetry?.beliefsContradicted || 0,
    faithfulnessGrade: replayed.telemetry?.faithfulnessGrade || null,
  };

  const diffs = diffSnapshots(original, fresh);
  const numericDrift = Object.values(diffs)
    .filter((d) => typeof d.delta === 'number')
    .reduce((max, d) => Math.max(max, d.delta), 0);
  const stable = Object.keys(diffs).length === 0 || numericDrift <= driftBudget;

  return {
    ok: true,
    traceId,
    stable,
    original,
    replay: fresh,
    diffs,
    numericDrift: Number(numericDrift.toFixed(3)),
    replayLatencyMs: replayed.telemetry?.latencyMs || 0,
  };
}

/**
 * Replay every trace in the recorder; returns a stability summary.
 */
function replayAll({ driftBudget = 0.05, limit = 50 } = {}) {
  const traces = traceRecorder.list({ limit });
  const results = [];
  let stableCount = 0;
  for (const t of traces) {
    const r = replay({ traceId: t.id, driftBudget });
    if (r.ok && r.stable) stableCount += 1;
    results.push(r);
  }
  return {
    total: traces.length,
    stableCount,
    stabilityRate: traces.length ? Number((stableCount / traces.length).toFixed(3)) : 0,
    results,
  };
}

function buildReplayBlock(result) {
  if (!result || !result.ok) return '';
  const lines = ['## TRACE REPLAY REPORT'];
  lines.push(`trace=${result.traceId} stable=${result.stable} numericDrift=${result.numericDrift} latency=${result.replayLatencyMs}ms`);
  if (Object.keys(result.diffs || {}).length) {
    lines.push('Drifted fields:');
    for (const [f, d] of Object.entries(result.diffs)) {
      if (typeof d.delta === 'number') {
        lines.push(`- ${f}: ${d.from} → ${d.to} (Δ ${d.delta})`);
      } else {
        lines.push(`- ${f}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
      }
    }
  } else {
    lines.push('No drift detected.');
  }
  return lines.join('\n');
}

module.exports = {
  replay,
  replayAll,
  buildReplayBlock,
  diffSnapshots,
};
