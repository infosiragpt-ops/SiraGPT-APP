'use strict';

/**
 * Cross-Turn Attribution Chain
 *
 * Extends single-turn attribution graphs to a sliding window of conversation
 * turns. Inspired by the attribution-graphs paper's observation that
 * long-range circuits combine features from many earlier tokens to produce a
 * single output. In chat, the equivalent is that a user's current request
 * is rarely interpretable in isolation: it inherits subject from turn N-3,
 * a constraint from turn N-1, and corrects course from turn N.
 *
 * For each of the last K turns, we extract a compact "turn fingerprint"
 * (entities, imperatives, output kind, references), then compute an
 * influence score from each prior turn onto the current one based on:
 *
 *   - shared entities (named coreference)
 *   - explicit references ("the previous", "that one", "como dijiste")
 *   - topic continuity (no domain shift)
 *   - recency decay
 *
 * Output: an ordered chain showing which prior turns most strongly shape
 * the current interpretation, plus a topic-drift score and a list of
 * unresolved coreferences.
 *
 * Heuristic-only (no LLM). Designed to run in <5ms over the last 10 turns.
 */

const REFERENCE_PATTERNS = [
  /\bthat (one|file|doc|document|chart|table|answer|response|result)\b/i,
  /\bthe previous\b/i,
  /\bthe (above|prior|earlier)\b/i,
  /\blast (message|response|answer|reply)\b/i,
  /\bcomo (?:dijiste|mencionaste|comentaste)\b/i,
  /\bel (anterior|previo)\b/i,
  /\beste (archivo|documento|gráfico|tabla|resultado|análisis)\b/i,
  /\barriba\b/i,
  /\babove\b/i,
  /\beste mensaje\b/i,
  /\bantes (?:dij(?:e|iste|imos))\b/i,
  /\bse mencionó\b/i,
];

const TOPIC_VERBS_BY_DOMAIN = Object.freeze({
  code: ['function', 'class', 'module', 'bug', 'error', 'refactor', 'test', 'deploy', 'commit'],
  finance: ['revenue', 'margin', 'cost', 'ebitda', 'profit', 'cash', 'expense', 'budget'],
  legal: ['contract', 'clause', 'liability', 'breach', 'party', 'agreement', 'jurisdiction'],
  product: ['feature', 'user', 'release', 'roadmap', 'launch', 'beta', 'persona'],
  data: ['dataset', 'column', 'row', 'schema', 'query', 'metric', 'aggregate', 'report'],
  research: ['paper', 'study', 'finding', 'hypothesis', 'methodology', 'citation', 'reference'],
  writing: ['article', 'paragraph', 'tone', 'voice', 'audience', 'headline', 'subject'],
});

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'for',
  'with', 'from', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero',
  'para', 'con', 'de', 'en', 'a', 'es', 'son', 'era', 'fue', 'ser',
]);

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];
  const set = new Set();
  const proper = text.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/g);
  if (proper) {
    for (const p of proper) {
      if (p.length >= 3 && p.length <= 60 && !STOP_WORDS.has(p.toLowerCase())) {
        set.add(p);
      }
    }
  }
  const acronyms = text.match(/\b[A-Z]{2,6}\b/g);
  if (acronyms) acronyms.forEach((a) => set.add(a));
  return [...set];
}

function extractTopicTokens(text) {
  if (!text) return new Set();
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  return new Set(tokens.slice(0, 60));
}

