// Detects when an attachment-bound user question lacks enough material
// to answer with confidence. Used by the agent task runner to short-circuit
// the LLM call and ask the user for more context, instead of silently
// producing an unhelpful "no se pudo determinar" response.
//
// Updated to support hierarchical document context format.

const SCAFFOLDING_PREFIXES = [
  '### Archivo adjunto',
  'PDF document',
  'Word document',
  'Excel workbook',
  'PowerPoint presentation',
  'Image document',
  'id:',
  'tipo:',
  'analysisId:',
  'resumen tecnico:',
  'fragmentos analizados:',
  'pregunta del usuario:',
  'Para analisis profesionales:',
  'Para análisis profesionales:',
  // New hierarchical context prefixes
  '[', // chunk labels like "[1] Introduction"
  'Esquema del documento:',
  'Resumen progresivo:',
  'Estrategia:',
  '---',
  'Tamano:',
  'Documento cargado:',
  // Synthesis/format directives injected by buildUploadedFileContext. They lead
  // their line, so a precise startsWith match avoids stripping legitimate prose.
  'Para analisis profesionales:',
  'El usuario pidio',
  'Lote grande detectado',
];

const SCAFFOLDING_NEEDLES = [
  'Contexto inicial de archivos adjuntos',
  'Usa este contenido para responder',
  'Para evidencia estructurada llama',
  'Para evidencia estructurada adicional llama',
  'Contenido relevante recuperado desde todo el documento',
  'Evidencia estructurada disponible:',
  'Primeras referencias estructuradas disponibles:',
  'Tablas detectadas:',
  '[Extracto truncado',
  '[Extracto balanceado',
  '[La evidencia fue recuperada',
  // New
  'Tablas (',
  'Esquema del documento:',
  'Resumen progresivo:',
  'Estrategia:',
  // Mid-line synthesis directive guard (the line-leading variants are handled by
  // SCAFFOLDING_PREFIXES). Distinctive enough to never match real document prose.
  'sintetiza con criterio academico',
];

function stripEvidenceLabel(line) {
  const trimmed = String(line || '').trim();
  const evidenceMatch = trimmed.match(/^Evidencia\s+\d+\s+\[[^\]]+\]:\s*(.+)$/i);
  if (evidenceMatch) return evidenceMatch[1].trim();
  const bulletReferenceMatch = trimmed.match(/^-\s+[^:]{1,160}:\s+(.+)$/);
  if (bulletReferenceMatch) return bulletReferenceMatch[1].trim();
  return trimmed;
}

function stripScaffolding(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '---') continue;
    const lower = trimmed.toLowerCase();
    if (SCAFFOLDING_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))) continue;
    if (SCAFFOLDING_NEEDLES.some((needle) => lower.includes(needle.toLowerCase()))) continue;
    const content = stripEvidenceLabel(trimmed);
    if (!content) continue;
    kept.push(content);
  }
  return kept
    .join('\n')
    .replace(/\b(?:PDF document|Word document|Excel workbook|PowerPoint presentation|Image document)\s*[—-]\s*[^.\n]*(?:extracted|markdown|page\(s\)|sheet\(s\)|slide\(s\))[^.\n]*/giu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countUsefulWords(rawText) {
  const body = stripScaffolding(rawText);
  const matches = body.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{2,}/g) || [];
  return matches.length;
}

const ATTACHMENT_REFERENCE_RE = /\b(est[aeo]s?|aqu[ií]|el documento|el archivo|la imagen|la foto|la captura|el pdf|el word|el excel|el texto|esto|esta|este|que dice|qu[eé] dice|qu[eé] es|qu[eé] son|qu[eé] trata|qu[eé] significa|qu[eé] aparece|de qu[eé]|cu[aá]l|cu[aá]ntos|d[oó]nde|cu[aá]ndo|por qu[eé]|c[oó]mo|qui[eé]n|analiza(?:r|me)?|an[aá]lisis|resume(?:n|me)?|resumir|conclusi[oó]n|conclusiones|concluye|p[aá]rrafos?|extrae(?:r|me)?|transcrib(?:e|ir|eme|irme)?|seg[uú]n|qu[eé] contiene|qu[eé] dice|qu[eé] menciona|qu[eé] informacion|qu[eé] datos|qu[eé] secciones|qu[eé] paginas|estructura|tabla|seccion|secci[oó]n|cap[ií]tulo|resume|res[úu]men|s[ií]ntesis)\b/i;

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
