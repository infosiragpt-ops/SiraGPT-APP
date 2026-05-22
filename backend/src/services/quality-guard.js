/**
 * quality-guard.js — catches weak completions and triggers a corrective
 * re-generation before the user ever sees them.
 *
 * Triggers:
 *   (a) Response shorter than 20 meaningful chars for a non-yes/no prompt.
 *   (b) Substantial prompts (explain, steps, analysis, thesis, plan, etc.)
 *       receiving a thin, generic, evasive, or unstructured reply.
 *   (c) Response matches a known refusal/deflection template ("I can't
 *       help with that", "no puedo ayudarte", etc.).
 *   (d) Response is only whitespace / punctuation.
 *
 * On any trigger, the caller is expected to re-run the generation with
 * an augmented user message that says: "Rewrite from scratch with a direct,
 * structured, concrete answer in the resolved language." The guard stays
 * proportional: greetings and simple acknowledgements are allowed to remain
 * short.
 */

const REFUSAL_PATTERNS = [
  /^i\s+(can'?t|cannot|am\s+unable\s+to|won'?t)\b/i,
  /\bi\s+(can'?t|cannot|am\s+unable\s+to)\s+(help|assist|answer|respond|provide)\b/i,
  /\bno\s+puedo\s+(ayudarte|responderte|contestarte|hacer\s+eso|con\s+eso)\b/i,
  /\blo\s+siento,?\s+(pero\s+)?no\s+puedo\b/i,
  /\bn[aã]o\s+posso\s+(ajudar|responder|fazer)\b/i,
  /\bi'?m\s+sorry,?\s+but\s+i\s+(can'?t|cannot|am\s+unable)\b/i,
  /^as\s+an\s+ai\s+(language\s+)?model,?\s+i\s+(cannot|can'?t)\b/i,
  /\b(i\s+don'?t|no\s+tengo)\s+(have\s+)?(the\s+)?(ability|capability|capacidad)\b/i,
];

const YES_NO_HINT = /^\s*(¿|¡)?(si|sí|no|yes|yeah|nope|ok|vale|claro|seguro|of\s+course)\b/i;
const SIMPLE_QUESTION_HINT = /^(¿|¡)?(is|are|was|were|do|does|did|can|will|should|has|have)\b/i;
const LIGHTWEIGHT_PROMPT = /^\s*(hola|hi|hello|hey|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|ok|vale|listo|perfecto|sí|si|no)[.!?¡¿\s]*$/i;
const SUBSTANTIAL_PROMPT_PATTERNS = [
  /\b(explica|expl[ií]came|explain|describe|desarrolla|analiza|analysis|argumenta|compara|eval[uú]a)\b/i,
  /\b(c[oó]mo|como|how\s+to|por\s+qu[eé]|why|qu[eé]\s+debo|what\s+should)\b/i,
  /\b(pasos|steps|gu[ií]a|guide|proceso|metodolog[ií]a|estrategia|strategy|plan|roadmap)\b/i,
  /\b(resumen\s+ejecutivo|executive\s+summary|tesis|thesis|informe|report|ensayo|proposal|propuesta)\b/i,
  /\b(mejorar|mejora|optimizar|improve|perfeccionar|corregir|review|revisar)\b/i,
];
const GENERIC_THIN_PATTERNS = [
  /^\s*(claro|por supuesto|desde luego|sure|of course)[,.! ]*(puedo\s+ayudarte|te\s+ayudo|i\s+can\s+help)/i,
  /\b(dime|cu[eé]ntame|tell\s+me)\s+(m[aá]s|more|un\s+poco\s+m[aá]s)\b/i,
  /\b(necesito|necesitar[ií]a|i\s+need)\s+(m[aá]s|more)\s+(informaci[oó]n|details|detalles)\b/i,
  /\b(aqu[ií]\s+tienes|here\s+you\s+go)\s*(una\s+respuesta|la\s+respuesta)?\.?\s*$/i,
  /\b(es\s+importante\s+tener\s+en\s+cuenta|it\s+is\s+important\s+to\s+note)\b/i,
];
const STRUCTURE_MARKER = /(^|\n)\s*(#{1,4}\s+|[-*]\s+|\d+[.)]\s+|>\s+)|```|\|.+\|/m;
const CONCRETE_SIGNAL = /\b(por\s+ejemplo|ejemplo|paso|primero|segundo|tercero|define|identifica|revisa|usa|incluye|mide|prioriza|entrega|resultado|plantilla|checklist|tabla)\b/i;

/**
 * Minimum useful length. Anything under this for a non-yes/no prompt is
 * treated as suspect — 20 chars is roughly "sí, funciona." so it lets
 * genuinely short answers through but catches truncations and blanks.
 */
const MIN_USEFUL_LENGTH = 20;
const MIN_SUBSTANTIAL_LENGTH = 120;
// Prompts shorter than this are NEVER treated as "substantial", even when
// they coincidentally contain a pattern word like "explica" or "plan".
// Catches noisy false positives like "explica IA" (11 chars) that were
// triggering an unnecessary corrective pass on gpt-4o-mini.
const MIN_SUBSTANTIAL_PROMPT_LENGTH = 24;

function normalizeText(value) {
  return String(value || '').trim();
}

function looksLightweightPrompt(userPrompt) {
  const text = normalizeText(userPrompt);
  if (!text) return false;
  return text.length <= 80 && LIGHTWEIGHT_PROMPT.test(text);
}

function looksSubstantialPrompt(userPrompt) {
  const text = normalizeText(userPrompt);
  if (!text || looksLightweightPrompt(text)) return false;
  if (text.length >= 70) return true;
  if (text.length < MIN_SUBSTANTIAL_PROMPT_LENGTH) return false;
  return SUBSTANTIAL_PROMPT_PATTERNS.some(pattern => pattern.test(text));
}

function hasUsefulStructure(response) {
  const text = normalizeText(response);
  if (STRUCTURE_MARKER.test(text)) return true;
  const sentences = text.split(/[.!?]\s+/).filter(sentence => sentence.trim().length > 12);
  return sentences.length >= 3;
}

function hasConcreteSignal(response) {
  return CONCRETE_SIGNAL.test(normalizeText(response));
}

function isGenericThinResponse(response) {
  const text = normalizeText(response);
  return GENERIC_THIN_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Decide whether a completion needs a corrective re-run.
 *
 * @param {object} opts
 * @param {string} opts.response   — what the model produced
 * @param {string} opts.userPrompt — what the user asked
 * @returns {{ weak: boolean, reason: string|null }}
 */
function evaluateResponse({ response, userPrompt }) {
  const trimmed = normalizeText(response);
  if (!trimmed) return { weak: true, reason: 'empty' };

  const meaningful = trimmed.replace(/[\s.,!?¿¡:;]+/g, '');
  if (meaningful.length === 0) return { weak: true, reason: 'punctuation-only' };

  // Refusal template?
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { weak: true, reason: `refusal-template:${pattern.source.slice(0, 32)}` };
    }
  }

  const lightweightPrompt = looksLightweightPrompt(userPrompt);
  if (lightweightPrompt) return { weak: false, reason: null };

  // Too short for a question that likely wants a real answer.
  if (trimmed.length < MIN_USEFUL_LENGTH) {
    const userLooksYesNo = YES_NO_HINT.test(userPrompt || '') || SIMPLE_QUESTION_HINT.test((userPrompt || '').trim());
    if (!userLooksYesNo) return { weak: true, reason: 'too-short' };
  }

  const substantialPrompt = looksSubstantialPrompt(userPrompt);
  if (substantialPrompt) {
    if (trimmed.length < MIN_SUBSTANTIAL_LENGTH) {
      return { weak: true, reason: 'too-short-substantial' };
    }
    if (isGenericThinResponse(trimmed) && !hasConcreteSignal(trimmed)) {
      return { weak: true, reason: 'generic-thin' };
    }
    if (trimmed.length < 280 && !hasUsefulStructure(trimmed) && !hasConcreteSignal(trimmed)) {
      return { weak: true, reason: 'unstructured-thin' };
    }
  }

  return { weak: false, reason: null };
}

/** Build the augmented re-prompt for the weak-response retry. */
function buildCorrectivePrompt(originalUserPrompt, language = 'es') {
  const preambles = {
    es: [
      'Reescribe la respuesta desde cero en español.',
      'Entrega una respuesta directa primero, luego estructura profesional si la pregunta lo amerita.',
      'Incluye pasos accionables, ejemplos concretos y un cierre útil. Evita saludos, relleno genérico y evasivas.',
      'Pregunta original:',
    ].join('\n'),
    en: [
      'Rewrite the answer from scratch in English.',
      'Start with the direct answer, then use professional structure when the question warrants it.',
      'Include actionable steps, concrete examples, and a useful closing. Avoid greetings, generic filler, and evasions.',
      'Original question:',
    ].join('\n'),
    pt: [
      'Reescreva a resposta do zero em português.',
      'Comece com a resposta direta e depois use estrutura profissional quando a pergunta pedir.',
      'Inclua passos acionáveis, exemplos concretos e um fechamento útil. Evite saudações, enchimento genérico e evasivas.',
      'Pergunta original:',
    ].join('\n'),
    fr: [
      'Réécris la réponse depuis zéro en français.',
      "Commence par la réponse directe, puis utilise une structure professionnelle si la question l'exige.",
      'Inclue des étapes actionnables, des exemples concrets et une conclusion utile. Évite les salutations, le remplissage générique et les esquives.',
      'Question originale :',
    ].join('\n'),
    de: [
      'Schreibe die Antwort auf Deutsch von Grund auf neu.',
      'Beginne mit der direkten Antwort und nutze danach eine professionelle Struktur, wenn die Frage es verlangt.',
      'Füge umsetzbare Schritte, konkrete Beispiele und einen nützlichen Abschluss hinzu. Vermeide Begrüßungen, generische Füllsätze und Ausweichen.',
      'Ursprüngliche Frage:',
    ].join('\n'),
    it: [
      'Riscrivi la risposta da zero in italiano.',
      'Inizia con la risposta diretta, poi usa una struttura professionale quando la domanda lo richiede.',
      'Includi passaggi azionabili, esempi concreti e una chiusura utile. Evita saluti, riempitivi generici ed evasioni.',
      'Domanda originale:',
    ].join('\n'),
  };
  const preamble = preambles[language] || preambles.es;
  return `${preamble}\n\n${originalUserPrompt}`;
}

module.exports = {
  evaluateResponse,
  buildCorrectivePrompt,
  REFUSAL_PATTERNS,
  MIN_USEFUL_LENGTH,
  MIN_SUBSTANTIAL_LENGTH,
  MIN_SUBSTANTIAL_PROMPT_LENGTH,
  looksLightweightPrompt,
  looksSubstantialPrompt,
};
