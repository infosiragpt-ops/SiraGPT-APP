'use strict';

/**
 * codex/observability-metrics — platform telemetry for /code runs.
 *
 * Companion to PR #247 (frontend per-turn runtime telemetry). This module owns
 * the DURABLE backend signal: counters/histograms registered once in the shared
 * in-process registry (utils/metrics.js) and an error classifier that maps a
 * terminal run into a bounded error_class.
 *
 * Families (all best-effort, never throw — same contract as utils/metrics.js):
 *   siragpt_codex_runs_created_total{mode}
 *   siragpt_codex_run_errors_total{status,error_class,mode}
 *   siragpt_codex_phase_outcomes_total{phase,outcome,mode}   (run-level, durable)
 *   siragpt_codex_run_duration_seconds{mode}
 *   siragpt_codex_run_created_timestamp_seconds{mode}        (gauge, last create)
 *   siragpt_codex_stream_ttfb_ms{mode}
 *   siragpt_codex_stream_chunks_total{surface}
 *
 * The existing run-completion.js terminal counter (siragpt_codex_runs_terminal_total)
 * is left untouched to avoid double counting; this module adds the error-class
 * and duration signal around it.
 */

const metrics = (() => {
  try { return require('../../utils/metrics'); } catch { return null; }
})();

const RUN_ERRORS = 'siragpt_codex_run_errors_total';
const RUNS_CREATED = 'siragpt_codex_runs_created_total';
const PHASE_OUTCOMES = 'siragpt_codex_phase_outcomes_total';
const RUN_DURATION = 'siragpt_codex_run_duration_seconds';
const RUN_CREATED_TS = 'siragpt_codex_run_created_timestamp_seconds';
const STREAM_TTFB = 'siragpt_codex_stream_ttfb_ms';
const STREAM_CHUNKS = 'siragpt_codex_stream_chunks_total';

const ERROR_CLASSES = Object.freeze([
  'timeout',
  'cancelled',
  'plan_parse_failed',
  'payment_required',
  'budget_exceeded',
  'provider_error',
  'tool_failed',
  'stream_abort',
  'internal',
]);

