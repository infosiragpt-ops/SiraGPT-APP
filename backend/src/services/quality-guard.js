/**
 * quality-guard.js — catches weak completions and triggers a corrective
 * re-generation before the user ever sees them.
 *
 * Triggers:
 *   (a) Response shorter than 20 meaningful chars for a non-yes/no prompt.
 *   (b) Response matches a known refusal/deflection template ("I can't
 *       help with that", "no puedo ayudarte", etc.).
 *   (c) Response is only whitespace / punctuation.
 *
 * On any trigger, the caller is expected to re-run the generation with
 * an augmented user message that says: "Provide a detailed and useful
 * response: [original prompt]". We keep the augment tiny — too much
 * extra steering and the model starts over-explaining trivia.
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

/**
 * Minimum useful length. Anything under this for a non-yes/no prompt is
 * treated as suspect — 20 chars is roughly "sí, funciona." so it lets
 * genuinely short answers through but catches truncations and blanks.
 */
const MIN_USEFUL_LENGTH = 20;

/**
 * Decide whether a completion needs a corrective re-run.
 *
 * @param {object} opts
 * @param {string} opts.response   — what the model produced
 * @param {string} opts.userPrompt — what the user asked
 * @returns {{ weak: boolean, reason: string|null }}
 */
function evaluateResponse({ response, userPrompt }) {
  const trimmed = (response || '').trim();
  if (!trimmed) return { weak: true, reason: 'empty' };

  const meaningful = trimmed.replace(/[\s.,!?¿¡:;]+/g, '');
  if (meaningful.length === 0) return { weak: true, reason: 'punctuation-only' };

  // Refusal template?
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { weak: true, reason: `refusal-template:${pattern.source.slice(0, 32)}` };
    }
  }

  // Too short for a question that likely wants a real answer.
  if (trimmed.length < MIN_USEFUL_LENGTH) {
    const userLooksYesNo = YES_NO_HINT.test(userPrompt || '') || /^(¿|¡)?(is|are|was|were|do|does|did|can|will|should|has|have)\b/i.test((userPrompt || '').trim());
    if (!userLooksYesNo) return { weak: true, reason: 'too-short' };
  }

  return { weak: false, reason: null };
}

/** Build the augmented re-prompt for the weak-response retry. */
function buildCorrectivePrompt(originalUserPrompt, language = 'es') {
  const preambles = {
    es: 'Proporciona una respuesta detallada y útil, con estructura profesional (títulos, listas, ejemplos concretos) y sin evasivas. Pregunta original:',
    en: 'Provide a detailed and useful response, with professional structure (headings, lists, concrete examples) and no evasions. Original question:',
    pt: 'Forneça uma resposta detalhada e útil, com estrutura profissional (títulos, listas, exemplos concretos) e sem evasivas. Pergunta original:',
    fr: 'Fournis une réponse détaillée et utile, avec une structure professionnelle (titres, listes, exemples concrets) et sans esquive. Question originale :',
    de: 'Gib eine detaillierte und nützliche Antwort mit professioneller Struktur (Überschriften, Listen, konkreten Beispielen) und ohne Ausweichen. Ursprüngliche Frage:',
    it: 'Fornisci una risposta dettagliata e utile, con struttura professionale (titoli, elenchi, esempi concreti) e senza evasioni. Domanda originale:',
  };
  const preamble = preambles[language] || preambles.es;
  return `${preamble}\n\n${originalUserPrompt}`;
}

module.exports = {
  evaluateResponse,
  buildCorrectivePrompt,
  REFUSAL_PATTERNS,
  MIN_USEFUL_LENGTH,
};
