'use strict';

/**
 * cross-signal-coherence — meta-aggregator that crosses the outputs of
 * separate brain modules and flags inconsistencies BETWEEN them.
 *
 * Why this exists:
 *  Each brain module produces a local verdict:
 *    • document-professional-analyzer → detected_type + classification confidence
 *    • document-insights-engine        → entities, dates, numbers, claims, …
 *    • document-analysis-quality-scorer → overall, coverage, breadth, coherence
 *    • answer-validator                → 9 textual checks
 *    • hallucination-scanner           → unsupported claims, citation drift
 *    • semantic-intent-router          → intent + needs_clarification
 *
 *  Each is correct in isolation, but their JOINT story can be incoherent.
 *  Example:
 *    intent=academic_paper  → high  (the user asked for an academic review)
 *    detected_type=invoice  → high  (analyzer says it's a tax document)
 *    answer_validator says "passed" because the answer is well-formed
 *  …yet the model is reviewing an invoice as if it were a paper.
 *
 *  This module finds those cross-signal contradictions and produces a
 *  unified incoherence report. It does NOT replace the per-module
 *  scoring — it adds a fourth axis: "do all the modules tell the same
 *  story about this turn?"
 *
 * Public API:
 *   scoreCoherence(signals) → CoherenceReport
 *   renderCoherenceBlock(report) → markdown string
 *
 * Signal input shape (every field optional):
 *   {
 *     intent:        { id, label?, confidence?, needs_clarification? },
 *     classification:{ type, confidence?, score? }       // analyzer
 *     insights:      { entities, dates, numbers, claims, risks, statistical },
 *     quality:       { overall, coverage, breadth, coherence }, // existing scorer
 *     answer:        { score, failed_count, warning_count },     // answer-validator
 *     hallucination: { overallRisk, totalFlags, unsupportedNumbers? },
 *     retrieval:     { has_evidence?, score? },
 *   }
 */

// ─── Cross-pair rules ─────────────────────────────────────────────

// Pair semantics: when intent ↔ classification disagree, this is a
// real defect. The table lists "expected classifications" per intent
// label / id. A mismatch is flagged unless the classification is
// `general_document` (the safe default).
const INTENT_TYPE_EXPECTATIONS = {
  analyze_document: new Set(['legal_contract', 'financial_statement', 'academic_paper', 'medical_clinical', 'technical_spec', 'business_report', 'meeting_transcript', 'regulatory_compliance', 'research_proposal', 'patent', 'employment_contract', 'bank_statement', 'insurance_policy', 'incident_postmortem', 'pitch_deck', 'invoice', 'cv_resume', 'book_literature', 'presentation_slides', 'image_document', 'spreadsheet_data', 'source_code', 'configuration_file', 'log_file', 'general_document']),
  research_with_citations: new Set(['academic_paper', 'research_proposal', 'regulatory_compliance', 'business_report', 'general_document']),
  data_analysis: new Set(['spreadsheet_data', 'financial_statement', 'general_document', 'log_file']),
  compare_documents: new Set(['*']), // any
  generate_code: new Set(['source_code', 'configuration_file', 'technical_spec', 'general_document']),
  generate_presentation: new Set(['presentation_slides', 'business_report', 'pitch_deck', 'general_document']),
  text_answer: new Set(['*']),
  agent_long_running_task: new Set(['*']),
};

// ─── Coherence rules ─────────────────────────────────────────────

function checkIntentVsClassification(signals) {
  const intentId = String(signals?.intent?.id || signals?.intent?.label || '').toLowerCase();
  const cls = String(signals?.classification?.type || '').toLowerCase();
  if (!intentId || !cls) return null;
  const expected = INTENT_TYPE_EXPECTATIONS[intentId];
  if (!expected) return null;
  if (expected.has('*')) return null;
  if (expected.has(cls)) return null;
  return {
    code: 'intent_vs_classification_mismatch',
    severity: cls === 'general_document' ? 'info' : 'warning',
    detail: `intent="${intentId}" expected one of {${[...expected].slice(0, 6).join(', ')}…} but classification is "${cls}"`,
  };
}

