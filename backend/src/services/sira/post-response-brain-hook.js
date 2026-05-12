'use strict';

/**
 * post-response-brain-hook — defensive wrapper that runs the cortex
 * pipeline in SHADOW MODE after the LLM produces the assistant reply.
 *
 * Why this exists:
 *  Wiring the brain pipeline into the live chat path is risky — a bug
 *  anywhere in the new modules would break delivery. This hook gives
 *  routes/ai.js a single, fire-and-forget call that:
 *
 *    1. Runs runBrainPipeline() on the just-finished turn
 *    2. Catches EVERY exception silently (never breaks the response)
 *    3. Logs the verdict + reasons + timings as structured JSON
 *    4. Records to OTel + Langfuse when available (best-effort)
 *    5. Optionally emits a turn-event so SSE consumers can react
 *
 *  No enforcement — the verdict is recorded but the user's response is
 *  delivered regardless. Once we have weeks of shadow data, the
 *  enforcement flag can flip without code changes to ai.js.
 *
 * Pure async wrapper. No throws under any input. < 10 ms.
 *
 * Public API:
 *   runShadowModeBrainPipeline(input, options?) → Promise<VerdictOrNull>
 *
 * Options:
 *   { eventsSink?, enforce?, logger?, telemetry? }
 *
 *   enforce=false (default) — just logs and returns; the caller
 *     ignores the return value, response goes out unchanged.
 *   enforce=true            — caller is expected to read the return
 *     value and may use it to short-circuit / repair before delivery.
 */

const { runBrainPipeline, renderBrainAuditBlock } = require('./cortex-pipeline-orchestrator');

const SHADOW_LOG_LEVEL = process.env.SIRAGPT_BRAIN_SHADOW_LOG_LEVEL || 'info';
const SHADOW_ENABLED = process.env.SIRAGPT_BRAIN_SHADOW_DISABLE !== '1';
const ENFORCE_FROM_ENV = process.env.SIRAGPT_BRAIN_ENFORCE === '1';

function runShadowModeBrainPipeline(input = {}, options = {}) {
  if (!SHADOW_ENABLED) return Promise.resolve(null);
  // Make the whole thing synchronous-friendly by returning a Promise
  // that never rejects.
  return new Promise((resolve) => {
    let verdict = null;
    try {
      verdict = runBrainPipeline(input);
    } catch (err) {
      safeLog(options.logger, 'warn', 'brain.pipeline.exception', { error: err && err.message ? err.message : String(err) });
      resolve(null);
      return;
    }

    try {
      logVerdict(verdict, input, options);
    } catch { /* swallow */ }

    try { emitSseEvent(verdict, options); } catch { /* swallow */ }
    try { emitTelemetry(verdict, options); } catch { /* swallow */ }

    const enforce = options.enforce === true || (options.enforce !== false && ENFORCE_FROM_ENV);
    resolve(enforce ? verdict : null);
  });
}

function logVerdict(verdict, input, options) {
  if (!verdict) return;
  const logger = options.logger || console;
  const payload = {
    event: 'brain_shadow_audit',
    decision: verdict.decision,
    blocking_flags: verdict.blocking_flags,
    warning_flags: verdict.warning_flags,
    latency_ms: verdict.latency_ms,
    reasons: verdict.reasons,
    repair_hints_count: verdict.repair_hints?.length || 0,
    request_id: input?.envelope?.request_id || null,
    user_id: input?.userId || null,
    chat_id: input?.chatId || null,
  };
  // Structured one-line JSON log; downstream log aggregators can index it.
  const message = `[brain] ${verdict.decision} · ${verdict.blocking_flags}b/${verdict.warning_flags}w · ${verdict.latency_ms}ms`;
  if (SHADOW_LOG_LEVEL === 'debug') {
    logger.log(message, JSON.stringify(payload));
  } else if (verdict.decision === 'abort' || verdict.decision === 'repair') {
    logger.warn(message, JSON.stringify(payload));
  } else {
    logger.log(message);
  }
}

function emitSseEvent(verdict, options) {
  const sink = options.eventsSink;
  if (!sink || typeof sink.emit !== 'function') return;
  sink.emit({
    type: 'brain_audit',
    payload: {
      decision: verdict.decision,
      blocking_flags: verdict.blocking_flags,
      warning_flags: verdict.warning_flags,
      latency_ms: verdict.latency_ms,
      reasons: verdict.reasons,
      // Stage-level summaries (no full reports — those can be huge)
      stages: summariseStages(verdict.stage_results),
    },
  });
}

function emitTelemetry(verdict, options) {
  const tracer = options.telemetry;
  if (!tracer || typeof tracer.recordVerdict !== 'function') return;
  tracer.recordVerdict({
    decision: verdict.decision,
    blocking_flags: verdict.blocking_flags,
    warning_flags: verdict.warning_flags,
    latency_ms: verdict.latency_ms,
  });
}

function summariseStages(stageResults) {
  if (!stageResults) return null;
  const out = {};
  if (stageResults.plan_critic) {
    out.plan_critic = {
      verdict: stageResults.plan_critic.verdict,
      issues: stageResults.plan_critic.summary?.issue_count || 0,
    };
  }
  if (stageResults.answer_validator) {
    const failed = stageResults.answer_validator.checks.filter(c => c.status === 'failed').length;
    out.answer_validator = {
      score: stageResults.answer_validator.score,
      failed,
    };
  }
  if (stageResults.hallucination_scanner) {
    out.hallucination = {
      risk: stageResults.hallucination_scanner.overallRisk,
      flags: stageResults.hallucination_scanner.totalFlags,
    };
  }
  if (stageResults.cross_signal_coherence) {
    out.coherence = {
      verdict: stageResults.cross_signal_coherence.verdict,
      score: stageResults.cross_signal_coherence.score,
    };
  }
  if (stageResults.confidence_calibrator) {
    out.confidence = {
      composite: stageResults.confidence_calibrator.composite,
      recommendation: stageResults.confidence_calibrator.recommendation,
    };
  }
  return out;
}

function safeLog(logger, level, message, extra) {
  const log = logger || console;
  const fn = log[level] || log.log || (() => {});
  try { fn.call(log, `[brain] ${message}`, JSON.stringify(extra || {})); } catch { /* swallow */ }
}

module.exports = {
  runShadowModeBrainPipeline,
  renderBrainAuditBlock, // re-export for caller convenience
  _internal: { logVerdict, summariseStages, SHADOW_ENABLED, ENFORCE_FROM_ENV },
};
