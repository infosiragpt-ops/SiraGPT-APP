'use strict';

/**
 * answer-validator — sixth validator family in Sira's deterministic
 * validation pipeline (peer of artifact / source / code / document /
 * safety validators in `validator-engine.js`).
 *
 * Why this exists:
 *  The existing validator engine grades artifacts, sources and code,
 *  but the actual TEXTUAL answer the model is about to ship is never
 *  graded before delivery. This module fills that gap: given the user's
 *  envelope and the candidate answer text, it scores intent coverage,
 *  output-format adherence, language mirroring, citation-placement
 *  discipline, self-contradiction freedom and length appropriateness.
 *
 * Design constraints (mirrors validator-engine.js exactly):
 *  - Pure functions, deterministic, zero dependencies.
 *  - Return shape: { validator: 'answer_validator', checks: [...], score }
 *  - Each check: { name, status: 'passed'|'failed'|'warning', detail? }
 *  - No LLM calls, no network. Adds < 5 ms to the chat path.
 *
 * Vocabulary (these names become check.name in the returned report):
 *   intent_addressed          — the answer references the user's
 *                               primary intent (label / keywords)
 *   format_compliance         — markdown structure / sections / language
 *                               of the answer match the output contract
 *   language_mirror           — answer language matches user-message
 *                               language hint when one was provided
 *   citations_when_required   — when context_requirements.citation_required
 *                               is true, the answer contains at least one
 *                               citation-shaped token (URL, DOI, [n],
 *                               §section)
 *   no_self_contradiction     — the answer does not contain pairwise
 *                               opposing assertions about the same entity
 *   no_template_residue       — the answer does not leak placeholder
 *                               artefacts ("[insert here]", "TODO:",
 *                               "Lorem ipsum", curly-brace template tags)
 *   length_appropriate        — answer length sits inside [min, max]
 *                               soft bounds derived from output contract
 *   no_refusal_when_safe      — answer does not contain an "I cannot
 *                               help" template when the envelope's risk
 *                               level is "low" (false refusals are bugs)
 *   no_injection_echo         — answer does not echo prompt-injection
 *                               markers from the user message back as
 *                               instructions
 *
 * Public API:
 *   validateAnswer({ envelope, answer, evidence?, langHint? }) → report
 *   ANSWER_CHECKS                                              → string[]
 *
 * The shape is identical to other validator families so that
 * `composeValidationFrame` accepts the report unchanged.
 */

const ANSWER_CHECKS = Object.freeze([
  'intent_addressed',
  'format_compliance',
  'language_mirror',
  'citations_when_required',
  'no_self_contradiction',
  'no_template_residue',
  'length_appropriate',
  'no_refusal_when_safe',
  'no_injection_echo',
]);

// ─── Helpers (private) ──────────────────────────────────────────────