function detectDomain(text) {
  if (!text) return null;
  const tokens = extractTopicTokens(text);
  let bestDomain = null;
  let bestHits = 0;
  for (const [domain, keywords] of Object.entries(TOPIC_VERBS_BY_DOMAIN)) {
    let hits = 0;
    for (const kw of keywords) {
      if (tokens.has(kw)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestDomain = domain;
    }
  }
  return bestHits > 0 ? bestDomain : null;
}

function detectReferences(text) {
  if (!text) return [];
  const found = [];
  for (const re of REFERENCE_PATTERNS) {
    const m = text.match(re);
    if (m) found.push(m[0]);
  }
  return found;
}

function buildTurnFingerprint(turn, index) {
  const content = typeof turn === 'string' ? turn : turn?.content || '';
  const role = (typeof turn === 'object' && turn?.role) || 'user';
  return {
    index,
    role,
    content: String(content).slice(0, 2000),
    entities: extractEntities(content),
    tokens: extractTopicTokens(content),
    domain: detectDomain(content),
    references: detectReferences(content),
    createdAt: (typeof turn === 'object' && turn?.createdAt) || null,
  };
}

function jaccard(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const v of setA) {
    if (setB.has(v)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function entityOverlap(a, b) {
  if (!a?.length || !b?.length) return { score: 0, shared: [] };
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const shared = b.filter((s) => setA.has(s.toLowerCase()));
  const score = clamp(shared.length / Math.max(a.length, b.length));
  return { score, shared };
}

function computeInfluence(currentFp, priorFp, distance) {
  const entityRes = entityOverlap(currentFp.entities, priorFp.entities);
  const topicScore = jaccard(currentFp.tokens, priorFp.tokens);
  const refBoost = currentFp.references.length > 0 && distance === 1 ? 0.25 : 0;
  const domainBoost = currentFp.domain && currentFp.domain === priorFp.domain ? 0.1 : 0;
  const recencyDecay = 1 / (1 + Math.log(1 + distance));
  const raw = entityRes.score * 0.45 + topicScore * 0.35 + refBoost + domainBoost;
  const adjusted = clamp(raw * recencyDecay);

  return {
    fromIndex: priorFp.index,
    toIndex: currentFp.index,
    distance,
    entityScore: Number(entityRes.score.toFixed(3)),
    topicScore: Number(topicScore.toFixed(3)),
    refBoost: Number(refBoost.toFixed(3)),
    domainBoost: Number(domainBoost.toFixed(3)),
    recencyDecay: Number(recencyDecay.toFixed(3)),
    influence: Number(adjusted.toFixed(3)),
    sharedEntities: entityRes.shared.slice(0, 8),
    sameDomain: currentFp.domain != null && currentFp.domain === priorFp.domain,
  };
}

function detectUnresolvedCoreferences(currentFp, priorFps) {
  if (currentFp.references.length === 0) return [];
  const unresolved = [];
  const recentEntities = new Set();
  for (const fp of priorFps) {
    for (const e of fp.entities) recentEntities.add(e.toLowerCase());
  }
  for (const ref of currentFp.references) {
    const candidateEntities = currentFp.entities.filter((e) => !recentEntities.has(e.toLowerCase()));
    if (recentEntities.size === 0) {
      unresolved.push({ reference: ref, reason: 'no prior turns to resolve against' });
    } else if (candidateEntities.length === currentFp.entities.length && currentFp.entities.length === 0) {
      unresolved.push({ reference: ref, reason: 'reference uses pronoun-like phrasing but no prior entities found' });
    } else if (priorFps.length > 1 && recentEntities.size > 3) {
      unresolved.push({
        reference: ref,
        reason: 'ambiguous: multiple recent entities could be the antecedent',
        candidates: [...recentEntities].slice(0, 4),
      });
    }
  }
  return unresolved;
}

function computeTopicDrift(fingerprints) {
  if (fingerprints.length < 2) return 0;
  let totalJaccard = 0;
  let pairs = 0;
  for (let i = 1; i < fingerprints.length; i++) {
    totalJaccard += jaccard(fingerprints[i].tokens, fingerprints[i - 1].tokens);
    pairs += 1;
  }
  const avgContinuity = pairs === 0 ? 1 : totalJaccard / pairs;
  return Number(clamp(1 - avgContinuity).toFixed(3));
}

function detectDomainShift(fingerprints) {
  if (fingerprints.length < 2) return null;
  const last = fingerprints[fingerprints.length - 1].domain;
  const prevDomains = fingerprints.slice(-5, -1).map((fp) => fp.domain).filter(Boolean);
  if (!last || prevDomains.length === 0) return null;
  if (!prevDomains.includes(last)) {
    return {
      from: prevDomains[prevDomains.length - 1],
      to: last,
      message: `Domain shifted from ${prevDomains[prevDomains.length - 1]} to ${last}`,
    };
  }
  return null;
}

function buildChain(history, currentQuery, opts = {}) {
  const limit = Math.max(1, Math.min(opts.maxTurns || 10, 20));
  const recent = Array.isArray(history) ? history.slice(-limit) : [];
  const fingerprints = recent.map((turn, i) => buildTurnFingerprint(turn, i));
  const currentFp = buildTurnFingerprint({ content: currentQuery, role: 'user' }, fingerprints.length);

  const influences = [];
  for (let i = 0; i < fingerprints.length; i++) {
    const distance = fingerprints.length - i;
    influences.push(computeInfluence(currentFp, fingerprints[i], distance));
  }
  influences.sort((a, b) => b.influence - a.influence);

  const topInfluences = influences.slice(0, opts.topK || 3);
  const unresolved = detectUnresolvedCoreferences(currentFp, fingerprints);
  const topicDrift = computeTopicDrift([...fingerprints, currentFp]);
  const domainShift = detectDomainShift([...fingerprints, currentFp]);

  return {
    currentFingerprint: currentFp,
    fingerprints,
    influences,
    topInfluences,
    unresolvedCoreferences: unresolved,
    topicDrift,
    domainShift,
    hasContinuity: topInfluences.length > 0 && topInfluences[0].influence >= 0.2,
    needsCorefResolution: unresolved.length > 0,
  };
}

function buildCrossTurnPrompt(result, opts = {}) {
  if (!result) return '';
  const lines = ['### Cross-turn Attribution'];
  if (result.topInfluences.length > 0) {
    const top = result.topInfluences[0];
    if (top.influence >= 0.2) {
      lines.push(`Most influential prior turn: #${top.fromIndex + 1} (influence ${top.influence}, shared entities: ${top.sharedEntities.slice(0, 3).join(', ') || 'none'}).`);
    } else {
      lines.push('Little continuity with prior turns — treat current request as standalone.');
    }
  }
  if (result.unresolvedCoreferences.length > 0) {
    lines.push('Unresolved references in the current turn:');
    for (const u of result.unresolvedCoreferences.slice(0, 3)) {
      lines.push(`- "${u.reference}" → ${u.reason}${u.candidates ? ` (candidates: ${u.candidates.join(', ')})` : ''}`);
    }
    lines.push('Ask one disambiguation question before answering.');
  }
  if (result.topicDrift >= 0.7) {
    lines.push(`High topic drift (${Math.round(result.topicDrift * 100)}%) — user may have switched subjects.`);
  }
  if (result.domainShift) {
    lines.push(`Domain shift detected: ${result.domainShift.message}.`);
  }
  if (opts.includeChain !== false && result.topInfluences.length > 1) {
    lines.push('Top influences:');
    for (const inf of result.topInfluences) {
      lines.push(`- turn #${inf.fromIndex + 1} (influence ${inf.influence}, distance ${inf.distance})`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  REFERENCE_PATTERNS,
  TOPIC_VERBS_BY_DOMAIN,
  buildTurnFingerprint,
  computeInfluence,
  detectUnresolvedCoreferences,
  computeTopicDrift,
  detectDomainShift,
  buildChain,
  buildCrossTurnPrompt,
};
