'use strict';

/**
 * attribution-replay-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-runs a saved attribution snapshot through the current pipeline to
 * verify reproducibility. Pairs with `attribution-snapshot-store`: a
 * regression in any downstream module shows up as a diff between the
 * snapshot's recorded shape and the current pipeline output.
 *
 * Verdicts:
 *   • identical   — every tracked field matches
 *   • drift       — numeric-only deltas (within tolerance) OR
 *                   non-intent category changes
 *   • regression  — primary intent kind/text changed
 *
 * Public API:
 *   replay({ snapshot, runnerFn?, opts? })   → ReplayReport
 *   buildReplayBlock(report, opts?)          → string
 *   diffFields(expected, actual, tolerance?) → FieldDiff[]
 *   classifyVerdict(diffs)                   → verdict
 */

let contextEngine = null;
try { contextEngine = require('./context-attribution-engine'); } catch (_) { /* optional */ }

const DEFAULT_NUMERIC_TOLERANCE = 0.05;

const TRACKED_FIELDS = Object.freeze([
  'primaryIntent.text', 'primaryIntent.kind',
  'confidence', 'hopsDepth', 'planNodes',
  'suppressionConflicts', 'language', 'multiHopDepth',
]);

function getField(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function diffFields(expected, actual, tolerance = DEFAULT_NUMERIC_TOLERANCE) {
  const out = [];
  for (const path of TRACKED_FIELDS) {
    const e = getField(expected, path);
    const a = getField(actual, path);
    if (e === undefined && a === undefined) continue;
    if (e === undefined) { out.push({ field: path, expected: null, actual: a, kind: 'added' }); continue; }
    if (a === undefined) { out.push({ field: path, expected: e, actual: null, kind: 'removed' }); continue; }
    if (typeof e === 'number' && typeof a === 'number') {
      if (Math.abs(e - a) > tolerance) out.push({ field: path, expected: e, actual: a, kind: 'numeric', delta: a - e });
      continue;
    }
    if (String(e).toLowerCase() !== String(a).toLowerCase()) {
      out.push({ field: path, expected: e, actual: a, kind: 'category' });
    }
  }
  return out;
}

function classifyVerdict(diffs) {
  if (!diffs || diffs.length === 0) return 'identical';
  const hasCategory = diffs.some((d) => d.kind === 'category' || d.kind === 'added' || d.kind === 'removed');
  if (hasCategory) {
    const intentChange = diffs.some((d) => d.field.startsWith('primaryIntent'));
    return intentChange ? 'regression' : 'drift';
  }
  return 'drift';
}

function defaultRunner({ prompt }) {
  if (!contextEngine?.summarize) return { available: false };
  return contextEngine.summarize({ prompt });
}

function buildExpectedFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    primaryIntent: snapshot.primaryIntent || (snapshot.intent ? { text: snapshot.intent } : null),
    confidence: snapshot.confidence ?? snapshot.intentConfidence ?? null,
    hopsDepth: snapshot.hopsDepth ?? snapshot.multiHopDepth ?? null,
    planNodes: snapshot.planNodes ?? snapshot.plan?.nodes?.length ?? null,
    suppressionConflicts: snapshot.suppressionConflicts ?? snapshot.suppression?.conflicts?.length ?? null,
    language: snapshot.language || null,
    multiHopDepth: snapshot.multiHopDepth ?? snapshot.hopsDepth ?? null,
  };
}

function buildActualFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    primaryIntent: summary.primaryIntent || (summary.topIntents?.[0] || null),
    confidence: summary.intentConfidence ?? summary.confidence ?? null,
    hopsDepth: summary.multiHopDepth ?? summary.hopsDepth ?? null,
    planNodes: summary.planNodes ?? summary.plan?.nodes?.length ?? null,
    suppressionConflicts: summary.suppressionConflicts ?? null,
    language: summary.language || null,
    multiHopDepth: summary.multiHopDepth ?? null,
  };
}

function replay({ snapshot = null, runnerFn = null, opts = {} } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: 'snapshot required' };
  const prompt = snapshot.prompt || snapshot.promptPreview || snapshot.userMessage || '';
  const runner = runnerFn || defaultRunner;
  const t0 = Date.now();
  let actual = null;
  try { actual = runner({ prompt, snapshot }); }
  catch (err) { return { ok: false, error: err?.message || String(err), durationMs: Date.now() - t0 }; }
  const durationMs = Date.now() - t0;
  const expected = buildExpectedFromSnapshot(snapshot);
  const actualNormalized = (actual && typeof actual === 'object' && actual.available !== false)
    ? buildActualFromSummary(actual)
    : null;
  if (!actualNormalized) return { ok: false, error: 'runner produced no usable summary', durationMs, expected, actual };
  const tolerance = Number(opts.numericTolerance) > 0 ? Number(opts.numericTolerance) : DEFAULT_NUMERIC_TOLERANCE;
  const diffs = diffFields(expected, actualNormalized, tolerance);
  return {
    ok: true,
    verdict: classifyVerdict(diffs),
    matches: diffs.length === 0,
    diffs,
    expected,
    actual: actualNormalized,
    durationMs,
  };
}

function buildReplayBlock(report, opts = {}) {
  if (!report) return '';
  if (!report.ok) return `\n\n<replay_report>\nError: ${report.error}\n</replay_report>`;
  const lines = ['\n\n<replay_report>'];
  lines.push(`Verdict: ${report.verdict} (diffs: ${report.diffs.length}).`);
  if (report.diffs.length > 0) {
    lines.push('Field diffs:');
    for (const d of report.diffs.slice(0, 8)) {
      const kind = d.kind === 'numeric' ? `Δ ${d.delta}` : d.kind;
      lines.push(`  • ${d.field}: ${JSON.stringify(d.expected)} → ${JSON.stringify(d.actual)} (${kind})`);
    }
  } else {
    lines.push('No tracked fields changed.');
  }
  lines.push(`Replayed in ${report.durationMs} ms.`);
  lines.push('</replay_report>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1200;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  replay, buildReplayBlock, diffFields, classifyVerdict,
  TRACKED_FIELDS, DEFAULT_NUMERIC_TOLERANCE,
};
