'use strict';

/**
 * evidence-extractor — pull the load-bearing sentences (findings, results,
 * conclusions) out of a paper's abstract and tag the apparent study type and
 * finding direction. This is what lets the synthesiser cite *real* evidence
 * (with a source ref) instead of hand-waving over a bare list of titles.
 *
 * Deterministic + bilingual (ES/EN). No LLM, no network.
 */

const { STUDY_TYPES } = require('./research-query-intelligence');

// Sentence-level signal words that mark a "finding/result/conclusion" claim.
const RESULT_SIGNALS = /\b(result|results|finding|findings|conclude|concluded|conclusion|conclusions|we (found|show|demonstrate|observe)|showed|shown|demonstrat|reveal|indicat|suggest|evidence|significant|significantly|associated with|correlat|effect|impact|increase|decrease|reduc|improv|higher|lower|outperform|p\s*[<=]\s*0?\.\d+|\b\d{1,3}(\.\d+)?\s?%)\b/i;
const RESULT_SIGNALS_ES = /\b(resultado|resultados|hallazgo|hallazgos|conclu(ye|imos|si[oó]n)|demostr|mostr|reve(la|ló)|indica|sugiere|evidencia|significativ[oa]|asociad[oa] (a|con)|correlaci[oó]n|efecto|impacto|aument|disminu|reduc|mejor|mayor|menor|super[oó]|p\s*[<=]\s*0?\.\d+|\b\d{1,3}(\.\d+)?\s?%)\b/i;

// Direction stems (no trailing \b so inflections match: increase→increased,
// improv→improved, grow→growth, reduc→reduced, decreas→decreased).
const POSITIVE_DIR = /\b(increas|higher|improv|enhanc|positive|benefit|effective|gain|grow|rais|aument|mejor|mayor|positiv|beneficio|eficaz|efectiv|incrementa)/i;
const NEGATIVE_DIR = /\b(decreas|lower|declin|negative|harm|adverse|reduc|loss|worse|disminu|menor|negativ|perjud|advers|p[eé]rdida|empeora)/i;

const FUTURE_WORK = /\b(future (work|research)|further (research|study|studies) (is|are)? ?(needed|required|warranted)|more research is needed|remains? unclear|limitation|se requier(e|en) (m[aá]s|futur)|investigaci[oó]n futura|trabajo futuro|se necesita m[aá]s|queda por|no est[aá] claro|limitaci[oó]n)\b/i;

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function detectStudyType(text) {
  const t = String(text || '');
  for (const s of STUDY_TYPES) {
    if (s.re.test(t)) return s.type;
  }
  return null;
}

function findingDirection(sentence) {
  const pos = POSITIVE_DIR.test(sentence);
  const neg = NEGATIVE_DIR.test(sentence);
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  if (pos && neg) return 'mixed';
  return 'neutral';
}

function scoreSentence(sentence, terms) {
  let score = 0;
  if (RESULT_SIGNALS.test(sentence) || RESULT_SIGNALS_ES.test(sentence)) score += 3;
  if (/\b\d{1,3}(\.\d+)?\s?%|\bp\s*[<=]/i.test(sentence)) score += 2; // hard numbers / stats
  const low = sentence.toLowerCase();
  for (const t of terms || []) {
    if (t && t.length > 2 && low.includes(t)) score += 1;
  }
  // Mild position bonus: results usually live in the back half of an abstract.
  return score;
}

/**
 * extractEvidence — structured evidence for one paper.
 *
 * @param {object} paper — canonical Paper (uses .abstract, .title)
 * @param {string[]} [terms] — query content terms for relevance weighting
 * @param {object} [opts] { maxFindings=3 }
 * @returns {{
 *   findings: Array<{ sentence, score, direction }>,
 *   topFinding: string|null,
 *   studyType: string|null,
 *   hasStats: boolean,
 *   futureWork: string|null,
 * }}
 */
function extractEvidence(paper, terms = [], opts = {}) {
  const maxFindings = Number.isFinite(opts.maxFindings) && opts.maxFindings > 0 ? opts.maxFindings : 3;
  const abstract = paper && paper.abstract ? String(paper.abstract) : '';
  const sentences = splitSentences(abstract);
  const studyType = detectStudyType(`${paper && paper.title ? paper.title : ''} ${abstract}`);

  const scored = sentences
    .map((sentence, i) => ({
      sentence,
      score: scoreSentence(sentence, terms) + (i >= sentences.length / 2 ? 0.5 : 0),
      direction: findingDirection(sentence),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const findings = scored.slice(0, maxFindings);
  let futureWork = null;
  for (const s of sentences) {
    if (FUTURE_WORK.test(s)) { futureWork = s; break; }
  }

  return {
    findings,
    topFinding: findings.length ? findings[0].sentence : null,
    studyType,
    hasStats: /\b\d{1,3}(\.\d+)?\s?%|\bp\s*[<=]\s*0?\.\d+/i.test(abstract),
    futureWork,
  };
}

module.exports = {
  extractEvidence,
  splitSentences,
  detectStudyType,
  findingDirection,
  scoreSentence,
  _internal: { RESULT_SIGNALS, RESULT_SIGNALS_ES, FUTURE_WORK },
};
