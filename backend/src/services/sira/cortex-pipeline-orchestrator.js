'use strict';

/**
 * cortex-pipeline-orchestrator — the glue layer that unifies every new
 * brain module created across this session into a single deterministic
 * pipeline call.
 *
 * Why this exists:
 *  We have rich, well-tested modules (goal-decomposer, plan-critic,
 *  answer-validator, hallucination-scanner, tool-error-classifier,
 *  cross-signal-coherence, confidence-calibrator, memory-promotion-
 *  lifecycle, document-analysis-quality-scorer, document-insights-engine,
 *  document-professional-analyzer). The chat-controller can call them
 *  individually — but every caller writing that orchestration logic by
 *  hand drifts.
 *
 *  This module is the single entry point: hand it the raw artifacts of
 *  one chat turn (envelope, plan, answer, evidence, signals) and it
 *  returns a unified `BrainVerdict` with delivery decision, ranked
 *  flags, and the markdown that the response-builder can splice into
 *  audit logs or system prompts.
 *
 * Pure, deterministic, dependency-free (only requires sibling sira
 * modules which themselves have no I/O). < 10 ms even for large turns.
 *
 * Public API:
 *   runBrainPipeline(input) → BrainVerdict
 *   shouldShip(verdict)     → boolean
 *   renderBrainAuditBlock(verdict, opts?) → markdown
 *
 * Input shape (every field optional):
 *   {
 *     envelope:        the TaskEnvelope (task-envelope-schema.v1)
 *     plan:            agent_plan to critique (or null to skip)
 *     answer:          textual answer about to ship
 *     evidence:        retrieved passages / attachments
 *     insights:        report from document-insights-engine
 *     classification:  output from document-professional-analyzer
 *     quality:         report from document-analysis-quality-scorer
 *     retrieval:       { score, has_evidence, k }
 *     toolHealth:      { errors, last_severity }
 *     intentConfidence number 0..1
 *     modelScore:      number 0..1
 *   }
 *
 * BrainVerdict shape:
 *   {
 *     stage_results: {
 *       plan_critic, answer_validator, hallucination_scanner,
 *       cross_signal_coherence, confidence_calibrator,
 *     },
 *     decision: 'ship' | 'hold_for_review' | 'repair' | 'abort',
 *     reasons: string[],
 *     repair_hints: string[],
 *     blocking_flags: number,
 *     warning_flags: number,
 *     latency_ms: number,
 *   }
 */

const { critiquePlan, suggestRepairs } = require('./plan-critic');
const { validateAnswer } = require('./answer-validator');
const { scanAnswerForHallucinations } = require('./hallucination-scanner');
const { scoreCoherence } = require('./cross-signal-coherence');
const { calibrateConfidence } = require('./confidence-calibrator');

// ─── Public API ──────────────────────────────────────────────────