function check(name, status, detail = null) {
  return detail == null ? { name, status } : { name, status, detail };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function safeText(value) {
  if (typeof value !== 'string') return '';
  return value;
}

function asLower(value) {
  return safeText(value).toLowerCase();
}

const CITATION_TOKEN = /\[(?:\d+|source\s+\d+|fuente\s+\d+|s?:\s*\d+)\]|\bhttps?:\/\/\S+|\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+|§\s?\d|\bsource:\s*\S+|\(\w[^()]{0,40}(?:19|20)\d{2}\)/i;

const REFUSAL_PATTERNS = [
  /\bi\s+(?:cannot|can[' ]?t)\s+help\s+with\s+that\b/i,
  /\bi[' ]?m\s+(?:not\s+)?able\s+to\s+(?:assist|help)\b/i,
  /\bi\s+do\s+not\s+have\s+the\s+ability\b/i,
  /\bno\s+puedo\s+ayudarte?\s+con\s+(?:eso|esto|esta\s+solicitud)\b/i,
  /\blo\s+siento,?\s+(?:pero\s+)?no\s+puedo\s+(?:ayudar|hacer|cumplir)\b/i,
];

const TEMPLATE_RESIDUE = [
  /\[(?:insert|añadir|completar|fill in)\s+[^\]]+\]/i,
  /\{\{[^}]+\}\}/,
  /\b(?:TODO|FIXME|XXX|HACK)\b\s*[:.-]/,
  /\bLorem\s+ipsum\b/i,
  /placeholder\s+(?:text|content|aquí|here)/i,
];

const INJECTION_ECHO = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a\s+different\s+(?:assistant|model)/i,
  /system\s+prompt:\s*you\s+are/i,
  /reveal\s+your\s+system\s+prompt/i,
];

// Crude polar opposites for self-contradiction detection. We pair
// (negated-form ↔ affirmative-form) keyed by an entity label that has to
// appear in BOTH sentences for the contradiction to count.
const POLAR_PAIRS = [
  [/\bdoes\s+not\b/i, /\bdoes\b(?!\s+not)/i],
  [/\bis\s+not\b/i, /\bis\b(?!\s+not)/i],
  [/\bare\s+not\b/i, /\bare\b(?!\s+not)/i],
  [/\bcannot\b|\bcan[' ]?t\b/i, /\bcan\b(?!\s+not|\s*['']?t)/i],
  [/\bno\s+es\b/i, /\bes\b(?!\s+no)/i],
  [/\bno\s+son\b/i, /\bson\b(?!\s+no)/i],
  [/\bnunca\b/i, /\bsiempre\b/i],
  [/\bnever\b/i, /\balways\b/i],
  [/\bfalse\b/i, /\btrue\b/i],
];

function splitSentences(text) {
  return safeText(text)
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function detectLanguage(text) {
  const sample = safeText(text).slice(0, 1500);
  if (!sample) return null;
  // Script-based detection first (non-Latin scripts are unambiguous).
  if (/[぀-ヿ]/.test(sample)) return 'ja';
  if (/[가-힯]/.test(sample)) return 'ko';
  if (/[一-鿿]/.test(sample)) return 'zh';
  if (/[Ѐ-ӿ]/.test(sample)) return 'ru';
  if (/[؀-ۿ]/.test(sample)) return 'ar';
  if (/[֐-׿]/.test(sample)) return 'he';
  if (/[ऀ-ॿ]/.test(sample)) return 'hi';
  // Latin-script stopword scoring (subset of long-paste detector).
  const counts = {
    es: (sample.match(/\b(?:el|la|los|las|de|que|y|en|un|una|por|con|para|es|son|del|al|este|esta|como|pero|también|más|sin|sobre|hasta)\b/gi) || []).length,
    en: (sample.match(/\b(?:the|of|and|to|in|a|is|that|for|on|with|as|at|by|from|this|but|not|are|or|be|have|has|was|were|will|would|can|should)\b/gi) || []).length,
    pt: (sample.match(/\b(?:o|a|os|as|de|que|e|em|um|uma|por|com|para|é|são|do|da|dos|das|este|esta|como|mas|porque|quando|onde|também|mais|sem|sobre)\b/gi) || []).length,
    fr: (sample.match(/\b(?:le|la|les|de|et|à|un|une|que|en|dans|pour|sur|avec|est|sont|du|des|au|aux|ce|cette|ces|comme|mais)\b/gi) || []).length,
    de: (sample.match(/\b(?:der|die|das|den|dem|des|und|in|zu|auf|von|für|mit|ist|sind|nicht|ein|eine|dass|wenn|aber)\b/gi) || []).length,
    it: (sample.match(/\b(?:il|la|i|gli|le|di|che|e|in|un|una|per|con|sono|è|del|della|dei|delle|al|alla|come|ma)\b/gi) || []).length,
  };
  let best = null;
  let max = 0;
  for (const [lang, n] of Object.entries(counts)) {
    if (n > max) { best = lang; max = n; }
  }
  return max >= 3 ? best : null;
}

function tokenize(text) {
  return asLower(text).match(/[\p{L}\p{N}]+/gu) || [];
}

function jaccardOverlap(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// ─── Individual check implementations ───────────────────────────────

function checkIntentAddressed({ envelope, answer }) {
  const intentLabel = envelope?.intent_analysis?.primary_intent?.label
    || envelope?.intent_analysis?.primary_intent?.id
    || envelope?.intent_analysis?.primary_intent
    || envelope?.normalized_request?.summary
    || '';
  const rawRequest = envelope?.raw_input?.user_message
    || envelope?.normalized_request?.summary
    || '';
  const intentTokens = tokenize(rawRequest || intentLabel);
  const answerTokens = tokenize(answer);
  if (intentTokens.length === 0) {
    return check('intent_addressed', 'warning', 'no intent reference available in envelope');
  }
  // Drop common stopwords on both sides before scoring; otherwise short
  // requests like "explica el plan" hit a high overlap on "el".
  const STOP = new Set(['the','of','and','to','in','a','is','that','for','on','with','el','la','los','las','de','que','y','en','un','una','por','con','para','es','son']);
  const denseRequest = intentTokens.filter(t => t.length > 2 && !STOP.has(t));
  const denseAnswer = answerTokens.filter(t => t.length > 2 && !STOP.has(t));
  if (denseRequest.length === 0) {
    return check('intent_addressed', 'warning', 'request had no meaningful terms after stopword filter');
  }
  const overlap = jaccardOverlap(denseRequest, denseAnswer);
  if (overlap >= 0.08) return check('intent_addressed', 'passed', `jaccard=${overlap.toFixed(3)}`);
  if (overlap >= 0.03) return check('intent_addressed', 'warning', `weak overlap jaccard=${overlap.toFixed(3)}`);
  return check('intent_addressed', 'failed', `answer does not reference the user request (jaccard=${overlap.toFixed(3)})`);
}

function checkFormatCompliance({ envelope, answer }) {
  const oc = envelope?.output_contract || {};
  const requirements = [];
  if (oc.primary_output?.format) requirements.push(oc.primary_output.format);
  if (oc.markdown_structure) requirements.push(`markdown:${oc.markdown_structure}`);
  if (oc.delivery_mode) requirements.push(`delivery:${oc.delivery_mode}`);
  const fails = [];
  // If user explicitly asked for markdown headings, expect at least one heading
  if (oc.markdown_structure === 'hierarchical' || /headings?|sections?|outline/i.test(oc.delivery_mode || '')) {
    if (!/^#{1,6}\s+\S/m.test(answer) && !/^\*\*[^*]+\*\*\s*$/m.test(answer)) {
      fails.push('expected at least one markdown heading');
    }
  }
  // If user wanted a table, expect at least one pipe-formatted table
  if (/table|tabla/i.test(oc.delivery_mode || '') || oc.must_include_tables) {
    if (!/\|\s*[^|]+\s*\|\s*[^|]+\s*\|/.test(answer)) {
      fails.push('expected a markdown table');
    }
  }
  // If user wanted code, expect a fenced code block
  if (/code|c[oó]digo/i.test(oc.delivery_mode || '') || oc.must_include_code) {
    if (!/```[\s\S]*?```/.test(answer)) {
      fails.push('expected a fenced code block');
    }
  }
  if (fails.length === 0) {
    return check('format_compliance', 'passed', requirements.length > 0 ? `requirements: ${requirements.join(', ')}` : null);
  }
  return check('format_compliance', 'failed', fails.join('; '));
}

function checkLanguageMirror({ envelope, answer, langHint }) {
  const expected = langHint
    || envelope?.normalized_request?.language
    || envelope?.raw_input?.language_hint
    || null;
  if (!expected) return check('language_mirror', 'warning', 'no language hint available');
  const detected = detectLanguage(answer);
  if (!detected) return check('language_mirror', 'warning', 'could not detect answer language');
  if (detected === expected) return check('language_mirror', 'passed', `expected=${expected} detected=${detected}`);
  // Spanish/Portuguese can falsely cross-detect on short answers
  if ((expected === 'es' && detected === 'pt') || (expected === 'pt' && detected === 'es')) {
    return check('language_mirror', 'warning', `near-miss expected=${expected} detected=${detected}`);
  }
  return check('language_mirror', 'failed', `expected=${expected} detected=${detected}`);
}

function checkCitationsWhenRequired({ envelope, answer }) {
  const required = Boolean(
    envelope?.context_requirements?.citation_required
    || envelope?.context_requirements?.source_validation_required,
  );
  if (!required) return check('citations_when_required', 'passed', 'not required');
  if (CITATION_TOKEN.test(answer)) return check('citations_when_required', 'passed', 'citation token present');
  return check('citations_when_required', 'failed', 'citations required but no [n] / URL / DOI / §section found');
}

function checkNoSelfContradiction({ answer }) {
  const sentences = splitSentences(answer);
  if (sentences.length < 2) return check('no_self_contradiction', 'passed', 'too short to contradict');
  // Build a quick subject index: capitalised noun phrases of length 2+
  // characters that appear in multiple sentences. Then look at the
  // truth-polarity of each occurrence.
  const subjectMap = new Map();
  for (let i = 0; i < sentences.length; i++) {
    const matches = sentences[i].match(/\b([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ-]{2,}){0,3})\b/g) || [];
    for (const m of matches) {
      const key = m.toLowerCase();
      if (!subjectMap.has(key)) subjectMap.set(key, []);
      subjectMap.get(key).push(i);
    }
  }
  for (const [subject, idxs] of subjectMap.entries()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length - 1; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const sa = sentences[idxs[i]];
        const sb = sentences[idxs[j]];
        for (const [negRe, affRe] of POLAR_PAIRS) {
          if (negRe.test(sa) && affRe.test(sb) && !negRe.test(sb)) {
            return check('no_self_contradiction', 'warning', `possible contradiction about "${subject}" between sentences ${idxs[i] + 1} and ${idxs[j] + 1}`);
          }
          if (negRe.test(sb) && affRe.test(sa) && !negRe.test(sa)) {
            return check('no_self_contradiction', 'warning', `possible contradiction about "${subject}" between sentences ${idxs[i] + 1} and ${idxs[j] + 1}`);
          }
        }
      }
    }
  }
  return check('no_self_contradiction', 'passed');
}

function checkNoTemplateResidue({ answer }) {
  for (const pattern of TEMPLATE_RESIDUE) {
    const m = answer.match(pattern);
    if (m) return check('no_template_residue', 'failed', `found residue: "${m[0].slice(0, 80)}"`);
  }
  return check('no_template_residue', 'passed');
}

function checkLengthAppropriate({ envelope, answer }) {
  const oc = envelope?.output_contract || {};
  const min = Number(oc.min_chars) || 0;
  const max = Number(oc.max_chars) || 0;
  const length = answer.length;
  if (min && length < min) return check('length_appropriate', 'failed', `answer ${length} chars < min ${min}`);
  if (max && length > max) return check('length_appropriate', 'failed', `answer ${length} chars > max ${max}`);
  // Soft heuristic: if no explicit bounds, flag impossibly short answers
  // for non-greeting intents.
  const intentId = String(envelope?.intent_analysis?.primary_intent?.id || envelope?.intent_analysis?.primary_intent?.label || '').toLowerCase();
  const isGreeting = /greet|saludo|small.?talk|salutaci/i.test(intentId);
  if (!isGreeting && length < 12) return check('length_appropriate', 'failed', `suspiciously short answer (${length} chars) for non-greeting intent`);
  if (!isGreeting && length < 40) return check('length_appropriate', 'warning', `terse answer (${length} chars)`);
  return check('length_appropriate', 'passed', `${length} chars`);
}

function checkNoRefusalWhenSafe({ envelope, answer }) {
  const risk = String(envelope?.safety_and_permissions?.overall_risk_level || '').toLowerCase();
  if (risk && risk !== 'low' && risk !== 'none') return check('no_refusal_when_safe', 'passed', `risk=${risk}, refusal may be valid`);
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(answer)) {
      return check('no_refusal_when_safe', 'warning', 'refusal template detected for low-risk request');
    }
  }
  return check('no_refusal_when_safe', 'passed');
}

