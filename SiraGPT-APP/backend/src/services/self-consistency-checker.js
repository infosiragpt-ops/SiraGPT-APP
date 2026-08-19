'use strict';

/**
 * Self-Consistency Checker
 *
 * Scans a draft response (or any text the agent is about to send) for
 * internal contradictions BEFORE it ships. Inspired by the attribution-
 * graphs paper's observation that a model can hold contradictory features
 * simultaneously and surface them in different parts of an output. We do
 * a fast surface check across four contradiction families:
 *
 *   - numeric: same labelled number stated with different values
 *     (e.g. "revenue was $5M" and later "revenue was $7M")
 *   - date: same labelled event with different dates
 *   - entity-claim: same subject asserted as both X and ¬X
 *   - polarity: a sentence with strong positive + strong negative claims
 *     about the same subject within a small window
 *
 * Heuristic-only, no LLM. Runs in <2ms on typical responses. Designed to
 * be called right before flushing a response so the agent can either
 * rewrite or hedge before sending.
 */

const POSITIVE_WORDS = new Set([
  'improved', 'increased', 'rose', 'gained', 'grew', 'expanded',
  'launched', 'succeeded', 'won', 'achieved', 'beat', 'exceeded',
  'mejoró', 'aumentó', 'creció', 'ganó', 'logró', 'superó',
]);

const NEGATIVE_WORDS = new Set([
  'declined', 'fell', 'dropped', 'lost', 'shrank', 'contracted',
  'cancelled', 'failed', 'missed', 'underperformed', 'lagged',
  'cayó', 'disminuyó', 'perdió', 'falló', 'no logró', 'rezagado',
]);

const NEGATION_PATTERNS = [
  /\b(?:not|never|no(?:t)?|nunca|ningún|ninguna|sin)\b/i,
];

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractLabeledNumbers(text) {
  if (!text) return [];
  const out = [];
  const re = /([A-Za-z][a-zA-Z\s]{2,30}?)(?:\s+(?:was|is|were|are|of|reached|hit|reported|fueron|fue|alcanzó))?\s*(?:[:=]\s*)?(\$|€|£)?\s*(\d+(?:[.,]\d+)?)(\s*(?:%|percent|m|million|b|billion|k))?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = String(m[1] || '').trim().toLowerCase();
    if (!label || label.length < 3) continue;
    const currency = (m[2] || '').trim();
    const value = m[3];
    const unit = (m[4] || '').trim().toLowerCase();
    if (!value) continue;
    out.push({
      label,
      raw: m[0].trim(),
      value: Number(value.replace(/,/g, '')),
      currency,
      unit,
      offset: m.index,
    });
    if (out.length >= 30) break;
  }
  return out;
}

function extractLabeledDates(text) {
  if (!text) return [];
  const out = [];
  const re = /([A-Za-z][a-zA-Z\s]{2,30}?)(?:\s+(?:was|is|on|happened|occurred|took place|sucedió|fue|ocurrió))\s+(?:in\s+|on\s+|en\s+)?((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)?\s*\d{4}|(?:Q[1-4]\s*\d{2,4}))/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = String(m[1] || '').trim().toLowerCase();
    const date = String(m[2] || '').trim().toLowerCase();
    if (!label || !date) continue;
    out.push({ label, date, raw: m[0].trim(), offset: m.index });
    if (out.length >= 20) break;
  }
  return out;
}

function detectNumericContradictions(numbers) {
  const byLabel = new Map();
  for (const n of numbers) {
    if (!byLabel.has(n.label)) byLabel.set(n.label, []);
    byLabel.get(n.label).push(n);
  }
  const contradictions = [];
  for (const [label, values] of byLabel.entries()) {
    if (values.length < 2) continue;
    const uniqueValues = new Set(values.map((v) => `${v.value}${v.unit || ''}${v.currency || ''}`));
    if (uniqueValues.size > 1) {
      contradictions.push({
        kind: 'numeric',
        label,
        values: values.map((v) => v.raw),
        severity: uniqueValues.size > 2 ? 'high' : 'medium',
      });
    }
  }
  return contradictions;
}

function detectDateContradictions(dates) {
  const byLabel = new Map();
  for (const d of dates) {
    if (!byLabel.has(d.label)) byLabel.set(d.label, []);
    byLabel.get(d.label).push(d);
  }
  const contradictions = [];
  for (const [label, entries] of byLabel.entries()) {
    if (entries.length < 2) continue;
    const uniqueDates = new Set(entries.map((e) => e.date.replace(/\s+/g, ' ').trim()));
    if (uniqueDates.size > 1) {
      contradictions.push({
        kind: 'date',
        label,
        dates: [...uniqueDates],
        severity: 'medium',
      });
    }
  }
  return contradictions;
}

function sentencePolarity(sentence) {
  if (!sentence) return 0;
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) score += 1;
  }
  for (const w of NEGATIVE_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) score -= 1;
  }
  for (const pat of NEGATION_PATTERNS) {
    if (pat.test(lower)) score = -score;
  }
  return score;
}

