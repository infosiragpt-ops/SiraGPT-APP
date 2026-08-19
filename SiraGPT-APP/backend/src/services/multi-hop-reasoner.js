'use strict';

/**
 * multi-hop-reasoner.js
 *
 * Detects when a user request requires *multi-hop* reasoning and emits
 * the explicit hops the assistant must resolve before it can answer.
 *
 * Inspired by Anthropic's circuit-tracing finding that LLMs internally
 * perform multi-step reasoning (e.g. "Dallas → Texas → Austin") even when
 * the chain is implicit. At the context-orchestration layer we cannot see
 * the model's neurons, but we *can* see when a turn's surface form
 * requires the assistant to first resolve an intermediate referent (a
 * prior file, a previous decision, a vague pronoun) before it can act.
 *
 * Each detected hop has:
 *   { id, kind, surface, satisfiedBy, resolutionHint, confidence }
 *
 * `satisfiedBy` lists candidate source-node IDs from the attribution
 * graph that could close the hop. `resolutionHint` is a one-line
 * instruction the system prompt can show the model.
 */

const conceptExtractor = require('./concept-extractor');

const MAX_HOPS = 8;

// Pattern catalogue. Each entry detects a "you must look something up first"
// signal and emits a hop.

const HOP_PATTERNS = [
  {
    kind: 'anaphora.prior_turn',
    label: 'Reference to a previous turn',
    test: /\b(?:eso|esto|aquello|lo\s+anterior|el\s+anterior|la\s+anterior|como\s+(?:te\s+)?dije|me\s+refer[ií]a|that|this|the\s+previous|earlier|the\s+thing\s+I\s+(?:said|mentioned))\b/i,
    hint: 'Identify the most recent user turn whose subject matches "%S%" before answering.',
  },
  {
    kind: 'anaphora.prior_file',
    label: 'Reference to a previously attached file',
    test: /\b(?:el\s+(?:archivo|documento|pdf|csv|json)\s+(?:de\s+antes|anterior|que\s+(?:te\s+)?(?:mand[eé]|pas[eé]|envi[eé]))|the\s+(?:file|document|pdf|csv|json)\s+(?:from\s+(?:before|earlier)|I\s+(?:sent|attached|shared)))\b/i,
    hint: 'Locate the prior attachment matching "%S%" in the source list before answering.',
  },
  {
    kind: 'anaphora.prior_decision',
    label: 'Reference to a previous decision or pattern',
    test: /\b(?:como\s+(?:hicimos|lo\s+hicimos)\s+(?:antes|la\s+vez\s+pasada)|igual\s+que\s+(?:antes|la\s+otra\s+vez)|like\s+(?:last\s+time|before|we\s+did)|same\s+(?:pattern|approach)\s+as)\b/i,
    hint: 'Recall the prior decision/pattern matching "%S%" from memory or history; apply it consistently.',
  },
  {
    kind: 'comparison',
    label: 'Comparison across two or more referents',
    test: /\b(?:compara|comparison|diferenc(?:ia|es)|difference|versus|vs\.?|mejor\s+que|peor\s+que|better\s+than|worse\s+than|comparativa)\b/i,
    hint: 'Resolve each side of the comparison "%S%" — identify A, identify B, then contrast them.',
  },
  {
    kind: 'aggregation',
    label: 'Aggregation across multiple sources',
    test: /\b(?:todos?\s+(?:los|las)|cada\s+uno|cada\s+una|all\s+of|every|each|sum(?:mary|arize)\s+(?:of|across)|consolida|consolidate|combina|combine|aggregate)\b/i,
    hint: 'Enumerate all relevant items for "%S%" before producing the aggregated answer.',
  },
  {
    kind: 'chain.then',
    label: 'Conditional or sequential dependency',
    test: /\b(?:primero|despu[eé]s|luego|despues\s+de|entonces|first|then|after\s+that|once\s+you|after\s+you)\b/i,
    hint: 'Resolve the predecessor step in "%S%" before producing the dependent output.',
  },
  {
    kind: 'definition.lookup',
    label: 'Implicit definition / vocabulary lookup',
    test: /\b(?:qu[eé]\s+(?:es|son|significa)|what\s+(?:is|are|does)\s+\w+\s+(?:mean|stand\s+for))\b/i,
    hint: 'Look up the definition first, then apply it to the rest of the request.',
  },
  {
    kind: 'causation',
    label: 'Causal explanation requiring intermediate state',
    test: /\b(?:por\s+qu[eé]|why\s+(?:is|did|does|was)|cu[aá]l\s+es\s+(?:la|el)\s+(?:causa|raz[oó]n)|what\s+caused)\b/i,
    hint: 'Identify the intermediate cause connecting the observed effect in "%S%" to the user’s scenario.',
  },
  {
    kind: 'conditional',
    label: 'Conditional / hypothetical reasoning',
    test: /\b(?:si\s+(?:hago|hacemos|fuera|fuese|tuviese|tuviera)|if\s+(?:I|we|you)\s+(?:do|did|were|had)|what\s+if|suppose)\b/i,
    hint: 'Compute the consequence of the hypothetical condition in "%S%" before answering.',
  },
  {
    kind: 'translation.consistency',
    label: 'Cross-language reference consistency',
    test: /\b(?:traduce.*pero|translate.*keeping|en\s+(?:espa[ñn]ol|ingl[eé]s)\s+pero|in\s+(?:english|spanish)\s+but)\b/i,
    hint: 'Translate "%S%" while preserving the constraints already stated in the source language.',
  },
  {
    kind: 'planning.precondition',
    label: 'Goal whose execution needs a plan first',
    test: /\b(?:plan|roadmap|paso\s+a\s+paso|step\s+by\s+step|secuencia|sequence|phases|fases|milestones)\b/i,
    hint: 'Produce an explicit plan for "%S%" before executing any individual step.',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function safeText(s) { return String(s == null ? '' : s).slice(0, 4000); }

function candidatesFromHistory(history = []) {
  // Build a recency-ordered list of (id, label, snippet) candidates.
  const out = [];
  const arr = Array.isArray(history) ? history.slice(-20) : [];
  arr.forEach((m, idx) => {
    if (!m) return;
    const role = String(m.role || 'user').toLowerCase();
    const text = String(m.content || m.text || '').slice(0, 240);
    if (!text.trim()) return;
    out.push({
      id: `turn#${idx + 1}`,
      role,
      snippet: text,
    });
  });
  return out.reverse();
}

function candidatesFromFiles(files = []) {
  return (Array.isArray(files) ? files.slice(0, 12) : []).map((f, i) => ({
    id: `file#${i + 1}`,
    name: f?.name || f?.id || `file-${i + 1}`,
    snippet: String(f?.summary || f?.text || '').slice(0, 200),
  }));
}

function candidatesFromMemories(memories = []) {
  return (Array.isArray(memories) ? memories.slice(0, 12) : []).map((m, i) => ({
    id: `mem#${i + 1}`,
    category: m?.category || 'general',
    snippet: String(m?.fact || m?.text || '').slice(0, 200),
  }));
}

function matchCandidates(hopKind, prompt, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const lower = String(prompt || '').toLowerCase();
  const tokens = new Set(lower.split(/\s+/).filter(Boolean));
  const scored = candidates.map((c) => {
    const text = String(c.snippet || c.name || c.category || '').toLowerCase();
    let overlap = 0;
    for (const t of text.split(/\s+/)) if (t.length > 3 && tokens.has(t)) overlap++;
    return { id: c.id, overlap, snippet: c.snippet };
  });
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, 3).filter((s) => s.overlap > 0 || hopKind.startsWith('anaphora'));
}

// ── Public API ─────────────────────────────────────────────────────────────

function detectHops({ prompt = '', history = [], files = [], memories = [] } = {}) {
  const safe = safeText(prompt);
  if (!safe.trim()) {
    return { isMultiHop: false, hops: [], depth: 0 };
  }

  const turnCands = candidatesFromHistory(history);
  const fileCands = candidatesFromFiles(files);
  const memCands = candidatesFromMemories(memories);

  const hops = [];
  for (const pat of HOP_PATTERNS) {
    const m = safe.match(pat.test);
    if (!m) continue;
    const surface = m[0];
    let cands = [];
    if (pat.kind.startsWith('anaphora.prior_turn')) cands = matchCandidates(pat.kind, safe, turnCands);
    else if (pat.kind === 'anaphora.prior_file') cands = matchCandidates(pat.kind, safe, fileCands);
    else if (pat.kind === 'anaphora.prior_decision') cands = matchCandidates(pat.kind, safe, [...memCands, ...turnCands]);
    else if (pat.kind === 'aggregation') cands = matchCandidates(pat.kind, safe, [...fileCands, ...turnCands]);
    else if (pat.kind === 'comparison') cands = matchCandidates(pat.kind, safe, [...fileCands, ...turnCands]);
    const confidence = computeConfidence(pat.kind, surface, cands);
    hops.push({
      id: `hop_${hops.length + 1}`,
      kind: pat.kind,
      label: pat.label,
      surface,
      satisfiedBy: cands.map((c) => c.id),
      candidateSnippets: cands.map((c) => c.snippet?.slice(0, 80)).filter(Boolean),
      resolutionHint: pat.hint.replace('%S%', surface.slice(0, 60)),
      confidence,
    });
    if (hops.length >= MAX_HOPS) break;
  }

  // Concept-driven extra hops: if user mentioned multiple distinct entities
  // and asks for a "comparison" or "fold", emit a structural hop.
  const { concepts } = conceptExtractor.extractConcepts(safe);
  const namedEntities = concepts.filter((c) => c.kind === 'entity.named').slice(0, 5);
  if (namedEntities.length >= 2 && !hops.some((h) => h.kind === 'comparison')) {
    hops.push({
      id: `hop_${hops.length + 1}`,
      kind: 'implicit.multi_entity',
      label: 'Multiple distinct entities mentioned',
      surface: namedEntities.map((e) => e.surface).join(' & '),
      satisfiedBy: [],
      candidateSnippets: [],
      resolutionHint: 'Treat each named entity as a separate target; produce per-entity sub-answers, then combine.',
      confidence: 0.55,
    });
  }

  return {
    isMultiHop: hops.length >= 1,
    depth: hops.length,
    hops,
    metrics: {
      historyConsidered: turnCands.length,
      filesConsidered: fileCands.length,
      memoriesConsidered: memCands.length,
      namedEntities: namedEntities.length,
    },
  };
}

function computeConfidence(kind, surface, cands) {
  const base = 0.4;
  const surfaceBoost = Math.min(0.25, surface.length / 80);
  const candidateBoost = Math.min(0.3, (cands?.length || 0) * 0.1);
  const kindBoost = kind.startsWith('anaphora') ? 0.15 : 0;
  return Math.min(1, base + surfaceBoost + candidateBoost + kindBoost);
}

function renderHopsBlock(result, opts = {}) {
  if (!result || !result.isMultiHop || !result.hops.length) return '';
  const lines = [];
  lines.push('## MULTI-HOP RESOLUTION REQUIRED');
  lines.push(`The current request needs ${result.hops.length} resolution step(s) before producing the final answer. Resolve each hop explicitly (internally) before responding.`);
  for (const h of result.hops) {
    lines.push(`- [${h.kind} · conf=${Math.round(h.confidence * 100)}%] ${h.label}`);
    lines.push(`  • Surface clue: "${h.surface}"`);
    if (h.satisfiedBy?.length) {
      lines.push(`  • Candidate sources: ${h.satisfiedBy.join(', ')}`);
    }
    lines.push(`  • Hint: ${h.resolutionHint}`);
  }
  const cap = Math.max(800, Number(opts.maxChars) || 2200);
  const out = lines.join('\n');
  if (out.length > cap) return `${out.slice(0, cap - 80).trimEnd()}\n… [hops truncated]`;
  return out;
}

module.exports = {
  detectHops,
  renderHopsBlock,
  HOP_PATTERNS,
};
