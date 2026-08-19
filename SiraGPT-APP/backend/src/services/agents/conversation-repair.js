'use strict';

/**
 * conversation-repair
 *
 * Cierra el ciclo de comprensión. Detecta turns donde el usuario está
 * corrigiendo una respuesta previa ("no, en español", "eso no es lo que
 * quería", "en formato Excel"), clasifica el tipo de corrección y
 * construye un addendum al system prompt que:
 *   1. Marca explícitamente qué interpretación previa fue rechazada.
 *   2. Indica el probable intent corregido.
 *   3. Instruye al LLM a NO repetir la interpretación previa.
 *
 * Detección 100% regex local (sin LLM, <5ms). Tipos:
 *   - wrong_language   ("en español", "in spanish", "en inglés")
 *   - wrong_format     ("en Excel", "en Word", "in PDF")
 *   - wrong_scope      ("más corto", "más largo", "más detallado")
 *   - wrong_intent     ("eso no es lo que quería", "no es eso")
 *
 * Política conservadora: si no estamos seguros, NO marcar como repair
 * (false positives son MÁS costosos que missed repairs porque añaden
 * ruido al system prompt).
 *
 * Fail-open: si algo falla, retorna {isRepair: false}.
 */

const REPAIR_PATTERNS = Object.freeze({
  wrong_language: {
    re: /\b(?:en\s+(?:español|espanol|ingl[eé]s|portugu[eé]s|franc[eé]s|alem[aá]n|italiano|chino|japon[eé]s)|in\s+(?:spanish|english|french|german|italian|portuguese|chinese|japanese)|por\s+favor\s+en\s+(?:español|ingl[eé]s))\b/i,
    description: 'usuario pide cambio de idioma',
  },
  wrong_format: {
    re: /\b(?:(?:no|mejor|prefiero|quiero|necesito|en\s+(?:realidad|verdad)),?\s+(?:en\s+)?(?:formato\s+)?(?:word|docx|excel|xlsx|pdf|powerpoint|pptx|markdown|md|html|csv|json|texto\s+plano)|(?:in|as)\s+(?:word|excel|pdf|powerpoint|markdown|html|csv|json|plain\s+text))\b/i,
    description: 'usuario pide cambio de formato',
  },
  wrong_scope: {
    re: /\b(?:(?:m[aá]s|menos)\s+(?:corto|largo|breve|detallado|conciso|amplio|profundo|extenso|simple|t[eé]cnico|formal|casual)|(?:shorter|longer|more\s+detail(?:ed)?|less\s+detail|simpler|more\s+technical))\b/i,
    description: 'usuario pide ajuste de scope/tono',
  },
  wrong_intent: {
    re: /^\s*[¡¿]?\s*(?:no\b|eso\s+no\s+(?:es|era)\b|no\s+es\s+(?:eso|lo\s+que)|me\s+refer[ií]a\s+a|quer[ií]a\s+(?:decir|que)|that['’]?s?\s+not\s+(?:what|right)|i\s+meant)/i,
    description: 'usuario rechaza la interpretación previa',
  },
});

const MIN_PREVIOUS_LENGTH = 20; // si no hay turn previo significativo, no es repair

function classifyRepair(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const text = prompt.trim();
  if (!text) return null;
  for (const [type, def] of Object.entries(REPAIR_PATTERNS)) {
    if (def.re.test(text)) {
      const match = text.match(def.re);
      return { repairType: type, evidence: match[0], description: def.description };
    }
  }
  return null;
}

/**
 * detectRepair — pure. Returns { isRepair, repairType, evidence, prevSnippet }
 * o {isRepair:false} si no aplica.
 */
function detectRepair({ prompt, prevTurn = null, prevUserPrompt = null, signals = null } = {}) {
  try {
    const classification = classifyRepair(prompt);
    if (!classification) return { isRepair: false };

    // Requiere un turno previo del assistant significativo.
    const prevText = prevTurn?.text || prevTurn?.content || '';
    if (typeof prevText !== 'string' || prevText.trim().length < MIN_PREVIOUS_LENGTH) {
      // Sin contexto previo no podemos repair; típicamente es chitchat o turn inicial.
      return { isRepair: false, reason: 'no_significant_prev_turn' };
    }

    return {
      isRepair: true,
      repairType: classification.repairType,
      evidence: classification.evidence.slice(0, 80),
      description: classification.description,
      prevSnippet: prevText.slice(0, 200),
      prevUserPromptSnippet: typeof prevUserPrompt === 'string' ? prevUserPrompt.slice(0, 120) : null,
      signalsContext: signals && typeof signals === 'object' ? signals : null,
    };
  } catch (_) {
    return { isRepair: false };
  }
}

/**
 * buildRepairContext — pure. Returns {systemAddendum, contractOverride}.
 *
 * El systemAddendum es un anti-pattern explícito: dice al LLM qué NO
 * hacer (no repetir interpretación previa) y sugiere el intent corregido.
 *
 * El contractOverride es opcional y solo se rellena para casos donde
 * podemos derivar un patch concreto (ej. wrong_format → required_extension).
 */
function buildRepairContext(detection) {
  if (!detection || !detection.isRepair) {
    return { systemAddendum: null, contractOverride: null };
  }
  const { repairType, evidence, prevSnippet, prevUserPromptSnippet, description } = detection;
  const lines = ['## CONVERSATION_REPAIR'];
  lines.push(`El usuario rechazó la respuesta previa (${description || repairType}).`);
  if (prevUserPromptSnippet) {
    lines.push(`Petición original: "${prevUserPromptSnippet}"`);
  }
  if (prevSnippet) {
    lines.push(`Respuesta previa (snippet): "${prevSnippet.slice(0, 120)}…"`);
  }
  lines.push(`Indicio de corrección: "${evidence}"`);
  lines.push('');
  switch (repairType) {
    case 'wrong_language':
      lines.push('Acción: regenera la respuesta previa en el idioma que pide el usuario. NO repitas el idioma anterior.');
      break;
    case 'wrong_format':
      lines.push('Acción: regenera el artefacto en el formato que pide el usuario. NO devuelvas el formato anterior.');
      break;
    case 'wrong_scope':
      lines.push('Acción: ajusta el scope/longitud/tono de la respuesta previa según pide el usuario. NO entregues la misma versión.');
      break;
    case 'wrong_intent':
    default:
      lines.push('Acción: reinterpreta la petición original con un intent distinto al previo. Si la corrección es vaga, ofrece 2-3 alternativas concretas antes de ejecutar.');
      break;
  }
  lines.push('Cierra con: "Aquí va la versión corregida." y procede.');

  const contractOverride = {};
  // wrong_format puede sugerir extensión concreta
  if (repairType === 'wrong_format') {
    const ext = extractExtensionFromEvidence(evidence);
    if (ext) contractOverride.required_extension = ext;
  }

  return {
    systemAddendum: lines.join('\n'),
    contractOverride: Object.keys(contractOverride).length > 0 ? contractOverride : null,
  };
}

const FORMAT_TO_EXT = Object.freeze({
  word: '.docx',
  docx: '.docx',
  excel: '.xlsx',
  xlsx: '.xlsx',
  pdf: '.pdf',
  powerpoint: '.pptx',
  pptx: '.pptx',
  markdown: '.md',
  md: '.md',
  html: '.html',
  csv: '.csv',
  json: '.json',
});

function extractExtensionFromEvidence(evidence) {
  if (!evidence) return null;
  const lowered = evidence.toLowerCase();
  for (const [keyword, ext] of Object.entries(FORMAT_TO_EXT)) {
    if (lowered.includes(keyword)) return ext;
  }
  return null;
}

module.exports = {
  detectRepair,
  classifyRepair,
  buildRepairContext,
  extractExtensionFromEvidence,
  REPAIR_PATTERNS,
  FORMAT_TO_EXT,
};
