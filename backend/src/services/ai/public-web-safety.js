'use strict';

const CREATE_DOCUMENT_CONTROL = /\[\/?CREATE_DOCUMENT[^\]]*\]/gi;

function safeEmptyResponse(language) {
  return String(language || 'es').toLowerCase().startsWith('es')
    ? 'No pude generar una respuesta segura a partir de la evidencia web pública.'
    : 'I could not generate a safe answer from the public-web evidence.';
}

function scrubPublicWebResponse(content, { language = 'es' } = {}) {
  const original = String(content || '');
  const scrubbed = original.replace(CREATE_DOCUMENT_CONTROL, '').trim();
  if (scrubbed === original) {
    return { content: original, changed: false };
  }
  return {
    content: scrubbed || safeEmptyResponse(language),
    changed: true,
  };
}

module.exports = {
  scrubPublicWebResponse,
};