function runBrainPipeline(input = {}) {
  const startedAt = Date.now();
  const reasons = [];
  const repairHints = [];

  // Stage 1: plan critic (only when a plan is provided)
  let planVerdict = null;
  if (input.plan) {
    planVerdict = critiquePlan(input.plan, { tool_registry: input.toolRegistry });
    if (planVerdict.severity === 'blocking') {
      reasons.push(`plan_critic.${planVerdict.verdict}`);
      repairHints.push(...suggestRepairs(planVerdict));
    }
  }

  // Stage 2: answer validator (only when an answer is provided)
  let answerReport = null;
  if (typeof input.answer === 'string' && input.answer.length > 0) {
    answerReport = validateAnswer({
      envelope: input.envelope || null,
      answer: input.answer,
      evidence: input.evidence || null,
    });
    const failed = answerReport.checks.filter(c => c.status === 'failed');
    if (failed.length > 0) {
      reasons.push(`answer_validator.${failed.length}_failed`);
      for (const f of failed) repairHints.push(`answer: ${f.name} — ${f.detail || 'failed'}`);
    }
  }

  // Stage 3: hallucination scanner (only when answer + evidence are present)
  let hallucination = null;
  if (typeof input.answer === 'string' && input.answer.length > 0 && input.evidence != null) {
    hallucination = scanAnswerForHallucinations({
      answer: input.answer,
      evidence: input.evidence,
    });
    if (hallucination.overallRisk === 'high') {
      reasons.push('hallucination.high_risk');
      for (const num of hallucination.unsupportedNumbers.slice(0, 3)) {
        repairHints.push(`verify or remove unsupported number: ${num}`);
      }
      for (const q of hallucination.fabricatedQuotes.slice(0, 3)) {
        repairHints.push(`verify or remove fabricated quote: "${q.slice(0, 60)}…"`);
      }
    } else if (hallucination.overallRisk === 'medium') {
      reasons.push('hallucination.medium_risk');
    }
  }

  // Stage 4: cross-signal coherence — needs as many signals as we can pass
  const coherenceSignals = {
    intent: input.envelope?.intent_analysis?.primary_intent || input.intent || null,
    classification: input.classification || null,
    insights: input.insights || null,
    quality: input.quality || null,
    answer: answerReport ? aggregateAnswer(answerReport) : null,
    hallucination: hallucination || null,
    retrieval: input.retrieval || null,
  };
  const coherence = scoreCoherence(coherenceSignals);
  if (coherence.verdict === 'incoherent') reasons.push('coherence.incoherent');
  else if (coherence.verdict === 'partially_coherent') reasons.push('coherence.partial');

  // Stage 5: confidence calibrator — aggregate everything
  const calibSignals = {
    intent: {
      confidence: input.intentConfidence
        ?? input.envelope?.intent_analysis?.primary_intent?.confidence
        ?? null,
      needs_clarification: input.envelope?.intent_analysis?.needs_clarification === true,
    },
    retrieval: input.retrieval || null,
    rerank: input.rerank || null,
    validators: input.envelopeValidatorFrame
      ? {
          aggregate_score: input.envelopeValidatorFrame.aggregate_score,
          failed_count: (input.envelopeValidatorFrame.checks || []).filter(c => c.status === 'failed').length,
        }
      : null,
    answer: answerReport ? aggregateAnswer(answerReport) : null,
    hallucination: hallucination || null,
    quality: input.quality || null,
    tool_health: input.toolHealth || null,
    model: input.modelScore != null ? { score: input.modelScore } : null,
  };
  const confidence = calibrateConfidence(calibSignals);

  // ── Decide ───────────────────────────────────────────────────

  let decision = confidence.recommendation; // ship | hold_for_review | repair | abort

  // Plan blocking always escalates to repair
  if (planVerdict && planVerdict.severity === 'blocking' && decision === 'ship') {
    decision = 'repair';
    reasons.push('decision.elevated_due_to_plan_critic');
  }

  // Coherence blocking flips ship → repair
  if (coherence.verdict === 'incoherent' && decision === 'ship') {
    decision = 'repair';
    reasons.push('decision.elevated_due_to_coherence');
  }

  // Aggregate counts
  const blockingFlags
    = (planVerdict?.summary?.blocking_count || 0)
    + coherence.summary.blocking
    + (hallucination?.overallRisk === 'high' ? 1 : 0);
  const warningFlags
    = (planVerdict?.summary?.warning_count || 0)
    + coherence.summary.warning
    + (hallucination?.overallRisk === 'medium' ? 1 : 0)
    + (answerReport ? answerReport.checks.filter(c => c.status === 'warning').length : 0);

  return {
    stage_results: {
      plan_critic: planVerdict,
      answer_validator: answerReport,
      hallucination_scanner: hallucination,
      cross_signal_coherence: coherence,
      confidence_calibrator: confidence,
    },
    decision,
    reasons,
    repair_hints: dedupe(repairHints).slice(0, 12),
    blocking_flags: blockingFlags,
    warning_flags: warningFlags,
    latency_ms: Date.now() - startedAt,
  };
}

function shouldShip(verdict) {
  return verdict?.decision === 'ship';
}

function renderBrainAuditBlock(verdict, opts = {}) {
  if (!verdict) return '';
  const title = opts.title || 'COGNITIVE PIPELINE AUDIT';
  const lines = [];
  lines.push(`## ${title}`);
  lines.push(`**Decision:** \`${verdict.decision}\` · ${verdict.blocking_flags} blocking · ${verdict.warning_flags} warning · ${verdict.latency_ms} ms`);
  if (verdict.reasons.length > 0) {
    lines.push('');
    lines.push('**Reasons:**');
    lines.push(verdict.reasons.map(r => `- \`${r}\``).join('\n'));
  }
  if (verdict.repair_hints.length > 0) {
    lines.push('');
    lines.push('**Repair hints:**');
    lines.push(verdict.repair_hints.slice(0, 6).map(h => `- ${h}`).join('\n'));
  }
  // Per-stage compact line
  const stages = verdict.stage_results || {};
  lines.push('');
  lines.push('| Stage | Verdict |');
  lines.push('|---|---|');
  if (stages.plan_critic) lines.push(`| plan_critic | \`${stages.plan_critic.verdict}\` (${stages.plan_critic.summary.issue_count} issues) |`);
  if (stages.answer_validator) {
    const failed = stages.answer_validator.checks.filter(c => c.status === 'failed').length;
    const warning = stages.answer_validator.checks.filter(c => c.status === 'warning').length;
    lines.push(`| answer_validator | score=${stages.answer_validator.score} · failed=${failed} · warning=${warning} |`);
  }
  if (stages.hallucination_scanner) {
    lines.push(`| hallucination | risk=${stages.hallucination_scanner.overallRisk} · flags=${stages.hallucination_scanner.totalFlags} |`);
  }
  if (stages.cross_signal_coherence) {
    lines.push(`| coherence | \`${stages.cross_signal_coherence.verdict}\` (${stages.cross_signal_coherence.score}/100) |`);
  }
  if (stages.confidence_calibrator) {
    lines.push(`| confidence | composite=${stages.confidence_calibrator.composite} → \`${stages.confidence_calibrator.recommendation}\` |`);
  }
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────

function aggregateAnswer(report) {
  if (!report) return null;
  const failed = report.checks.filter(c => c.status === 'failed').length;
  const warning = report.checks.filter(c => c.status === 'warning').length;
  return { score: report.score, failed_count: failed, warning_count: warning };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

module.exports = {
  runBrainPipeline,
  shouldShip,
  renderBrainAuditBlock,
  _internal: { aggregateAnswer, dedupe },
};
