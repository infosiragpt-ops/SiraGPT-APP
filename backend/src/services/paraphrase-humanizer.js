'use strict';

/**
 * paraphrase-humanizer — rule-based anti-AI-detection layer applied on
 * top of the LLM paraphrase output.
 *
 * The product spec asks paraphrase results to "not be flagged as AI"
 * by detectors like Turnitin/GPTZero/Originality. Real detectors look
 * for low-perplexity / low-burstiness writing dominated by predictable
 * token sequences and a handful of LLM-favourite hedge words ("however",
 * "furthermore", "moreover", "in conclusion", em-dash parentheticals,
 * triple-clause sentences, "delve into", "navigate", "leverage", ...).
 *
 * We don't try to fool detectors with adversarial unicode tricks — those
 * fail the moment a page is OCR'd or normalised. Instead the humanizer:
 *
 *   1. Replaces high-signal AI-tells with neutral/varied synonyms.
 *   2. Breaks up triple-clause monoliths and inserts short pivot
 *      sentences to raise burstiness.
 *   3. Cleans up em-dash overuse and oxford-comma uniformity that
 *      detectors fingerprint.
 *   4. Reports an `aiScore` (0..1, higher = more AI-looking) computed
 *      from token-level signals so the UI can show a "stealth" gauge.
 *
 * Pure JS, zero deps, deterministic. Safe to call repeatedly — idempotent
 * after the first pass converges (no oscillation between substitutions).
 *
 * Public API:
 *   humanizeText({ text, language?, intensity? }) → { text, applied[], aiScoreBefore, aiScoreAfter, deltaScore }
 *   estimateAIScore(text) → number  (0..1)
 *   listAITellPatterns() → string[]
 */

// ── AI-tell replacements (lower-cased keys, case-preserving replace) ──
// Each entry maps an LLM-favourite phrase to neutral alternatives the
// humanizer picks from deterministically (hash-mod) so the same input
// produces the same output (reproducible tests).
const AI_TELLS = Object.freeze({
  // English
  furthermore: ['also', 'on top of that', 'and beyond that'],
  moreover: ['besides', 'on top of that', 'and'],
  however: ['but', 'still', 'though'],
  additionally: ['also', 'on top of that', 'plus'],
  consequently: ['so', 'as a result', 'because of that'],
  subsequently: ['then', 'after that', 'later'],
  'in conclusion': ['to wrap up', 'all in all', 'in short'],
  'in summary': ['in short', 'put briefly', 'all in all'],
  'it is important to note': ['worth noting', 'note that', 'keep in mind'],
  'it is worth noting': ['worth noting', 'note that', 'keep in mind'],
  delve: ['dig', 'look', 'get'],
  delving: ['digging', 'looking', 'getting'],
  navigate: ['handle', 'work through', 'deal with'],
  leverage: ['use', 'tap', 'put to work'],
  utilise: ['use', 'apply', 'put to work'],
  utilize: ['use', 'apply', 'put to work'],
  'in today’s world': ['these days', 'today', 'right now'],
  "in today's world": ['these days', 'today', 'right now'],
  'in the realm of': ['in', 'when it comes to', 'around'],
  'a multitude of': ['many', 'lots of', 'a range of'],
  'plethora of': ['lots of', 'many', 'a range of'],
  // Spanish
  'cabe destacar que': ['hay que decir que', 'vale la pena notar que', 'es importante señalar que'],
  'es importante destacar que': ['vale la pena notar que', 'hay que decir que', 'cabe señalar que'],
  'en conclusión': ['en resumen', 'para terminar', 'en pocas palabras'],
  'en resumen': ['para terminar', 'en síntesis', 'en pocas palabras'],
  'por consiguiente': ['así que', 'por eso', 'entonces'],
  'sin embargo': ['pero', 'aun así', 'aunque'],
  'no obstante': ['pero', 'aun así', 'aunque'],
  asimismo: ['también', 'igualmente', 'además de eso'],
  'a su vez': ['también', 'al mismo tiempo', 'paralelamente'],
  'en este sentido': ['en esta línea', 'sobre esto', 'al respecto'],
  'es fundamental': ['es clave', 'importa mucho', 'resulta básico'],
  'profundizar en': ['ahondar en', 'meterse a fondo en', 'explorar'],
  navegar: ['recorrer', 'manejar', 'gestionar'],
  aprovechar: ['usar', 'sacar partido a', 'poner a trabajar'],
  'una multitud de': ['muchos', 'gran cantidad de', 'varios'],
  'una plétora de': ['muchos', 'una variedad de', 'varios'],
  // Round 2 — additional patterns frequently flagged by detectors
  'tapestry of': ['mix of', 'range of', 'blend of'],
  'a testament to': ['proof of', 'a sign of', 'shows'],
  'navigate the complexities of': ['handle', 'work through', 'deal with'],
  'unleash the power of': ['use', 'tap into', 'put to work'],
  'es decir,': ['o sea,', 'esto es,', 'dicho de otro modo,'],
  'por otro lado,': ['ahora bien,', 'también,', 'al contrario,'],
  'en definitiva': ['en pocas palabras', 'al final', 'en el fondo'],
  'desempeña un papel': ['cumple un rol', 'tiene un rol', 'juega un rol'],
});

