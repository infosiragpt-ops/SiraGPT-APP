/**
 * instruction-echo-guard.js — catches answers that echo the document's own
 * internal instructions instead of its content.
 *
 * Real bug this module exists for: a user asks «dame un resumen en un solo
 * párrafo» over an uploaded document that itself contains prompt templates
 * (e.g. a thesis-writing guide with "similitud ≤29%", rubrics, "matriz de
 * sistematización", front-matter checklists). The model summarized THOSE
 * instructions instead of the document's actual subject.
 *
 * Two layers:
 *   1. buildAntiEchoLines(query, { lang }) — directive lines injected into the
 *      prompt so the model never treats embedded meta-text as content.
 *   2. detectInstructionEcho({ response, sourceText }) — post-generation
 *      validator that scores the completion against the raw source text and
 *      flags it when it is dominated by verbatim instruction/rubric material.
 *
 * All functions are pure and dependency-free (CommonJS).
 */

'use strict';

// ─── Layer 1: prompt directives ─────────────────────────────────────────────

function buildAntiEchoLines(_query, { lang = 'en' } = {}) {
  const en = String(lang || 'en').slice(0, 2).toLowerCase() === 'es' ? false : true;
  if (en) {
    return [
      '- ANTI-ECHO RULE: many uploaded documents (thesis guides, course packs, templates) contain their own internal instructions — similarity thresholds ("similitud maxima 29%"), rubrics, systematization matrices, editing checklists, or prompts addressed to a human writer. Those lines are DESCRIPTIONS of the document genre, not the subject matter.',
      '- When asked to summarize/analyze, synthesize WHAT THE DOCUMENT IS ABOUT (its topic, argument, findings), not what the document tells its reader to do — unless the user explicitly asked about those guidelines.',
      '- Never output as your answer: instruction lists meant for the author ("elabora", "redacte", "presente"), evaluation criteria, formatting rules, or template placeholders.',
    ];
  }
  return [
    '- REGLA ANTI-ECO: muchos documentos subidos (guias de tesis, materiales de curso, plantillas) contienen sus propias instrucciones internas — umbrales de similitud ("similitud maxima 29%"), rúbricas, matrices de sistematización, listas de cotejo o consignas dirigidas al autor humano. Esas líneas describen el género del documento; no son su contenido temático.',
    '- Al pedir resumen o análisis, sintetiza DE QUE TRATA el documento (tema, argumento, hallazgos), no lo que el documento le indica hacer a su lector/autor, salvo que el usuario pregunte explícitamente por esas pautas.',
    '- Nunca entregues como respuesta: listas de instrucciones al autor ("elabora", "redacte", "presente"), criterios de evaluación, reglas de formato o marcadores de posición de plantilla.',
  ];
}

// ─── Layer 2: post-generation detection ─────────────────────────────────────

// Imperative verbs that appear in documents' own instructions to their author
// or reader. A summary made OF such lines is an echo; a summary quoting one
// line is not.
const INSTRUCTION_VERB_RE = /\b(elabora(?:r|rme|mos)?|redacta(?:r|e|me)?|desarrolla(?:r|e)?|present[ae]r?|sustenta(?:r)?|explica(?:r|que)?|menciona(?:r)?|describe(?:r)?|analiza(?:r)?|comenta(?:r)?|deduce(?:r)?|propone(?:r)?|identifica(?:r)?|determina(?:r)?|establece(?:r)?|considerando|tomando\s+en\s+cuenta|de\s+acuerdo\s+a|seg[uú]n\s+el\s+siguiente|a\s+partir\s+del?\s+siguiente)\b/i;

// Rubric / template vocabulary: thresholds, scoring, structure matrices,
// citation-style mandates, placeholder markers.
const RUBRIC_TOKEN_RE = /\b(similitud|m[aá]xima(?:mente)?\s+permitid[ao]|plagio|turnitin|r[uú]brica|criterio[s]?\s+de\s+evaluaci[oó]n|matriz\s+de\s+sistematizaci[oó]n|lista\s+de\s+cotejo|checklist|rango\s+de\s+p[aá]ginas|n[uú]mero\s+de\s+p[aá]ginas\s+(?:m[ií]nimo|m[aá]ximo)|extensi[oó]n\s+(?:m[ií]nima|m[aá]xima)|normas?\s+(?:APA|IEEE|Vancouver|MLA)|referencias?\s+en\s+formato|interlineado|margenes|portada\s+debe|car[aá]tula\s+debe|%|por\s+ciento)\b/i;

const PLACEHOLDER_RE = /\[[^\]\n]{2,60}\]|\{[^\}\n]{2,60}\}|<[A-Za-z][A-Za-z0-9 _]{1,40}>|\b(?:XX+|N°?\s*|___+)\b/;

function normalizeForCompare(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 25);
}

function wordSet(normalized) {
  const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'y', 'en', 'un', 'una', 'que', 'se', 'por', 'con', 'para', 'al', 'lo', 'su', 'sus', 'como', 'mas', 'o', 'es', 'son', 'the', 'of', 'to', 'and', 'in', 'a', 'is', 'are']);
  return new Set(String(normalized || '').split(' ').filter(w => w.length > 3 && !STOP.has(w)));
}