function token(value, fallback = 'unknown') {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function registerAll(registry = metrics) {
  if (!registry) return;
  registry.registerCounter(RUNS_CREATED, {
    help: 'Codex runs created (queued) by mode',
    labels: ['mode'],
    maxSeries: 8,
  });
  registry.registerCounter(RUN_ERRORS, {
    help: 'Terminal Codex runs by final status, error class and mode',
    labels: ['mode', 'status', 'error_class'],
    maxSeries: 128,
  });
  registry.registerCounter(PHASE_OUTCOMES, {
    help: 'Durable run-level phase outcomes (plan|build) by mode',
    labels: ['mode', 'phase', 'outcome'],
    maxSeries: 32,
  });
  registry.registerHistogram(RUN_DURATION, {
    help: 'Codex run wall duration in seconds by mode (startedAt -> finishedAt)',
    labels: ['mode'],
    buckets: [30, 60, 120, 300, 600, 900, 1800, 3600],
    maxSeries: 8,
  });
  registry.registerGauge(RUN_CREATED_TS, {
    help: 'Unix seconds of the most recent Codex run creation by mode',
    labels: ['mode'],
    maxSeries: 8,
  });
  registry.registerHistogram(STREAM_TTFB, {
    help: 'Milliseconds from codex run create to first SSE event by mode',
    labels: ['mode'],
    buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
    maxSeries: 8,
  });
  registry.registerCounter(STREAM_CHUNKS, {
    help: 'SSE chunks written to codex stream clients by surface',
    labels: ['surface'],
    maxSeries: 8,
  });
}

registerAll();

function recordRunCreated({ mode = 'unknown', clock = null } = {}) {
  try {
    const m = token(mode, 'plan');
    metrics?.counter?.(RUNS_CREATED, { mode: m }, 1);
    metrics?.gauge?.(RUN_CREATED_TS, { mode: m }, Math.floor((clock ? clock() : new Date()).getTime() / 1000));
  } catch { /* instrumentation never breaks a run */ }
}

function recordTerminalError({ mode = 'unknown', status = 'error', errorClass = 'internal', clock = null } = {}) {
  try {
    metrics?.counter?.(RUN_ERRORS, {
      mode: token(mode, 'plan'),
      status: token(status, 'error'),
      error_class: token(errorClass, 'internal'),
    }, 1);
  } catch { /* no-op */ }
}

function recordPhaseOutcome({ mode = 'unknown', phase = 'build', outcome = 'ok' } = {}) {
  try {
    metrics?.counter?.(PHASE_OUTCOMES, {
      mode: token(mode, 'plan'),
      phase: token(phase, 'build'),
      outcome: token(outcome, 'ok'),
    }, 1);
  } catch { /* no-op */ }
}

function recordRunDuration({ mode = 'unknown', durationSeconds = 0 } = {}) {
  try {
    const value = Number(durationSeconds);
    if (!Number.isFinite(value) || value < 0) return;
    metrics?.observe?.(RUN_DURATION, { mode: token(mode, 'plan') }, value);
  } catch { /* no-op */ }
}

function recordStreamTtfb({ mode = 'unknown', ttfbMs = 0 } = {}) {
  try {
    const value = Number(ttfbMs);
    if (!Number.isFinite(value) || value < 0) return;
    metrics?.observe?.(STREAM_TTFB, { mode: token(mode, 'plan') }, value);
  } catch { /* no-op */ }
}

function recordStreamChunk({ surface = 'codex' } = {}) {
  try {
    metrics?.counter?.(STREAM_CHUNKS, { surface: token(surface, 'codex') }, 1);
  } catch { /* no-op */ }
}

/**
 * Map a terminal run to a bounded error class.
 *
 * Order matters: cancellation and timeout are structural (own error types),
 * then the explicit budget codes, then plan-mode parse, then provider/payment
 * patterns, then everything else is internal.
 */
function classifyRunError(error, { status = 'error', mode = 'build', message = null } = {}) {
  if (status === 'cancelled') return 'cancelled';
  if (status !== 'error') return null;
  const err = error || {};
  if (err?.isTimeout || err?.name === 'TimeoutError') return 'timeout';
  if (err?.code === 'CODEX_RUN_CANCELLED') return 'cancelled';
  const text = String(
    message
    ?? err?.message
    ?? err?.code
    ?? ''
  );
  if (/budget_already_exceeded|DAILY_BUDGET_EXCEEDED|budget_exceeded/i.test(text)) return 'budget_exceeded';
  if (/402|payment|insufficient[_ ]?credit|quota|OPENROUTER_402|quota_exhausted/i.test(text)) return 'payment_required';
  if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|429|rate.?limit|5\d\d|provider/i.test(text)) return 'provider_error';
  if (/plan[_ ]?parse|parse[_ ]?failed|extractJson/i.test(text)) {
    return mode === 'plan' ? 'plan_parse_failed' : 'internal';
  }
  // Plan mode only reaches a terminal error via parse failure or LLM transport
  // failure; the explicit transport classes were caught above, so an otherwise
  // unclassified plan-mode error is a plan_parse_failed.
  if (mode === 'plan' && /plan|estructurado|[Nn]o se pudo obtener/i.test(text)) return 'plan_parse_failed';
  return 'internal';
}

function normalizeErrorClass(value) {
  const cls = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return ERROR_CLASSES.includes(cls) ? cls : 'internal';
}

module.exports = {
  ERROR_CLASSES,
  RUN_ERRORS,
  RUNS_CREATED,
  PHASE_OUTCOMES,
  RUN_DURATION,
  RUN_CREATED_TS,
  STREAM_TTFB,
  STREAM_CHUNKS,
  classifyRunError,
  normalizeErrorClass,
  recordRunCreated,
  recordTerminalError,
  recordPhaseOutcome,
  recordRunDuration,
  recordStreamTtfb,
  recordStreamChunk,
  registerAll,
  token,
};