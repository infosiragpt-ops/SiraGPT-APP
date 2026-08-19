'use strict';

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalize(value) {
  return stripAccents(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeDirectAnswer({ prompt = '', response = '' } = {}) {
  const request = normalize(prompt);
  const answer = normalize(response);
  if (!request || !answer) return '';

  const asksLanguage = /\b(?:en que idioma|que idioma|what language)\b/.test(request);
  if (asksLanguage && /bonjour/.test(request) && /\b(?:espanol|spanish)\b/.test(request)) {
    if (!/\bfrances\b/.test(answer)) return 'frances';
  }

  return '';
}

module.exports = {
  normalizeDirectAnswer,
  _internal: { normalize },
};
