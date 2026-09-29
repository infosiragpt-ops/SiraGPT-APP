'use strict';

// This is a finite list of formats with readers, not a claim that every
// extension can be validated by decoding arbitrary bytes as text.
const FORMATS = Object.freeze({
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'office'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'office'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'office'],
  sav: ['application/x-spss-sav', 'spss'],
  sps: ['text/plain', 'statistical_syntax'],
  pdf: ['application/pdf', 'pdf'],
  odt: ['application/vnd.oasis.opendocument.text', 'odf'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet', 'odf'],
  odp: ['application/vnd.oasis.opendocument.presentation', 'odf'],
  rtf: ['application/rtf', 'rtf'],
  json: ['application/json', 'json'],
  html: ['text/html', 'html'], htm: ['text/html', 'html'],
  svg: ['image/svg+xml', 'svg'],
  xml: ['application/xml', 'xml'],
  yaml: ['application/yaml', 'yaml'], yml: ['application/yaml', 'yaml'],
  csv: ['text/csv', 'csv'],
  txt: ['text/plain', 'text'], md: ['text/markdown', 'text'],
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'],
  gif: ['image/gif', 'image'], webp: ['image/webp', 'image'], ico: ['image/x-icon', 'image'],
  mp4: ['video/mp4', 'media'], webm: ['video/webm', 'media'],
  mp3: ['audio/mpeg', 'media'], wav: ['audio/wav', 'media'],
  zip: ['application/zip', 'zip'],
});
const EXTENSION_TO_MIME = Object.freeze(Object.fromEntries(Object.entries(FORMATS).map(([ext, spec]) => [ext, spec[0]])));
function normalizeFormat(value) {
  const ext = String(value || '').toLowerCase().replace(/^\./, '');
  return ext === 'markdown' ? 'md' : ext;
}
function formatSpec(value) {
  const format = normalizeFormat(value);
  const spec = FORMATS[format];
  return spec ? { format, mime: spec[0], family: spec[1] } : null;
}
module.exports = { FORMATS, EXTENSION_TO_MIME, normalizeFormat, formatSpec };