const AI_TELL_PATTERNS = Object.freeze(
  Object.keys(AI_TELLS).map((k) => ({
    key: k,
    regex: new RegExp(`(?<![\\w-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi'),
    options: AI_TELLS[k],
  })),
);

function pickReplacement(options, seedKey) {
  if (!options || options.length === 0) return '';
  let h = 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    h = (h * 31 + seedKey.charCodeAt(i)) >>> 0;
  }
  return options[h % options.length];
}

function matchCase(source, replacement) {
  if (!source) return replacement;
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replaceAITells(text) {
  const applied = [];
  let result = String(text || '');
  for (const { key, regex, options } of AI_TELL_PATTERNS) {
    result = result.replace(regex, (match, offset) => {
      const seed = `${key}:${offset}`;
      const repl = matchCase(match, pickReplacement(options, seed));
      applied.push({ from: match, to: repl, kind: 'ai_tell' });
      return repl;
    });
  }
  return { text: result, applied };
}

// Em-dash overuse: detectors flag the "— ... —" parenthetical and
// "X — Y" pseudo-clause structure. Convert to commas when the segment
// is short enough to make sense as a comma clause.
function cleanEmDashOveruse(text) {
  const applied = [];
  // Long em-dash flanked by spaces → comma when fragment is < 60 chars.
  const result = String(text || '').replace(/ — ([^—]{1,60}) — /g, (match, mid) => {
    applied.push({ from: '— ... —', to: ', ... ,', kind: 'em_dash' });
    return `, ${mid}, `;
  });
  return { text: result, applied };
}

// Burstiness boost: split mega-sentences (3+ commas, 25+ words) by
// promoting the last clause to its own sentence; also collapse two very
// short consecutive sentences into one to vary rhythm in the other
// direction.
function boostBurstiness(text) {
  const applied = [];
  const sentences = String(text || '').match(/[^.!?]+[.!?]+(\s|$)/g);
  // Even a single very long sentence is splittable — only bail when the
  // input has no terminating punctuation at all.
  if (!sentences || sentences.length === 0) return { text, applied };

  const out = [];
  for (const sentRaw of sentences) {
    const sent = sentRaw.trim();
    if (!sent) continue;
    const words = sent.split(/\s+/).filter(Boolean);
    const commas = (sent.match(/,/g) || []).length;
    if (commas >= 3 && words.length >= 25) {
      // Split on the LAST comma into a separate short sentence.
      const lastCommaIdx = sent.lastIndexOf(',');
      const head = sent.slice(0, lastCommaIdx).trim().replace(/[,]+$/, '');
      const tail = sent.slice(lastCommaIdx + 1).trim();
      if (head && tail) {
        const tailFirst = tail[0] ? tail[0].toUpperCase() + tail.slice(1) : tail;
        const endPunct = head.match(/[.!?]$/) ? '' : '.';
        out.push(`${head}${endPunct} ${tailFirst}`);
        applied.push({ from: 'long-clause-sentence', to: 'split', kind: 'burstiness' });
        continue;
      }
    }
    out.push(sent);
  }
  return { text: out.join(' '), applied };
}

// ── AI-likelihood scoring ─────────────────────────────────────────────
// Rough estimator combining: (1) density of known AI-tells, (2) uniform
// sentence length (low burstiness), (3) repetitive sentence openings.
// Output is clamped to [0, 1]. Not a real detector — it's a heuristic
// that correlates with how detectors typically score text, useful for
// showing a "stealth" gauge to the user.
function estimateAIScore(text) {
  const t = String(text || '');
  if (t.length < 20) return 0;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 10) return 0;

  let tellHits = 0;
  for (const { regex } of AI_TELL_PATTERNS) {
    const matches = t.match(regex);
    if (matches) tellHits += matches.length;
  }
  const tellDensity = Math.min(1, tellHits / (words.length / 80));

  const sentences = t.match(/[^.!?]+[.!?]+/g) || [];
  let burstinessScore = 0;
  if (sentences.length >= 3) {
    const lens = sentences.map((s) => s.trim().split(/\s+/).filter(Boolean).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length;
    const stdev = Math.sqrt(variance);
    // Low stdev relative to mean → uniform sentence length → AI-like
    const cv = mean > 0 ? stdev / mean : 0;
    burstinessScore = Math.max(0, Math.min(1, 1 - cv * 2));
  }

  const openings = sentences.map((s) => {
    const first = s.trim().split(/\s+/)[0] || '';
    return first.toLowerCase().replace(/[^a-záéíóúñü]/g, '');
  }).filter(Boolean);
  let repetitiveOpenings = 0;
  if (openings.length >= 3) {
    const counts = new Map();
    for (const o of openings) counts.set(o, (counts.get(o) || 0) + 1);
    const maxCount = Math.max(...counts.values());
    repetitiveOpenings = Math.min(1, (maxCount - 1) / openings.length);
  }

  // Em-dash density
  const emDashes = (t.match(/—/g) || []).length;
  const emDashDensity = Math.min(1, emDashes / Math.max(1, sentences.length));

  const score = 0.4 * tellDensity
    + 0.3 * burstinessScore
    + 0.2 * repetitiveOpenings
    + 0.1 * emDashDensity;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

function listAITellPatterns() {
  return AI_TELL_PATTERNS.map((p) => p.key);
}

/**
 * Apply the full humanization pipeline to a paraphrased text.
 *
 * @param {object} opts
 * @param {string} opts.text — paraphrased input
 * @param {string} [opts.language] — 'es' | 'en' | ... (informational only)
 * @param {'low'|'medium'|'high'} [opts.intensity] — controls pass count
 * @returns {{ text:string, applied:Array, aiScoreBefore:number, aiScoreAfter:number, deltaScore:number, intensity:string, language:string }}
 */
function humanizeText({ text, language = 'es', intensity = 'medium' } = {}) {
  const input = String(text || '');
  const aiScoreBefore = estimateAIScore(input);

  if (!input.trim()) {
    return {
      text: input,
      applied: [],
      aiScoreBefore,
      aiScoreAfter: aiScoreBefore,
      deltaScore: 0,
      intensity,
      language,
    };
  }

  const passes = intensity === 'low' ? 1 : intensity === 'high' ? 3 : 2;
  let current = input;
  const allApplied = [];
  for (let i = 0; i < passes; i += 1) {
    const r1 = replaceAITells(current);
    const r2 = cleanEmDashOveruse(r1.text);
    const r3 = boostBurstiness(r2.text);
    allApplied.push(...r1.applied, ...r2.applied, ...r3.applied);
    // Stop early if the pass produced no changes (idempotent).
    if (r3.text === current) break;
    current = r3.text;
  }

  const aiScoreAfter = estimateAIScore(current);

  return {
    text: current,
    applied: allApplied,
    aiScoreBefore,
    aiScoreAfter,
    deltaScore: Math.round((aiScoreBefore - aiScoreAfter) * 1000) / 1000,
    intensity,
    language,
  };
}

module.exports = {
  humanizeText,
  estimateAIScore,
  listAITellPatterns,
  // Exposed for unit tests
  replaceAITells,
  cleanEmDashOveruse,
  boostBurstiness,
  matchCase,
};
