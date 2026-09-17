'use strict';

/**
 * Software vs document routing.
 *
 * "créame una web de ventas" is a software/code deliverable (HTML/CSS/JS or
 * a small app), not a Document Sandbox Word/PDF. True document asks
 * ("rédactame un informe de ventas en Word") still win.
 *
 * Domain phrases like "datos de ventas" or "copy de ventas para el brochure"
 * must not force the coding plane.
 */

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CREATE_RE = /\b(crea(?:r|me)?|haz(?:me)?|genera(?:r|me)?|desarrolla(?:r|me)?|programa(?:r|me)?|construye(?:r|me)?|implementa(?:r|me)?|disena(?:r|me)?|maqueta(?:r|me)?|arma(?:r|me)?|build|make|develop|quiero|necesito)\b/;

const SOFTWARE_NOUN_RE = /\b(sitio web|pagina web|website|webpage|landing page|landing|web app|aplicacion web|aplicacion|ecommerce|e-commerce|tienda online|saas|software|app|(?:una|un|mi)\s+web|web\s+(?:de|para|app|con)|pagina(?:\s+(?:de|para))\s+\w+)\b/;

const OFFICE_FORMAT_RE = /\b(word|docx|pdf|excel|xlsx|pptx?|powerpoint|power\s*point)\b/;

const DOCUMENT_NOUN_RE = /\b(informe|ensayo|reporte|tesis|monografia|brochure|folleto|propuesta|contrato|manual|documento|presentacion|diapositivas?|copy)\b/;

const COPY_OR_DATA_RE = /\b(datos de ventas|copy de ventas|analisis de ventas|tabla de ventas|cifras de ventas|copy\b.{0,40}\bbrochure|copy\b.{0,40}\bfolleto)\b/;

const DIAGRAM_RE = /\b(diagrama|mermaid|organigrama|grafico|grafica|chart|uml|swot|foda|mapa mental)\b/;

const STACK_DELIVERABLE_RE = /\b(app web|web app|sitio web|pagina web|landing|e-?commerce|tienda online)\b/;
const STACK_HINT_RE = /\b(next\.?js|react|tailwind|html|css|javascript|typescript|vite)\b/;

function isCopyOrDataAsk(text) {
  return COPY_OR_DATA_RE.test(normalize(text));
}

function isExplicitDocumentRequest(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:word|docx|pdf|excel|xlsx|pptx?|powerpoint|documento\s+word)\b/.test(n)) {
    return true;
  }
  if (OFFICE_FORMAT_RE.test(n) && (CREATE_RE.test(n) || DOCUMENT_NOUN_RE.test(n))) {
    return true;
  }
  if (CREATE_RE.test(n) && DOCUMENT_NOUN_RE.test(n) && !SOFTWARE_NOUN_RE.test(n)) {
    return true;
  }
  return false;
}

function isSoftwareBuildRequest(text) {
  const n = normalize(text);
  if (!n) return false;
  if (isCopyOrDataAsk(n)) return false;
  if (DIAGRAM_RE.test(n)) return false;
  if (isExplicitDocumentRequest(n)) return false;
  if (CREATE_RE.test(n) && SOFTWARE_NOUN_RE.test(n)) return true;
  return STACK_DELIVERABLE_RE.test(n) && STACK_HINT_RE.test(n);
}

function shouldBlockOfficeCreateDocument(filename, requestText) {
  const ext = String(filename || '').toLowerCase().replace(/^.*\./, '');
  if (!/^(docx|xlsx|pptx|pdf)$/.test(ext)) return false;
  return isSoftwareBuildRequest(requestText) && !isExplicitDocumentRequest(requestText);
}

const E_SOFTWARE_CODE = 'E_SOFTWARE_CODE';

function softwareCodeBlockMessage() {
  return `${E_SOFTWARE_CODE}: esta solicitud pide software con codigo real (HTML/CSS/JS o una app), no un Word/PDF. Usa create_artifact tipo html o archivos .html/.css/.js.`;
}

module.exports = {
  normalize,
  isCopyOrDataAsk,
  isExplicitDocumentRequest,
  isSoftwareBuildRequest,
  shouldBlockOfficeCreateDocument,
  E_SOFTWARE_CODE,
  softwareCodeBlockMessage,
};
