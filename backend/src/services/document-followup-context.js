'use strict';

const MAX_SOURCE_CONTENT_CHARS = 24_000;

function normalizeForFollowup(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(value = '') {
  return (String(value || '').match(/[a-z0-9áéíóúñ]+/gi) || []).length;
}

function isPreviousContentExportRequest(prompt = '') {
  const text = normalizeForFollowup(prompt);
  if (!text || text.length > 420) return false;

  const hasOutputFormat =
    /\b(?:word|docx|documento|archivo|pdf|markdown|md|html|descarg(?:a|ar|able|arlo|armelo|amelo)|download)\b/.test(text)
    || /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|documento|archivo)\b/.test(text);
  if (!hasOutputFormat) return false;

  const hasCarryOverReference =
    /\b(?:lo|la|esto|eso|esta|este|anterior|arriba|respuesta|resultado|contenido|texto|calculo|calculo anterior|mensaje anterior|ya generado|que generaste)\b/.test(text);
  const hasExportAction =
    /\b(?:pon|poner|ponlo|ponla|ponga|coloca|colocar|colocalo|colocarlo|colocado|pasalo|pasar|mete|meter|insertalo|insertar|exporta|exportar|convierte|convertir|descarga|descargar|prepara|preparalo|guardalo|guardar)\b/.test(text);
  const hasNewTopicSignal =
    /\b(?:sobre|acerca de|tema|con estos datos|con la siguiente|redacta|investiga|fuentes|doi|articulos|articulos cientificos)\b/.test(text);

  if (hasCarryOverReference && (hasExportAction || text.length <= 180)) return true;
  return hasExportAction && hasOutputFormat && !hasNewTopicSignal && wordCount(text) <= 16;
}

function parseFiles(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hasFileAttachment(message) {
  return parseFiles(message?.files).length > 0;
}

function isDocumentDeliveryBoilerplate(content = '') {
  const text = normalizeForFollowup(content);
  if (!text) return true;
  return /documento generado por (?:la )?pipeline/.test(text)
    || /verificaciones tecnicas:\s*\d+\s*\/\s*\d+/.test(text)
    || /documento listo:\s*`?[^`\s]+/i.test(String(content || ''));
}

function cleanAssistantContentForDocument(messageOrContent) {
  const raw = typeof messageOrContent === 'string'
    ? messageOrContent
    : String(messageOrContent?.content || '');
  const withoutDocumentTags = raw.replace(/\[CREATE_DOCUMENT:[^\]]+\][\s\S]*?\[\/CREATE_DOCUMENT\]/gi, '').trim();
  const cleaned = withoutDocumentTags
    .replace(/\bdata:[a-z0-9/+.-]+;base64,[a-z0-9+/=]+/gi, '[archivo adjunto omitido]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= MAX_SOURCE_CONTENT_CHARS) return cleaned;
  return cleaned.slice(0, MAX_SOURCE_CONTENT_CHARS).trimEnd();
}

function findPreviousAssistantContent(messages = []) {
  const ordered = Array.isArray(messages) ? messages : [];
  for (const message of ordered) {
    if (String(message?.role || '').toUpperCase() !== 'ASSISTANT') continue;
    const cleaned = cleanAssistantContentForDocument(message);
    if (cleaned.length < 12) continue;
    if (isDocumentDeliveryBoilerplate(cleaned)) continue;
    if (hasFileAttachment(message) && cleaned.length < 1_200) continue;
    return cleaned;
  }
  return null;
}

function buildPreviousContentDocumentPrompt({ prompt, sourceContent, format } = {}) {
  const requestedFormat = String(format || 'docx').replace(/^markdown$/i, 'md');
  return [
    String(prompt || '').trim(),
    '',
    'Convierte el contenido fuente anterior en un archivo descargable.',
    `Formato requerido: ${requestedFormat}.`,
    'Usa el contenido fuente como cuerpo principal del documento; no lo reemplaces por una confirmación genérica ni por texto de plantilla.',
    'Preserva títulos, viñetas, tablas, fórmulas, símbolos y resultados numéricos exactamente cuando ya existan.',
    '',
    '<SIRAGPT_SOURCE_CONTENT>',
    String(sourceContent || '').trim(),
    '</SIRAGPT_SOURCE_CONTENT>',
  ].join('\n');
}

module.exports = {
  MAX_SOURCE_CONTENT_CHARS,
  normalizeForFollowup,
  isPreviousContentExportRequest,
  cleanAssistantContentForDocument,
  findPreviousAssistantContent,
  buildPreviousContentDocumentPrompt,
  INTERNAL: {
    wordCount,
    isDocumentDeliveryBoilerplate,
    parseFiles,
  },
};
