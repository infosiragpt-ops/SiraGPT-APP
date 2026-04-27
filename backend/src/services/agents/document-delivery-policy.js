const WORDISH_RE = /\b(word|docx|informe|tesis|ensayo|monograf[ií]a|reporte|paper|art[ií]culo|marco te[oó]rico|legal|contrato|documento)\b/i;
const SHEET_RE = /\b(excel|xlsx|spreadsheet|tabla|tabular|kpi|dashboard|f[oó]rmula|c[aá]lculo|presupuesto|base de datos|ventas|costos|margen|filas|columnas)\b/i;
const DECK_RE = /\b(ppt|pptx|powerpoint|presentaci[oó]n|slides?|diapositivas?|pitch|defensa|exposici[oó]n|deck)\b/i;
const PDF_RE = /\b(pdf|certificado|formulario|imprimible|constancia|recibo)\b/i;
const LONG_DELIVERABLE_RE = /\b(extenso|profesional|completo|detallado|profund[oa]|acad[eé]mic[oa]|investigaci[oó]n|an[aá]lisis|estrategia|plan de negocio|consultor[ií]a|entregable)\b/i;

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

function classifyMode(text, estimatedWords, format, files = []) {
  const explicitDocument = WORDISH_RE.test(text) || SHEET_RE.test(text) || DECK_RE.test(text) || PDF_RE.test(text);
  if (explicitDocument) return 'doc_required';
  if (estimatedWords >= 900) return 'doc_required';
  if (estimatedWords >= 500 || files.length > 0 || LONG_DELIVERABLE_RE.test(text)) return 'doc_suggested';
  if (format !== 'docx' && estimatedWords >= 300) return 'doc_suggested';
  return 'chat_only';
}

function buildDocumentDeliveryPolicy({
  goal,
  displayGoal,
  finalText,
  files = [],
  requestedFormat = null,
} = {}) {
  const text = compactText(`${goal || ''} ${displayGoal || ''} ${finalText || ''}`);
  const estimated = estimateWords({ goal, displayGoal, finalText });
  const format = detectFormat(text, requestedFormat);
  const template = detectTemplate(text, format);
  const mode = classifyMode(text, estimated, format, Array.isArray(files) ? files : []);
  const tableSignals = SHEET_RE.test(text);
  const complexity = detectComplexity(text, estimated);
  const reason = (() => {
    if (mode === 'chat_only') return 'Respuesta conversacional corta; no requiere archivo.';
    if (mode === 'doc_suggested') return 'La respuesta tiene suficiente densidad para sugerir un documento profesional.';
    if (estimated >= 900) return 'Respuesta prevista mayor a 900 palabras; documento requerido.';
    if (format === 'xlsx') return 'Solicitud tabular/de datos; Excel requerido.';
    if (format === 'pptx') return 'Solicitud de presentación; PowerPoint requerido.';
    if (format === 'pdf') return 'Solicitud imprimible/formal; PDF requerido.';
    return 'Entregable documental explícito; Word requerido.';
  })();

  return {
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
    },
    palette: PALETTES[template] || PALETTES.business,
  };
}

module.exports = {
  PALETTES,
  buildDocumentDeliveryPolicy,
  detectComplexity,
  detectFormat,
  detectTemplate,
  estimateWords,
  wordCount,
};
