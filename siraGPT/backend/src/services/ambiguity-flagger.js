'use strict';

/**
 * ambiguity-flagger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects when a user turn is intent-ambiguous (two or more competing
 * interpretations with similar weight) and produces a short, inert
 * prompt block that nudges the assistant to either disambiguate inline
 * or ask a single clarifying question before producing a full answer.
 *
 * Inspired by the high-confidence-vs-competing-circuits observation in
 * Anthropic's attribution-graphs work: when the top two candidates are
 * within a small margin, the model is making a borderline call and
 * should expose that to the user rather than silently picking a lane.
 *
 * Gap classification:
 *   gap ≥ 0.30  → clear
 *   gap ≥ 0.15  → preferred
 *   gap ≥ 0.05  → borderline
 *   gap <  0.05 → ambiguous
 *
 * Extra signals that force ambiguous = true:
 *   • negation surface marker in the user text
 *   • two or more questions in one turn
 *   • two or more distinct scopes detected
 *
 * Pure JS, no LLM call. Hot path < 1 ms.
 *
 * Public API:
 *   flagAmbiguity(report, opts?)         → AmbiguityReport
 *   buildAmbiguityBlock(report, opts?)   → string
 *   buildClarifyingQuestion(report)      → string | null
 *   topCandidates(report)                → Candidate[] (exported for tests)
 */

const NEGATION_RE = /\b(no|don'?t|do\s+not|never|nunca|sin|stop|para\s+de)\b/i;

const CLEAR_GAP = 0.30;
const PREFERRED_GAP = 0.15;
const BORDERLINE_GAP = 0.05;

function pickWeight(intent) {
  if (!intent) return 0;
  return Number(intent.effectiveWeight ?? intent.weight ?? intent.confidence ?? 0);
}

function topCandidates(report) {
  if (!report) return [];
  const candidates = [];
  if (Array.isArray(report.subIntents)) {
    for (const s of report.subIntents) {
      candidates.push({
        verb: s.verb || s.kind || 'intent',
        text: s.text || s.label || '',
        weight: pickWeight(s),
        negated: !!s.negated,
        scope: s.scope || null,
      });
    }
  } else if (report?.summary?.topIntents) {
    for (const s of report.summary.topIntents) {
      candidates.push({
        verb: s.kind || 'intent',
        text: s.text || '',
        weight: pickWeight(s),
        negated: false,
        scope: null,
      });
    }
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates;
}

function detectExtraSignals(text, candidates) {
  const reasons = [];
  const t = String(text || '');
  if (NEGATION_RE.test(t)) reasons.push('negation present in the user message');
  const scopes = new Set(candidates.map((c) => c.scope).filter(Boolean));
  if (scopes.size >= 2) reasons.push(`mixed scopes detected: ${[...scopes].join(', ')}`);
  const questionMarks = (t.match(/\?/g) || []).length;
  if (questionMarks >= 2) reasons.push('multiple questions in one turn');
  return reasons;
}

function classifyGap(gap) {
  if (gap >= CLEAR_GAP) return 'clear';
  if (gap >= PREFERRED_GAP) return 'preferred';
  if (gap >= BORDERLINE_GAP) return 'borderline';
  return 'ambiguous';
}

function buildClarifyingQuestion(report) {
  const candidates = topCandidates(report);
  if (candidates.length < 2) return null;
  const [top1, top2] = candidates;
  const verbToVerb = `${top1.verb} vs ${top2.verb}`;
  return `¿Quieres que ${top1.verb} ${top1.text ? `"${top1.text.slice(0, 80)}"` : 'la intención principal'} o que ${top2.verb} ${top2.text ? `"${top2.text.slice(0, 80)}"` : 'la intención secundaria'}? (Detectado: ${verbToVerb})`;
}

function flagAmbiguity(report, opts = {}) {
  const text = String(opts.userText || report?.input || '');
  const candidates = topCandidates(report);
  if (candidates.length === 0) {
    return {
      ambiguous: false, classification: 'clear', gap: 1,
      top1: null, top2: null, reasons: ['no intents detected'],
    };
  }
  const top1 = candidates[0];
  const top2 = candidates[1] || null;
  const gap = top2 ? top1.weight - top2.weight : 1;
  const classification = classifyGap(gap);
  const reasons = detectExtraSignals(text, candidates);
  const ambiguous = classification === 'ambiguous' || classification === 'borderline' || reasons.length > 0;
  const out = {
    ambiguous, classification, gap: Number(gap.toFixed(3)),
    top1: { verb: top1.verb, text: top1.text, weight: Number(top1.weight.toFixed(3)) },
    top2: top2 ? { verb: top2.verb, text: top2.text, weight: Number(top2.weight.toFixed(3)) } : null,
    reasons,
  };
  if (ambiguous && top2) {
    out.suggestedClarifyingQuestion = buildClarifyingQuestion({ subIntents: candidates });
  }
  return out;
}

function buildAmbiguityBlock(report, opts = {}) {
  if (!report || (!report.ambiguous && report.classification === 'clear')) return '';
  const lines = ['\n\n<intent_ambiguity>'];
  lines.push(`Clasificación: ${report.classification} (gap ${report.gap})`);
  if (report.top1) lines.push(`  • Top intent: ${report.top1.verb} — peso ${report.top1.weight}`);
  if (report.top2) lines.push(`  • Competidor: ${report.top2.verb} — peso ${report.top2.weight}`);
  if (Array.isArray(report.reasons) && report.reasons.length > 0) {
    lines.push('  Señales adicionales:');
    for (const r of report.reasons) lines.push(`    – ${r}`);
  }
  if (report.classification === 'ambiguous' || report.classification === 'borderline') {
    lines.push('  Acción sugerida: si vas a comprometer respuesta, declara tu interpretación primero;');
    lines.push('  si es muy ambiguo, haz UNA pregunta de aclaración corta y atómica.');
    if (report.suggestedClarifyingQuestion) {
      lines.push(`  Pregunta candidata: ${report.suggestedClarifyingQuestion}`);
    }
  }
  lines.push('</intent_ambiguity>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 900;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  flagAmbiguity, buildAmbiguityBlock, buildClarifyingQuestion, topCandidates,
  CLEAR_GAP, PREFERRED_GAP, BORDERLINE_GAP,
};
