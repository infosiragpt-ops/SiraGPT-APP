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
    paginationChanged: verifyList.some((v) => v && v.paginationChanged),
    stoppedReason: stoppedReason ? String(stoppedReason).slice(0, 60) : null,
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
