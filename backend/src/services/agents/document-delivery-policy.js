const WORDISH_RE = /\b(word|docx|informe|tesis|ensayo|monograf[ií]a|reporte|paper|art[ií]culo|marco te[oó]rico|legal|contrato|documento)\b/i;
const SHEET_RE = /\b(excel|xlsx|spreadsheet|tabla|tabular|kpi|dashboard|f[oó]rmula|c[aá]lculo|presupuesto|base de datos|ventas|costos|margen|filas|columnas)\b/i;
const DECK_RE = /\b(ppt|pptx|powerpoint|presentaci[oó]n|slides?|diapositivas?|pitch|defensa|exposici[oó]n|deck)\b/i;
const PDF_RE = /\b(pdf|certificado|formulario|imprimible|constancia|recibo)\b/i;
const LONG_DELIVERABLE_RE = /\b(extenso|profesional|completo|detallado|profund[oa]|acad[eé]mic[oa]|investigaci[oó]n|an[aá]lisis|estrategia|plan de negocio|consultor[ií]a|entregable)\b/i;
const TRANSCRIPTION_RE = /\b(transcrib(?:e|ir|eme|irme|iendo|irlo|irla|elo|ela)?|transcripci[oó]n|transcribe|transcript|transcription)\b/i;
const EXPLICIT_WORD_OUTPUT_RE = /\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:word|docx|documento\s+word)\b|\b(?:word|docx|documento\s+word)\b/i;
const EXPLICIT_SHEET_OUTPUT_RE = /\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:excel|xlsx|spreadsheet|hoja\s+de\s+c[aá]lculo)\b|\b(?:excel|xlsx|spreadsheet)\b/i;
const EXPLICIT_DECK_OUTPUT_RE = /\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:ppt|pptx|power\s*point|powerpoint|presentaci[oó]n|diapositivas?)\b|\b(?:ppt|pptx|power\s*point|powerpoint)\b/i;
const EXPLICIT_PDF_OUTPUT_RE = /\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?pdf\b|\bpdf\b/i;
const EXPLICIT_TRANSCRIPTION_OUTPUT_RE = /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|presentaci[oó]n)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|dame|prepara(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|documento|archivo|informe|reporte|presentaci[oó]n)\b/i;
const DOCUMENT_UNDERSTANDING_RE = /\b(analiza(?:r|me)?|an[aá]lisis|resume(?:n|me)?|resumir|extrae(?:r|me)?|transcrib(?:e|ir|eme|irme)?|qu[eé]\s+dice|seg[uú]n\s+(?:el\s+)?documento|archivo\s+adjunto|documento\s+adjunto|evidencia)\b/i;
const CHAT_ONLY_DIRECTIVE_RE = /\b(?:no\s+(?:crees?|crear|generes?|generar|hagas?|hacer|exportes?|exportar|prepares?|preparar|descargues?|descargar)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:archivos?|documentos?|word|docx|pdf|excel|xlsx|pptx?|power\s*point|powerpoint|entregables?)|responde(?:r)?\s+(?:solo|solamente)?\s*(?:en\s+)?(?:el\s+)?chat|solo\s+en\s+chat|sin\s+(?:archivos?|documentos?|descarga|entregables?))\b/i;
// Read/inquiry intents about a previously-shared document. Matches
// phrases like "cuál es el título del word", "de qué trata el
// documento", "qué dice el pdf", "cómo se llama el archivo", "resume
// el word", "lee el documento", "ábreme el pdf", "cuántas páginas
// tiene el excel". These reference the file the user already shared
// in a previous turn (so `files` may be empty on the current turn)
// and must NOT be promoted to doc_required just because the prompt
// contains the literal word "word" / "documento" / "pdf".
const DOCUMENT_INQUIRY_RE = /\b(?:cu[aá]l(?:es)?|qu[eé]|c[oó]mo|de\s+qu[eé]|qui[eé]n(?:es)?|cu[aá]ndo|d[oó]nde|por\s+qu[eé]|cu[aá]nt[oa]s?|resume(?:me|n)?|res[uú]meme|lee(?:me)?|l[eé]eme|abre(?:me)?|[aá]breme|muestra(?:me)?|mu[eé]strame|dime|cu[eé]ntame|expl[ií]came|explica(?:me)?|busca(?:me)?|encuentra(?:me)?|de\s+qu[eé]\s+trata|sobre\s+qu[eé])\b[^.?!]{0,160}\b(?:word|docx|documento|archivo|pdf|excel|xlsx|hoja\s+de\s+c[aá]lculo|pptx|power\s*point|powerpoint|presentaci[oó]n|adjunto|texto)\b/i;
const EXPLICIT_DOCUMENT_OUTPUT_RE = /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|presentaci[oó]n|documento|archivo)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|documento|archivo|informe|reporte|presentaci[oó]n)\b/i;

