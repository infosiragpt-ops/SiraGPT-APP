'use strict';

/**
 * sse-structured-events — typed event emitters for the cognitive
 * pipeline that ride on the existing SSE infrastructure
 * (`progress-stream.js` + `sira-sse-route.js` + `turn-events.js`).
 *
 * Why this exists:
 *  The chat UI today receives `content` chunks and a few legacy events
 *  (`ping`, `[DONE]`, `error`). To surface the new brain-pipeline
 *  outputs (validator scores, hallucination flags, confidence,
 *  coherence) the frontend needs a stable, discriminated-union event
 *  vocabulary it can ignore safely when not understood.
 *
 *  This module gives the backend (and tests) a single way to emit
 *  those events with consistent shape, validation, and safe-by-default
 *  fallback when the SSE sink is absent. The frontend can adopt them
 *  progressively — unknown `type` fields are forwarded as advisory
 *  metadata; nothing breaks if the UI hasn't shipped yet.
 *
 *  All events follow:
 *    { type: <EventType>, ts: <ISOString>, payload: <object> }
 *
 *  Each helper validates the shape, emits via the sink, and returns
 *  the event payload (also useful in tests).
 *
 * Pure, deterministic, dependency-free. No throws under any input.
 *
 * Public API:
 *   createStructuredEmitter(sink)                → Emitter
 *   EVENT_TYPES                                  → string[]
 *
 * Emitter shape:
 *   emitter.brainAudit(verdict)
 *   emitter.validatorComplete(report)
 *   emitter.hallucinationFlagged(report)
 *   emitter.confidenceCalculated(report)
 *   emitter.coherenceEvaluated(report)
 *   emitter.planCritiqued(report)
 *   emitter.skillSelected(skill, intent)
 *   emitter.toolErrorClassified(decision)
 *   emitter.memoryPromotion(plan)
 *   emitter.repairTriggered(reasons)
 *   emitter.brainDelivery(decision)
 */

const EVENT_TYPES = Object.freeze([
  'brain_audit',
  'validator_complete',
  'hallucination_flagged',
  'confidence_calculated',
  'coherence_evaluated',
  'plan_critiqued',
  'skill_selected',
  'tool_error_classified',
  'memory_promotion',
  'repair_triggered',
  'brain_delivery',
]);

function nowIso() {
  return new Date().toISOString();
}

function safe(obj) {
  if (obj == null) return null;
  if (typeof obj !== 'object') return obj;
  try {
    // Round-trip strips functions / symbols / non-cloneable refs
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return null;
  }
}

function emit(sink, event) {
  if (!sink) return event;
  try {
    if (typeof sink.write === 'function') {
      sink.write(`data: ${JSON.stringify(event)}\n\n`);
    } else if (typeof sink.emit === 'function') {
      sink.emit(event);
    } else if (typeof sink === 'function') {
      sink(event);
    }
  } catch { /* swallow */ }
  return event;
}

// ─── Public API ─────────────────────────────────────────────────

function createStructuredEmitter(sink) {
  // Buffer mode for tests: pass `sink = { buffer: [] }` and we'll push
  // events into it instead of writing to a real stream.
  const target = sink && sink.buffer ? {
    emit: (e) => { sink.buffer.push(e); },
  } : sink;

  function build(type, payload) {
    const safePayload = safe(payload);
    return {
      type,
      ts: nowIso(),
      payload: safePayload || {},
    };
  }

  return {
    brainAudit(verdict) {
      if (!verdict) return null;
      return emit(target, build('brain_audit', {
        decision: verdict.decision,
        blocking_flags: verdict.blocking_flags,
        warning_flags: verdict.warning_flags,
        latency_ms: verdict.latency_ms,
        reasons: verdict.reasons,
        repair_hints: (verdict.repair_hints || []).slice(0, 6),
      }));
    },
    validatorComplete(report) {
      if (!report) return null;
      const failed = (report.checks || []).filter(c => c.status === 'failed').length;
      const warning = (report.checks || []).filter(c => c.status === 'warning').length;
      return emit(target, build('validator_complete', {
        validator: report.validator,
        score: report.score,
        failed,
        warning,
        total: (report.checks || []).length,
      }));
    },
    hallucinationFlagged(report) {
      if (!report) return null;
      return emit(target, build('hallucination_flagged', {
        risk: report.overallRisk,
        total: report.totalFlags,
        numbers: (report.unsupportedNumbers || []).length,
        quotes: (report.fabricatedQuotes || []).length,
        citation_drift: (report.citationDrift || []).length,
      }));
    },
    confidenceCalculated(report) {
      if (!report) return null;
      return emit(target, build('confidence_calculated', {
        composite: report.composite,
        recommendation: report.recommendation,
        dominant_risk: report.dominantRisk?.source || null,
        coverage: report.coverage,
      }));
    },
    coherenceEvaluated(report) {
      if (!report) return null;
      return emit(target, build('coherence_evaluated', {
        verdict: report.verdict,
        score: report.score,
        blocking: report.summary?.blocking || 0,
        warning: report.summary?.warning || 0,
      }));
    },
    planCritiqued(report) {
      if (!report) return null;
      return emit(target, build('plan_critiqued', {
        verdict: report.verdict,
        severity: report.severity,
        issues: report.summary?.issue_count || 0,
        blocking: report.summary?.blocking_count || 0,
      }));
    },
    skillSelected(skill, intent) {
      if (!skill) return null;
      return emit(target, build('skill_selected', {
        id: skill.id,
        label: skill.label,
        intent: typeof intent === 'string' ? intent : intent?.id || null,
        estimated_cost: skill.estimated_cost || null,
      }));
    },
    toolErrorClassified(decision) {
      if (!decision) return null;
      return emit(target, build('tool_error_classified', {
        category: decision.category,
        severity: decision.severity,
        retryable: decision.retryable,
        strategy: decision.strategy,
        retry_after_ms: decision.retryAfterMs,
        tool: decision.telemetry?.toolName || null,
      }));
    },
    memoryPromotion(plan) {
      if (!plan) return null;
      return emit(target, build('memory_promotion', {
        promote: plan.summary?.promote_count || 0,
        monitor: plan.summary?.monitor_count || 0,
        skip: plan.summary?.skip_count || 0,
        avg_score: plan.summary?.avg_score || 0,
      }));
    },
    repairTriggered(reasons) {
      return emit(target, build('repair_triggered', {
        reasons: Array.isArray(reasons) ? reasons.slice(0, 8) : [],
      }));
    },
    brainDelivery(decision) {
      return emit(target, build('brain_delivery', {
        decision: typeof decision === 'string' ? decision : decision?.decision || 'unknown',
      }));
    },
  };
}

module.exports = {
  createStructuredEmitter,
  EVENT_TYPES,
  _internal: { build: (type, payload) => ({ type, ts: nowIso(), payload: safe(payload) || {} }), safe, emit },
};
