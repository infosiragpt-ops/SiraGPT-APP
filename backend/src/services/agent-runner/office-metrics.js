'use strict';

/**
 * Edición milimétrica — Fase F.2 metrics (docs/specs/edicion-milimetrica/
 * SPEC.md §9 F.2), on the shared Prometheus registry (services/agents/
 * metrics → the unified /metrics exposition), plus one structured
 * `[office-edit]` log line per document turn, next to `[doc-routing]`:
 *
 *   office_verify_total{result}              pass | fail | unavailable
 *                                            → office_verify_pass_rate
 *   office_verify_attempts_per_turn          histogram of verify_visual calls
 *   office_pagination_changed_total          page count moved in a verification
 *   office_vision_disagreement_total{direction}
 *                                            vision_veto (checks OK, vision ✗) |
 *                                            checks_fail_vision_ok
 *   office_tool_latency_ms{tool}             p50 / p95 per office tool
 *
 * Never throws: metrics must not be able to break a turn.
 */

const OFFICE_TOOLS = new Set(['inspect_document', 'office_edit', 'render_preview', 'verify_visual']);
const ATTEMPT_BUCKETS = [1, 2, 3, 4, 6];
// Tool trace on the [office-edit] line: enough of the turn to see WHY it
// ended with edits:0 (prod 2026-10-07: four turn_wall / subtask_no_progress
// document turns with no step trace in the logs), bounded so a long turn
// never floods a log line.
const TRACE_MAX_STEPS = 24;
const TRACE_MAX_CHARS = 700;
const LAST_ERROR_MAX_CHARS = 160;
const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 170000];

let registry;

function metricsRegistry() {
  if (registry !== undefined) return registry;
  try {
    const m = require('../agents/metrics');
    m.registerCounter('office_verify_total', { help: 'verify_visual runs by result (pass/fail/unavailable)', labels: ['result'] });
    m.registerHistogram('office_verify_attempts_per_turn', { help: 'verify_visual calls per document turn', buckets: ATTEMPT_BUCKETS });
    m.registerCounter('office_pagination_changed_total', { help: 'verifications where the page count changed' });
    m.registerCounter('office_vision_disagreement_total', { help: 'vision verdict vs deterministic checks disagreed', labels: ['direction'] });
    m.registerHistogram('office_tool_latency_ms', { help: 'office tool latency (ms)', labels: ['tool'], buckets: LATENCY_BUCKETS_MS });
    registry = m;
  } catch (_) {
    registry = null;
  }
  return registry;
}

/** One verify_visual run (called from its onVerify hook). */
function recordVerify({ passed, checksOk = null, visionOk = null, paginationChanged = false } = {}) {
  const m = metricsRegistry();
  if (!m) return;
  try {
    m.counter('office_verify_total', { result: passed ? 'pass' : 'fail' });
    if (paginationChanged) m.counter('office_pagination_changed_total', {});
    if (checksOk === true && visionOk === false) m.counter('office_vision_disagreement_total', { direction: 'vision_veto' });
    if (checksOk === false && visionOk === true) m.counter('office_vision_disagreement_total', { direction: 'checks_fail_vision_ok' });
  } catch (_) { /* metrics never break a turn */ }
}

/**
 * Compact «tool✓1.9s→tool✗35s» sequence of the whole turn (every tool, not
 * only the office ones), newest steps kept when the cap cuts.
 */
function toolTrace(list) {
  const steps = list.filter((s) => s && s.tool);
  const kept = steps.slice(-TRACE_MAX_STEPS);
  const parts = kept.map((s) => {
    const dur = Number(s.durationMs);
    const secs = Number.isFinite(dur) && dur >= 0 ? `${(dur / 1000).toFixed(dur >= 10_000 ? 0 : 1)}s` : '';
    return `${String(s.tool).slice(0, 40)}${s.ok === false ? '✗' : '✓'}${secs}`;
  });
  let text = parts.join('→');
  if (text.length > TRACE_MAX_CHARS) text = `…${text.slice(-(TRACE_MAX_CHARS - 1))}`;
  return steps.length > kept.length ? `…(${steps.length - kept.length} más)→${text}` : text;
}

function lastErrorPreview(list) {
  const failed = list.filter((s) => s && s.ok === false && typeof s.resultPreview === 'string');
  const last = failed[failed.length - 1];
  if (!last) return null;
  return String(last.resultPreview).replace(/\s+/g, ' ').trim().slice(0, LAST_ERROR_MAX_CHARS) || null;
}

/**
 * End of a runner turn: attempts per turn, per-tool latency and the
 * structured log line. Returns the record (null for non-office turns).
 */
function recordOfficeTurn({ steps = [], stoppedReason = null, verifies = [], chatId = null, log = console.log } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const office = list.filter((s) => s && OFFICE_TOOLS.has(s.tool));
  if (!office.length) return null;
  const verifySteps = office.filter((s) => s.tool === 'verify_visual');
  const unavailable = verifySteps.filter((s) => s.renderUnavailable).length;
  const last = verifySteps[verifySteps.length - 1] || null;
  const m = metricsRegistry();
  try {
    if (m) {
      if (verifySteps.length) m.observe('office_verify_attempts_per_turn', {}, verifySteps.length);
      if (unavailable) m.counter('office_verify_total', { result: 'unavailable' }, unavailable);
      for (const s of office) {
        if (Number.isFinite(s.durationMs)) m.observe('office_tool_latency_ms', { tool: s.tool }, s.durationMs);
      }
    }
  } catch (_) { /* metrics never break a turn */ }
  const verifyList = Array.isArray(verifies) ? verifies : [];
  const record = {
    edits: office.filter((s) => s.tool === 'office_edit').length,
    editsOk: office.filter((s) => s.tool === 'office_edit' && s.ok !== false).length,
    verifyAttempts: verifySteps.length,
    verified: Boolean(last && last.ok !== false),
    ...(unavailable ? { renderUnavailable: unavailable } : {}),
    visionReviewed: verifyList.some((v) => v && v.visionOk !== null && v.visionOk !== undefined),
    visionDisagreements: verifyList.filter((v) => v && ((v.checksOk === true && v.visionOk === false) || (v.checksOk === false && v.visionOk === true))).length,
    // Direction of the disagreements: a vision veto over passing checks
    // (the model is told to fix what vision marked) vs checks that failed
    // while vision approved.
    visionVetoes: verifyList.filter((v) => v && v.checksOk === true && v.visionOk === false).length,
    checksFailVisionOk: verifyList.filter((v) => v && v.checksOk === false && v.visionOk === true).length,
    paginationChanged: verifyList.some((v) => v && v.paginationChanged),
    stoppedReason: stoppedReason ? String(stoppedReason).slice(0, 60) : null,
    steps: list.filter((s) => s && s.tool).length,
    failedCalls: list.filter((s) => s && s.tool && s.ok === false).length,
    iterations: list.reduce((max, s) => (s && Number.isInteger(s.iteration) && s.iteration > max ? s.iteration : max), 0) || null,
    toolTrace: toolTrace(list),
    ...(lastErrorPreview(list) ? { lastError: lastErrorPreview(list) } : {}),
    ...(chatId ? { chatId: String(chatId) } : {}),
    ts: new Date().toISOString(),
  };
  try { log(`[office-edit] ${JSON.stringify(record)}`); } catch (_) { /* telemetry never breaks a turn */ }
  return record;
}

module.exports = {
  OFFICE_TOOLS,
  recordVerify,
  recordOfficeTurn,
};