let sourcePreservingEditMod = null;
function isSourcePreservingEdit(requestText, files) {
  try {
    if (!sourcePreservingEditMod) {
      sourcePreservingEditMod = require('../source-preserving-document-edit');
    }
    return sourcePreservingEditMod.isSourcePreservingEditRequest(requestText, Array.isArray(files) ? files : []);
  } catch {
    return false;
  }
}

const PALETTES = {
  academic: {
    id: 'academic',
    label: 'Academic',
    colors: { primary: '#17324D', surface: '#FFFFFF', neutral: '#E5E7EB', accent: '#7F1D1D' },
  },
  business: {
    id: 'business',
    label: 'Business',
    colors: { primary: '#0F172A', surface: '#F8FAFC', neutral: '#475569', accent: '#059669', warning: '#D97706' },
  },
  pitch: {
    id: 'pitch',
    label: 'Pitch',
    colors: { primary: '#111827', surface: '#FFFFFF', accent: '#F97316', secondary: '#06B6D4' },
  },
  tesis_upn: {
    id: 'tesis_upn',
    label: 'Tesis UPN',
    colors: { primary: '#102A43', surface: '#FFF7ED', neutral: '#CBD5E1', accent: '#C2410C' },
  },
};

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function wordCount(value) {
  const text = compactText(value);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateWords({ goal, displayGoal, finalText } = {}) {
  const existingWords = wordCount(finalText);
  if (existingWords) return existingWords;

  const text = `${goal || ''} ${displayGoal || ''}`;
  let estimate = Math.max(180, wordCount(text) * 22);
  if (LONG_DELIVERABLE_RE.test(text)) estimate += 650;
  if (/\b(10|15|20|30|40|50|\d+\s+(p[aá]ginas|hojas|slides?|diapositivas?|art[ií]culos|fuentes))\b/i.test(text)) estimate += 550;
  if (/\b(paso a paso|conclusiones|referencias|bibliograf[ií]a|metodolog[ií]a|resultados)\b/i.test(text)) estimate += 350;
  return estimate;
}

function detectFormat(text, requestedFormat) {
  const requested = compactText(requestedFormat).toLowerCase().replace(/^\./, '');
  if (['docx', 'xlsx', 'pptx', 'pdf'].includes(requested)) return requested;
  const explicitDeck = EXPLICIT_DECK_OUTPUT_RE.test(text);
  const explicitPdf = EXPLICIT_PDF_OUTPUT_RE.test(text);
  const explicitSheet = EXPLICIT_SHEET_OUTPUT_RE.test(text);
  const explicitWord = EXPLICIT_WORD_OUTPUT_RE.test(text);
  if (explicitDeck) return 'pptx';
  if (explicitPdf) return 'pdf';
  if (explicitSheet && !explicitWord) return 'xlsx';
  if (explicitWord) return 'docx';
  if (SHEET_RE.test(text)) return 'xlsx';
  if (DECK_RE.test(text)) return 'pptx';
  if (PDF_RE.test(text)) return 'pdf';
  if (WORDISH_RE.test(text) || LONG_DELIVERABLE_RE.test(text)) return 'docx';
  return 'docx';
}

function detectTemplate(text, format) {
  if (/\b(upn|tesis upn)\b/i.test(text)) return 'tesis_upn';
  if (/\b(tesis|acad[eé]mic|paper|art[ií]culo|apa|universidad|investigaci[oó]n)\b/i.test(text)) return 'academic';
  if (format === 'xlsx') return 'business';
  if (format === 'pptx' || /\b(pitch|startup|inversionistas?|ventas|marca|marketing)\b/i.test(text)) return 'pitch';
  return 'business';
}

function detectComplexity(text, estimatedWords) {
  if (estimatedWords >= 1800 || /\b(extremadamente|avanzado|corporativo|varias hojas|formulas|validaciones|automatizaci[oó]n)\b/i.test(text)) return 'high';
  if (estimatedWords >= 900 || LONG_DELIVERABLE_RE.test(text)) return 'standard';
  return 'simple';
}

// Classification is intentionally driven by the user's request text only.
// The assistant's draft answer can mention "documento", "informe" or
// "tabla" while answering a plain question, and matching on that text
// would auto-promote conversational turns to doc_required.
function classifyMode(requestText, estimatedWords, format, files = [], options = {}) {
  if (options.transcriptionOnly || options.chatOnlyDirective) return 'chat_only';
  const documentUnderstanding = DOCUMENT_UNDERSTANDING_RE.test(requestText);
  const explicitOutput = EXPLICIT_DOCUMENT_OUTPUT_RE.test(requestText);
  if (isSourcePreservingEdit(requestText, files)) return 'doc_required';
  // Read/inquiry intent about a doc the user already shared in a
  // prior turn must short-circuit BEFORE the WORDISH/SHEET/DECK/PDF
  // check below — otherwise "cuál es el título del word?" matches
  // WORDISH on the literal "word" and gets promoted to doc_required,
  // generating a brand-new DOCX instead of answering the question.
  if (DOCUMENT_INQUIRY_RE.test(requestText) && !explicitOutput) {
    return 'chat_only';
  }
  if (documentUnderstanding && !explicitOutput) {
    return estimatedWords >= 900 || LONG_DELIVERABLE_RE.test(requestText) ? 'doc_suggested' : 'chat_only';
  }
  if (Array.isArray(files) && files.length > 0 && !explicitOutput) {
    return estimatedWords >= 900 || LONG_DELIVERABLE_RE.test(requestText) ? 'doc_suggested' : 'chat_only';
  }
  const explicitDocument = WORDISH_RE.test(requestText) || SHEET_RE.test(requestText) || DECK_RE.test(requestText) || PDF_RE.test(requestText);
  if (explicitDocument) return 'doc_required';
  if (estimatedWords >= 900) return 'doc_suggested';
  if (estimatedWords >= 500 || LONG_DELIVERABLE_RE.test(requestText)) return 'doc_suggested';
  if (format !== 'docx' && estimatedWords >= 300) return 'doc_suggested';
  return 'chat_only';
}

function hasExplicitDocumentOutputRequest(value) {
  return EXPLICIT_DOCUMENT_OUTPUT_RE.test(compactText(value));
}

// Motivos que declaran explícitamente que el documento es opcional / no
// automático. Si uno de estos aparece junto a mode:"doc_required" hay una
// contradicción: la política dice "sugerir" pero los flags fuerzan.
const SUGGESTION_REASON_RE = /no\s+autom[aá]tic|sugerid|opcional/i;
const VALID_MODES = new Set(['chat_only', 'doc_suggested', 'doc_required']);

// Punto único de coherencia para cualquier documentPolicy, venga del builder,
// del payload del cliente o de estado persistido. Garantiza invariantes para
// que `mode`, `autoGenerate` y `reason` no puedan volver a divergir:
//   1. doc_required  ⇒ autoGenerate:true  (entregable impuesto)
//   2. todo lo demás ⇒ autoGenerate:false (sugerencia/chat, requiere usuario)
//   3. un reason que menciona "no automático"/"sugerido"/"opcional" es
//      incompatible con doc_required: la intención declarada (sugerir) gana y
//      degrada el modo a doc_suggested.
function normalizeDocumentPolicyCoherence(policy) {
  if (!policy || typeof policy !== 'object') return policy;
  let mode = VALID_MODES.has(policy.mode) ? policy.mode : 'chat_only';
  const reason = typeof policy.reason === 'string' ? policy.reason : '';
  if (mode === 'doc_required' && SUGGESTION_REASON_RE.test(reason)) {
    mode = 'doc_suggested';
  }
  const autoGenerate = mode === 'doc_required';
  if (mode === policy.mode && autoGenerate === policy.autoGenerate) {
    return policy;
  }
  return { ...policy, mode, autoGenerate };
}

function hasChatOnlyDirective(value) {
  return CHAT_ONLY_DIRECTIVE_RE.test(compactText(value));
}

function buildDocumentDeliveryPolicy({
  goal,
  displayGoal,
  finalText,
  files = [],
  requestedFormat = null,
} = {}) {
  const requestText = compactText(`${goal || ''} ${displayGoal || ''}`);
  // `text` mixes request + draft answer and is only used for descriptive
  // signals (template / table hints / complexity). Routing-critical
  // decisions (format, mode) must come from `requestText` so the
  // assistant's wording can never promote a chat turn to doc_required.
  const text = compactText(`${requestText} ${finalText || ''}`);
  const transcriptionOnly = TRANSCRIPTION_RE.test(requestText) && !EXPLICIT_TRANSCRIPTION_OUTPUT_RE.test(requestText);
  const chatOnlyDirective = hasChatOnlyDirective(requestText);
  const explicitOutput = hasExplicitDocumentOutputRequest(requestText);
  const documentUnderstanding = DOCUMENT_UNDERSTANDING_RE.test(requestText);
  const estimated = estimateWords({ goal, displayGoal, finalText });
  const format = detectFormat(requestText, requestedFormat);
  const template = detectTemplate(text, format);
  const mode = classifyMode(requestText, estimated, format, Array.isArray(files) ? files : [], { transcriptionOnly, chatOnlyDirective });
  const tableSignals = SHEET_RE.test(text);
  const complexity = detectComplexity(text, estimated);
  const reason = (() => {
    if (transcriptionOnly) return 'Solicitud de transcripción literal; se responde en chat salvo que el usuario pida un archivo.';
    if (chatOnlyDirective) return 'El usuario pidio responder en chat y no generar archivos.';
    if (DOCUMENT_UNDERSTANDING_RE.test(requestText) && !EXPLICIT_DOCUMENT_OUTPUT_RE.test(requestText)) return 'Solicitud de analisis documental; se responde primero en chat y se sugiere documento solo si hace falta.';
    if (mode === 'chat_only') return 'Respuesta conversacional corta; no requiere archivo.';
    // Los motivos de "sugerencia" (documento opcional, no automático) deben
    // quedar confinados a doc_suggested. Si se filtran a doc_required el
    // reason contradice autoGenerate:true. Por eso se resuelven aquí, antes
    // de los motivos imperativos de doc_required.
    if (mode === 'doc_suggested') {
      return estimated >= 900
        ? 'Respuesta prevista extensa; documento sugerido, no automatico.'
        : 'La respuesta tiene suficiente densidad para sugerir un documento profesional.';
    }
    // mode === 'doc_required': entregable impuesto. El motivo nunca debe
    // insinuar opcionalidad para no divergir de autoGenerate:true.
    if (format === 'xlsx') return 'Solicitud tabular/de datos; Excel requerido.';
    if (format === 'pptx') return 'Solicitud de presentación; PowerPoint requerido.';
    if (format === 'pdf') return 'Solicitud imprimible/formal; PDF requerido.';
    return 'Entregable documental explícito; Word requerido.';
  })();

  return normalizeDocumentPolicyCoherence({
    mode,
    format,
    template,
    complexity,
    reason,
    autoGenerate: mode === 'doc_required',
    thresholds: {
      wordCount: wordCount(finalText),
      estimatedWords: estimated,
      tableSignals,
      fileCount: Array.isArray(files) ? files.length : 0,
      transcriptionOnly,
      explicitOutput,
      chatOnlyDirective,
      documentUnderstanding,
    },
    palette: PALETTES[template] || PALETTES.business,
  });
}

module.exports = {
  PALETTES,
  buildDocumentDeliveryPolicy,
  normalizeDocumentPolicyCoherence,
  detectComplexity,
  detectFormat,
  detectTemplate,
  estimateWords,
  hasChatOnlyDirective,
  hasExplicitDocumentOutputRequest,
  wordCount,
};