function checkAnswerVsHallucination(signals) {
  const ansScore = num(signals?.answer?.score);
  const halRisk = String(signals?.hallucination?.overallRisk || '').toLowerCase();
  if (Number.isFinite(ansScore) && ansScore >= 0.85 && halRisk === 'high') {
    return {
      code: 'answer_passes_but_hallucination_high',
      severity: 'blocking',
      detail: `answer_validator score ${(ansScore * 100).toFixed(0)}% but hallucination scanner says HIGH risk`,
    };
  }
  if (Number.isFinite(ansScore) && ansScore < 0.4 && halRisk === 'low') {
    return {
      code: 'answer_fails_but_hallucination_low',
      severity: 'info',
      detail: `answer_validator score ${(ansScore * 100).toFixed(0)}% with low hallucination — failures are structural, not factual`,
    };
  }
  return null;
}

function checkQualityVsAnswer(signals) {
  const qOverall = num(signals?.quality?.overall);
  const ansScore = num(signals?.answer?.score);
  if (!Number.isFinite(qOverall) || !Number.isFinite(ansScore)) return null;
  // Normalise quality to 0..1 (it's 0..100 from quality-scorer)
  const qNorm = qOverall > 1.5 ? qOverall / 100 : qOverall;
  const gap = Math.abs(qNorm - ansScore);
  if (gap > 0.35) {
    return {
      code: 'quality_vs_answer_drift',
      severity: 'warning',
      detail: `analysis quality=${(qNorm * 100).toFixed(0)} but answer_validator=${(ansScore * 100).toFixed(0)} — one of the validators may be miscalibrated for this turn`,
    };
  }
  return null;
}

function checkInsightsVsClassification(signals) {
  const cls = String(signals?.classification?.type || '').toLowerCase();
  const ins = signals?.insights || {};
  if (!cls) return null;
  // academic_paper should have ≥1 bibliographic ref
  if (cls === 'academic_paper') {
    const bib = ins.bibliographic || {};
    const bibHits = arrayLen(bib.dois) + arrayLen(bib.isbns) + arrayLen(bib.arxivIds);
    if (bibHits === 0) {
      return {
        code: 'classification_lacks_evidence',
        severity: 'info',
        detail: 'classified as academic_paper but insights found 0 bibliographic refs',
      };
    }
  }
  // financial_statement / bank_statement should have money mentions
  if (cls === 'financial_statement' || cls === 'bank_statement' || cls === 'invoice') {
    const moneyHits = arrayLen(ins.numbers?.money);
    if (moneyHits === 0) {
      return {
        code: 'classification_lacks_evidence',
        severity: 'info',
        detail: `classified as ${cls} but insights found 0 money mentions`,
      };
    }
  }
  // legal_contract / employment_contract should have entity orgs
  if (cls === 'legal_contract' || cls === 'employment_contract') {
    const orgHits = arrayLen(ins.entities?.organizations);
    if (orgHits === 0) {
      return {
        code: 'classification_lacks_evidence',
        severity: 'info',
        detail: `classified as ${cls} but insights found 0 organisation entities`,
      };
    }
  }
  return null;
}

function checkRetrievalVsHallucination(signals) {
  const hasEvidence = signals?.retrieval?.has_evidence;
  const halFlags = Number(signals?.hallucination?.totalFlags) || 0;
  if (hasEvidence === false && halFlags > 0) {
    return {
      code: 'no_evidence_but_flagged_claims',
      severity: 'warning',
      detail: `retrieval has no evidence yet hallucination scanner flagged ${halFlags} claim(s) — model is operating from prior alone`,
    };
  }
  return null;
}