function checkNoInjectionEcho({ answer }) {
  for (const pattern of INJECTION_ECHO) {
    if (pattern.test(answer)) {
      return check('no_injection_echo', 'failed', 'answer contains prompt-injection-style instruction');
    }
  }
  return check('no_injection_echo', 'passed');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run the full answer-validator family.
 *
 * @param {object} args
 * @param {object} args.envelope    Task envelope ({@link task-envelope-schema}).
 * @param {string} args.answer      Candidate answer text.
 * @param {Array}  [args.evidence]  Retrieved passages for downstream checks
 *                                  (currently unused here, surfaced for the
 *                                  hallucination scanner via _internal).
 * @param {string} [args.langHint]  Override language hint when the envelope
 *                                  doesn't carry one (mostly for tests).
 * @returns {{ validator: 'answer_validator', checks: Array, score: number }}
 */
function validateAnswer({ envelope = null, answer = '', evidence = null, langHint = null } = {}) {
  const safeAnswer = safeText(answer);
  void evidence; // reserved for joint use with hallucination-scanner
  const checks = [
    checkIntentAddressed({ envelope, answer: safeAnswer }),
    checkFormatCompliance({ envelope, answer: safeAnswer }),
    checkLanguageMirror({ envelope, answer: safeAnswer, langHint }),
    checkCitationsWhenRequired({ envelope, answer: safeAnswer }),
    checkNoSelfContradiction({ answer: safeAnswer }),
    checkNoTemplateResidue({ answer: safeAnswer }),
    checkLengthAppropriate({ envelope, answer: safeAnswer }),
    checkNoRefusalWhenSafe({ envelope, answer: safeAnswer }),
    checkNoInjectionEcho({ answer: safeAnswer }),
  ];
  const passed = checks.filter(c => c.status === 'passed').length;
  const score = checks.length === 0 ? 0 : passed / checks.length;
  return { validator: 'answer_validator', checks, score: round3(score) };
}

module.exports = {
  validateAnswer,
  ANSWER_CHECKS,
  _internal: {
    detectLanguage,
    splitSentences,
    jaccardOverlap,
    tokenize,
    checkIntentAddressed,
    checkFormatCompliance,
    checkLanguageMirror,
    checkCitationsWhenRequired,
    checkNoSelfContradiction,
    checkNoTemplateResidue,
    checkLengthAppropriate,
    checkNoRefusalWhenSafe,
    checkNoInjectionEcho,
  },
};