/**
 * Jaccard similarity between two already-normalized texts' word sets,
 * computed over sliding windows of `windowWords` words from `a`.
 */
function bestWindowJaccard(responseNorm, sourceNorm, windowWords = 18) {
  const srcWords = sourceNorm.split(' ').filter(Boolean);
  if (!srcWords.length) return 0;
  const srcSet = new Set(srcWords);
  const respWords = responseNorm.split(' ').filter(Boolean);
  if (respWords.length < 8) return 0;

  // Shrink the window to the response so short answers still get scored.
  const win = Math.min(windowWords, respWords.length);
  let best = 0;
  const step = Math.max(4, Math.floor(win / 3));
  for (let i = 0; i + win <= respWords.length; i += step) {
    const cur = new Set(respWords.slice(i, i + win));
    let inter = 0;
    for (const w of cur) if (srcSet.has(w)) inter += 1;
    // Jaccard against the WHOLE source under-measures long docs; use overlap
    // coefficient (intersection / min-set-size) which saturates at 1 when the
    // window is fully contained in the source.
    const score = inter / Math.min(cur.size, srcSet.size || 1);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Detect whether `response` echoes instruction/rubric material found in
 * `sourceText` (the raw extracted document text attached this turn).
 *
 * @param {{ response: string, sourceText?: string }} opts
 * @returns {{
 *   echo: boolean,
 *   reason: string|null,
 *   score: number,          // 0..1 containment of echoed windows in source
 *   matchedSignals: string[]
 * }}
 */
function detectInstructionEcho({ response, sourceText }) {
  const text = String(response || '').trim();
  const source = String(sourceText || '');
  if (!text || !source) return { echo: false, reason: null, score: 0, matchedSignals: [] };

  const signals = [];
  const sentences = splitSentences(text);

  // Signal A: imperative-instruction sentences copied near-verbatim from the
  // source. Require BOTH the verb pattern AND containment in the source so a
  // legitimate sentence like "El autor recomienda elaborar un plan" (not in
  // the source) does not trip the guard.
  let instructionSentences = 0;
  let containedInstructionChars = 0;
  for (const s of sentences) {
    if (!INSTRUCTION_VERB_RE.test(s)) continue;
    const sNorm = normalizeForCompare(s);
    const srcNormWindow = normalizeForCompare(source).slice(0, 400000);
    const contained = sNorm.length >= 25 && srcNormWindow.includes(sNorm.slice(0, Math.min(120, sNorm.length)));
    if (contained) {
      instructionSentences += 1;
      containedInstructionChars += s.length;
    }
  }
  if (instructionSentences > 0) signals.push(`instruction-sentences:${instructionSentences}`);

  // Signal B: rubric/template tokens dominating the answer.
  const rubricHits = (text.match(new RegExp(RUBRIC_TOKEN_RE.source, 'gi')) || []).length;
  if (rubricHits >= 3) signals.push(`rubric-tokens:${rubricHits}`);

  // Signal C: unfilled template placeholders leaked into the answer.
  if (PLACEHOLDER_RE.test(text)) signals.push('template-placeholders');

  // Containment score: how much of the response's longest windows appear
  // verbatim-ish inside the source.
  const score = bestWindowJaccard(
    normalizeForCompare(text),
    normalizeForCompare(source),
  );

  const totalLen = text.length;
  const instructionRatio = totalLen ? containedInstructionChars / totalLen : 0;

  const echo =
    (instructionSentences >= 2)
    || (instructionSentences >= 1 && instructionRatio >= 0.35)
    || (rubricHits >= 5)
    || (rubricHits >= 3 && PLACEHOLDER_RE.test(text))
    || (score >= 0.92 && rubricHits >= 2);

  const reason = echo
    ? `instruction_echo:${signals.join(',')},containment=${score.toFixed(2)}`
    : null;

  return { echo, reason, score, matchedSignals: signals };
}

/** Anti-echo corrective preamble appended when an echo is detected. */
function buildEchoCorrectivePreamble(language = 'es') {
  const es = [
    'Tu respuesta anterior copió las instrucciones internas del documento (consignas, rúbricas, umbrales de similitud o plantillas) en lugar de resumir su contenido.',
    'Reescribe la respuesta desde cero: resume de qué trata realmente el documento —tema central, argumento, datos y conclusiones— y omite por completo las instrucciones dirigidas al autor, criterios de evaluación y reglas de formato.',
  ].join('\n');
  const en = [
    'Your previous answer copied the document\'s internal instructions (prompts, rubrics, similarity thresholds, templates) instead of summarizing its content.',
    'Rewrite from scratch: summarize what the document is actually about —central topic, argument, data, conclusions— and omit all author-directed instructions, evaluation criteria, and formatting rules.',
  ].join('\n');
  return String(language || 'es').slice(0, 2).toLowerCase() === 'en' ? en : es;
}

module.exports = {
  buildAntiEchoLines,
  detectInstructionEcho,
  buildEchoCorrectivePreamble,
  normalizeForCompare,
  bestWindowJaccard,
  INSTRUCTION_VERB_RE,
  RUBRIC_TOKEN_RE,
};
