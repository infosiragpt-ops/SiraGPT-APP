// Detects when an attachment-bound user question lacks enough material
// to answer with confidence. Used by the agent task runner to short-circuit
// the LLM call and ask the user for more context, instead of silently
// producing an unhelpful "no se pudo determinar" response.

const SCAFFOLDING_PREFIXES = [
  '### Archivo adjunto',
  'id:',
  'tipo:',
  'analysisId:',
  'resumen tecnico:',
];

const SCAFFOLDING_NEEDLES = [
  'Contexto inicial de archivos adjuntos',
  'Usa este contenido para responder',
  'Para evidencia estructurada llama',
  'Evidencia estructurada disponible:',
  'Tablas detectadas:',
  '[Extracto truncado',
];

function stripScaffolding(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '---') continue;
    if (SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
    if (SCAFFOLDING_NEEDLES.some((needle) => trimmed.includes(needle))) continue;
    kept.push(trimmed);
  }
  return kept.join('\n');
}

function countUsefulWords(rawText) {
  const body = stripScaffolding(rawText);
  const matches = body.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{2,}/g) || [];
  return matches.length;
}

const ATTACHMENT_REFERENCE_RE = /\b(est[aeo]s?|aqu[ií]|el documento|el archivo|la imagen|la foto|la captura|el pdf|el word|el excel|el texto|esto|esta|este|que dice|qu[eé] dice|qu[eé] es|qu[eé] son|qu[eé] trata|qu[eé] significa|qu[eé] aparece|de qu[eé]|cu[aá]l|cu[aá]ntos|d[oó]nde|cu[aá]ndo|por qu[eé]|c[oó]mo|qui[eé]n)\b/i;

function referencesAttachment(text) {
  return ATTACHMENT_REFERENCE_RE.test(String(text || ''));
}

const DEFAULT_THIN_THRESHOLD = 30;

function assessAttachmentContext({
  uploadedFileContext = '',
  files = [],
  userText = '',
  threshold = DEFAULT_THIN_THRESHOLD,
} = {}) {
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!hasFiles) {
    return { hasFiles: false, usefulWords: 0, references: false, threshold, isThin: false };
  }
  const usefulWords = countUsefulWords(uploadedFileContext);
  const references = referencesAttachment(userText);
  return {
    hasFiles: true,
    usefulWords,
    references,
    threshold,
    isThin: usefulWords < threshold && references,
  };
}

module.exports = {
  assessAttachmentContext,
  countUsefulWords,
  referencesAttachment,
  stripScaffolding,
  DEFAULT_THIN_THRESHOLD,
};