function checkIntentClarificationVsAnswer(signals) {
  const needs = signals?.intent?.needs_clarification === true;
  const ansScore = num(signals?.answer?.score);
  if (needs && Number.isFinite(ansScore) && ansScore >= 0.75) {
    return {
      code: 'clarification_needed_but_answer_passes',
      severity: 'warning',
      detail: 'intent router flagged needs_clarification=true but a confident answer was produced anyway',
    };
  }
  return null;
}

function checkConfidenceConsistency(signals) {
  // The intent router and the answer validator should not disagree too
  // sharply (low intent confidence + very high answer score = suspect)
  const intentConf = num(signals?.intent?.confidence);
  const ansScore = num(signals?.answer?.score);
  if (!Number.isFinite(intentConf) || !Number.isFinite(ansScore)) return null;
  if (intentConf < 0.4 && ansScore > 0.85) {
    return {
      code: 'low_intent_high_answer',
      severity: 'info',
      detail: `intent classified with ${(intentConf * 100).toFixed(0)}% confidence yet answer scored ${(ansScore * 100).toFixed(0)}% — verify intent before delivery`,
    };
  }
  return null;
}

const RULES = [
  checkIntentVsClassification,
  checkAnswerVsHallucination,
  checkQualityVsAnswer,
  checkInsightsVsClassification,
  checkRetrievalVsHallucination,
  checkIntentClarificationVsAnswer,
  checkConfidenceConsistency,
];

// ─── Public API ───────────────────────────────────────────────

function scoreCoherence(signals = {}) {
  const flags = [];
  for (const rule of RULES) {
    try {
      const flag = rule(signals);
      if (flag) flags.push(flag);
    } catch {
      // Defensive — never let a malformed signal break the scorer
    }
  }
  const blocking = flags.filter(f => f.severity === 'blocking').length;
  const warning = flags.filter(f => f.severity === 'warning').length;
  const info = flags.filter(f => f.severity === 'info').length;
  // 100 baseline; each blocking removes 40, warning 15, info 5
  const score = clamp(100 - blocking * 40 - warning * 15 - info * 5);
  return {
    score,
    grade: gradeFromScore(score),
    flags,
    summary: { total: flags.length, blocking, warning, info },
    verdict: blocking > 0 ? 'incoherent' : warning > 0 ? 'partially_coherent' : 'coherent',
  };
}

function renderCoherenceBlock(report, opts = {}) {
  if (!report) return '';
  const title = opts.title || 'CROSS-SIGNAL COHERENCE';
  if (report.flags.length === 0) {
    return `## ${title}\n**Verdict:** coherent — all brain modules tell the same story (${report.score}/100).`;
  }
  const lines = [];
  lines.push(`## ${title}`);
  lines.push(`**Verdict:** ${report.verdict} (${report.score}/100)`);
  lines.push(`**Flags:** ${report.summary.total} (${report.summary.blocking} blocking · ${report.summary.warning} warning · ${report.summary.info} info)`);
  lines.push('');
  for (const f of report.flags) {
    const icon = f.severity === 'blocking' ? '🔴' : f.severity === 'warning' ? '🟡' : '🟢';
    lines.push(`- ${icon} \`${f.code}\` — ${f.detail}`);
  }
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(n, lo = 0, hi = 100) {
  return Math.min(hi, Math.max(lo, n));
}

function arrayLen(v) {
  return Array.isArray(v) ? v.length : 0;
}

function gradeFromScore(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

module.exports = {
  scoreCoherence,
  renderCoherenceBlock,
  _internal: {
    checkIntentVsClassification,
    checkAnswerVsHallucination,
    checkQualityVsAnswer,
    checkInsightsVsClassification,
    checkRetrievalVsHallucination,
    checkIntentClarificationVsAnswer,
    checkConfidenceConsistency,
    INTENT_TYPE_EXPECTATIONS,
    RULES,
  },
};