function detectPolarityContradictions(text, opts = {}) {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return [];
  const window = opts.window || 5;
  const contradictions = [];

  const subjectExtract = (sentence) => {
    const m = sentence.match(/\b([A-Z][a-zA-Z0-9]{2,})\b/);
    return m ? m[1].toLowerCase() : null;
  };

  for (let i = 0; i < sentences.length; i++) {
    const subjA = subjectExtract(sentences[i]);
    const polA = sentencePolarity(sentences[i]);
    if (!subjA || polA === 0) continue;

    for (let j = i + 1; j < Math.min(i + 1 + window, sentences.length); j++) {
      const subjB = subjectExtract(sentences[j]);
      const polB = sentencePolarity(sentences[j]);
      if (!subjB || polB === 0) continue;
      if (subjA === subjB && Math.sign(polA) !== Math.sign(polB)) {
        contradictions.push({
          kind: 'polarity',
          subject: subjA,
          sentenceA: sentences[i].slice(0, 140),
          sentenceB: sentences[j].slice(0, 140),
          severity: 'high',
        });
        if (contradictions.length >= 10) return contradictions;
      }
    }
  }
  return contradictions;
}

function detectEntityClaimContradictions(text) {
  if (!text) return [];
  const contradictions = [];
  const re = /\b([A-Z][a-zA-Z0-9]{2,})\s+(is|are|was|were)\s+(not\s+)?([a-z]+)/g;
  const claims = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const subject = m[1].toLowerCase();
    const negated = Boolean(m[3]);
    const adjective = m[4].toLowerCase();
    const key = `${subject}::${adjective}`;
    const existing = claims.get(key);
    if (existing != null && existing !== negated) {
      contradictions.push({
        kind: 'entity_claim',
        subject,
        adjective,
        severity: 'high',
        statements: ['affirmed', 'negated'],
      });
    } else if (existing == null) {
      claims.set(key, negated);
    }
  }
  return contradictions;
}

function check(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    return {
      contradictions: [],
      counts: { total: 0 },
      score: 1,
      severity: 'low',
      summary: 'no text to check',
    };
  }

  const numbers = extractLabeledNumbers(text);
  const dates = extractLabeledDates(text);

  const numeric = detectNumericContradictions(numbers);
  const dateConflicts = detectDateContradictions(dates);
  const polarity = detectPolarityContradictions(text, opts);
  const entityClaim = detectEntityClaimContradictions(text);

  const all = [...numeric, ...dateConflicts, ...polarity, ...entityClaim];
  const counts = all.reduce(
    (acc, c) => {
      acc.total += 1;
      acc[c.kind] = (acc[c.kind] || 0) + 1;
      acc[`severity_${c.severity}`] = (acc[`severity_${c.severity}`] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );

  const highCount = counts.severity_high || 0;
  const mediumCount = counts.severity_medium || 0;
  const score = clamp(1 - highCount * 0.25 - mediumCount * 0.1);
  let severity = 'low';
  if (highCount >= 2 || score < 0.4) severity = 'high';
  else if (highCount >= 1 || score < 0.7) severity = 'medium';

  return {
    contradictions: all,
    counts,
    score: Number(score.toFixed(3)),
    severity,
    summary: all.length === 0
      ? 'no contradictions detected'
      : `${all.length} contradiction${all.length === 1 ? '' : 's'} (severity ${severity})`,
  };
}

function buildSelfConsistencyPrompt(result, opts = {}) {
  if (!result || !result.contradictions?.length) return '';
  const lines = ['### Self-Consistency Check'];
  lines.push(`${result.summary} · consistency score ${result.score}.`);
  const limit = opts.limit || 5;
  for (const c of result.contradictions.slice(0, limit)) {
    if (c.kind === 'numeric') {
      lines.push(`- numeric "${c.label}" stated multiple values: ${c.values.join(' vs ')}`);
    } else if (c.kind === 'date') {
      lines.push(`- date "${c.label}" stated multiple values: ${c.dates.join(' vs ')}`);
    } else if (c.kind === 'polarity') {
      lines.push(`- polarity clash on "${c.subject}": "${c.sentenceA}" ↔ "${c.sentenceB}"`);
    } else if (c.kind === 'entity_claim') {
      lines.push(`- "${c.subject} ${c.adjective}" both affirmed and negated`);
    }
  }
  if (result.severity === 'high') {
    lines.push('Severe internal contradiction — rewrite before sending, or explicitly note the source of the discrepancy.');
  }
  return lines.join('\n');
}

module.exports = {
  splitSentences,
  extractLabeledNumbers,
  extractLabeledDates,
  detectNumericContradictions,
  detectDateContradictions,
  detectPolarityContradictions,
  detectEntityClaimContradictions,
  check,
  buildSelfConsistencyPrompt,
};
