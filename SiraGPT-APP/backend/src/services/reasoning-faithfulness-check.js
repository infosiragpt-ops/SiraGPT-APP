'use strict';

/**
 * Reasoning Faithfulness Check
 *
 * Inspired by the attribution-graphs paper's findings on motivated /
 * unfaithful chain-of-thought: a model can describe one chain of reasoning
 * while its actual internal computation followed a different path. The same
 * failure mode applies at the agent level — the agent claims "I checked
 * the document and found X" when in fact no document was inspected.
 *
 * This module compares a stated reasoning trace (list of steps the agent
 * said it took, plus the evidence it cited) against the actual evidence
 * pool available in the current turn (documents, memory, tool results) and
 * flags steps whose claimed evidence is missing, weak, or mismatched.
 *
 * Use it as a self-check before returning an answer, or as a post-hoc audit
 * in offline review.
 */

const EVIDENCE_KINDS = Object.freeze({
  DOCUMENT: 'document',
  MEMORY: 'memory',
  HISTORY: 'history',
  TOOL: 'tool',
  WEB: 'web',
  USER_INPUT: 'user_input',
});

const REASONING_VERBS = [
  /^(?:i\s+)?checked\b/i,
  /^(?:i\s+)?reviewed\b/i,
  /^(?:i\s+)?analyzed\b/i,
  /^(?:i\s+)?looked\s+at\b/i,
  /^(?:i\s+)?searched\b/i,
  /^(?:i\s+)?fetched\b/i,
  /^(?:i\s+)?retrieved\b/i,
  /^(?:i\s+)?computed\b/i,
  /^(?:i\s+)?inferred\b/i,
  /^revisé\b/i,
  /^analic[ée]\b/i,
  /^busqué\b/i,
  /^recuperé\b/i,
  /^calculé\b/i,
];

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normaliseEvidencePool(context = {}) {
  const pool = [];

  const documents = Array.isArray(context.documents) ? context.documents : [];
  for (const doc of documents) {
    pool.push({
      kind: EVIDENCE_KINDS.DOCUMENT,
      id: doc?.id || doc?.fileName || doc?.name,
      label: doc?.name || doc?.fileName || 'document',
      snippet: String(doc?.text || doc?.summary || '').slice(0, 4000),
    });
  }

  const memoryFacts = Array.isArray(context.memoryFacts) ? context.memoryFacts : [];
  memoryFacts.forEach((fact, idx) => {
    pool.push({
      kind: EVIDENCE_KINDS.MEMORY,
      id: `mem_${idx}`,
      label: 'memory',
      snippet: String(fact).slice(0, 600),
    });
  });

  const history = Array.isArray(context.history) ? context.history : [];
  history.slice(-4).forEach((turn, idx) => {
    const content = typeof turn === 'string' ? turn : turn?.content;
    pool.push({
      kind: EVIDENCE_KINDS.HISTORY,
      id: `hist_${idx}`,
      label: turn?.role ? `history:${turn.role}` : 'history',
      snippet: String(content || '').slice(0, 1200),
    });
  });

  const tools = Array.isArray(context.toolResults) ? context.toolResults : [];
  for (const tool of tools) {
    pool.push({
      kind: EVIDENCE_KINDS.TOOL,
      id: tool?.id || tool?.name || 'tool',
      label: tool?.name || 'tool',
      snippet: String(tool?.output || tool?.result || '').slice(0, 1500),
    });
  }

  const web = Array.isArray(context.webResults) ? context.webResults : [];
  for (const r of web) {
    pool.push({
      kind: EVIDENCE_KINDS.WEB,
      id: r?.url || r?.id || 'web',
      label: r?.title || r?.url || 'web',
      snippet: String(r?.snippet || r?.content || '').slice(0, 1500),
    });
  }

  if (context.userQuery) {
    pool.push({
      kind: EVIDENCE_KINDS.USER_INPUT,
      id: 'user_query',
      label: 'user_query',
      snippet: String(context.userQuery).slice(0, 1500),
    });
  }

  return pool;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function overlapScore(stepText, snippet) {
  const stepTokens = new Set(tokenize(stepText));
  if (stepTokens.size === 0) return 0;
  const snippetTokens = tokenize(snippet);
  if (snippetTokens.length === 0) return 0;
  let hits = 0;
  for (const tok of snippetTokens) {
    if (stepTokens.has(tok)) hits += 1;
  }
  return clamp(hits / Math.max(stepTokens.size, 8));
}

function findBestEvidence(step, pool, claimedEvidence) {
  let best = null;
  for (const e of pool) {
    if (claimedEvidence && claimedEvidence.length > 0) {
      const matchesClaimed = claimedEvidence.some(
        (c) => c && (e.id?.toString().includes(c) || e.label?.toString().includes(c)),
      );
      if (!matchesClaimed && claimedEvidence.length > 0) continue;
    }
    const score = overlapScore(step?.statement || step?.text || '', e.snippet);
    if (!best || score > best.score) {
      best = { evidence: e, score };
    }
  }
  return best;
}

function classifyStep(step, pool) {
  const claimed = Array.isArray(step?.evidence) ? step.evidence : [];
  const best = findBestEvidence(step, pool, claimed);
  const text = String(step?.statement || step?.text || '');

  const claimsAction = REASONING_VERBS.some((re) => re.test(text.trim()));

  if (!best || best.score < 0.05) {
    if (claimsAction) {
      return {
        ...step,
        verdict: 'unsupported_claim',
        evidenceScore: 0,
        evidenceMatch: null,
        risk: 'high',
        action: 'remove_or_back_with_real_evidence',
      };
    }
    return {
      ...step,
      verdict: 'unverifiable_opinion',
      evidenceScore: 0,
      evidenceMatch: null,
      risk: 'low',
      action: 'mark_as_opinion',
    };
  }

  if (best.score < 0.15) {
    return {
      ...step,
      verdict: 'weak_evidence',
      evidenceScore: Number(best.score.toFixed(3)),
      evidenceMatch: { id: best.evidence.id, kind: best.evidence.kind, label: best.evidence.label },
      risk: 'medium',
      action: 'strengthen_or_hedge',
    };
  }

  if (claimed.length > 0) {
    const claimedMatches = claimed.some(
      (c) => c && (best.evidence.id?.toString().includes(c) || best.evidence.label?.toString().includes(c)),
    );
    if (!claimedMatches) {
      return {
        ...step,
        verdict: 'evidence_mismatch',
        evidenceScore: Number(best.score.toFixed(3)),
        evidenceMatch: { id: best.evidence.id, kind: best.evidence.kind, label: best.evidence.label },
        risk: 'high',
        action: 'cite_correct_source',
      };
    }
  }

  return {
    ...step,
    verdict: 'supported',
    evidenceScore: Number(best.score.toFixed(3)),
    evidenceMatch: { id: best.evidence.id, kind: best.evidence.kind, label: best.evidence.label },
    risk: 'low',
    action: 'ok',
  };
}

function checkFaithfulness(reasoningTrace, context = {}) {
  const steps = Array.isArray(reasoningTrace) ? reasoningTrace : [];
  const pool = normaliseEvidencePool(context);
  const classified = steps.map((s) => classifyStep(s, pool));

  const counts = classified.reduce(
    (acc, s) => {
      acc.total += 1;
      acc[s.verdict] = (acc[s.verdict] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );

  const unsupported = (counts.unsupported_claim || 0) + (counts.evidence_mismatch || 0);
  const supported = counts.supported || 0;

  let faithfulness;
  if (steps.length === 0) faithfulness = 1;
  // Score per step: each supported step counts +1, each unsupported step a
  // -0.25 penalty, normalised by the step count. The penalty MUST be inside the
  // division — `supported / steps.length - unsupported * 0.25` (operator
  // precedence) applied it on the absolute [0,1] scale, so one unsupported step
  // in a 5-step trace dropped the score a flat 0.25 (0.8 → 0.55, not 0.75).
  else faithfulness = clamp((supported - unsupported * 0.25) / steps.length);

  let severity = 'low';
  if (faithfulness < 0.4) severity = 'high';
  else if (faithfulness < 0.7) severity = 'medium';

  return {
    steps: classified,
    counts,
    faithfulness: Number(faithfulness.toFixed(3)),
    severity,
    poolSize: pool.length,
    summary: summarize(classified),
  };
}

function summarize(classified) {
  if (!classified.length) return 'no reasoning steps provided';
  const ok = classified.filter((s) => s.verdict === 'supported').length;
  const bad = classified.filter((s) => s.verdict === 'unsupported_claim' || s.verdict === 'evidence_mismatch').length;
  return `${classified.length} steps · supported=${ok}, unsupported=${bad}`;
}

function buildFaithfulnessPrompt(result, opts = {}) {
  if (!result || !result.steps?.length) return '';
  const lines = ['### Reasoning Faithfulness'];
  lines.push(`Faithfulness score: ${Math.round(result.faithfulness * 100)}% (${result.summary})`);
  const flagged = result.steps
    .filter((s) => s.risk === 'high' || s.risk === 'medium')
    .slice(0, opts.limit || 4);
  if (flagged.length > 0) {
    lines.push('Steps that need attention before responding:');
    for (const s of flagged) {
      lines.push(`- [${s.verdict}] ${(s.statement || s.text || '').slice(0, 100)} → ${s.action}`);
    }
  }
  if (result.severity === 'high') {
    lines.push(
      'High unfaithfulness risk. Before sending, either (a) remove the unsupported claims, or (b) re-do the step with the real evidence.',
    );
  }
  return lines.join('\n');
}

module.exports = {
  EVIDENCE_KINDS,
  normaliseEvidencePool,
  classifyStep,
  checkFaithfulness,
  buildFaithfulnessPrompt,
};
