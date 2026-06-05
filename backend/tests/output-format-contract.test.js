const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOutputFormatRequest,
  requestedParagraphCount,
  wantsSingleParagraphSynthesis,
  wantsBulletList,
  buildFormatDirectiveLines,
} = require('../src/services/output-format-contract');

test('detects paragraph counts in digit form', () => {
  assert.equal(parseOutputFormatRequest('dame un resumen en 2 párrafos').paragraphs, 2);
  assert.equal(requestedParagraphCount('resumen en 3 parrafos'), 3);
});

test('detects paragraph counts in Spanish word form', () => {
  assert.equal(parseOutputFormatRequest('resúmelo en dos párrafos').paragraphs, 2);
  assert.equal(parseOutputFormatRequest('hazlo en tres parrafos').paragraphs, 3);
  assert.equal(requestedParagraphCount('en cuatro párrafos por favor'), 4);
});

test('caps requestedParagraphCount at 6 and ignores counts < 2', () => {
  assert.equal(requestedParagraphCount('en 10 parrafos'), 6);
  assert.equal(requestedParagraphCount('en 1 parrafo'), 0);
  assert.equal(requestedParagraphCount('sin formato especial'), 0);
});

test('detects single-paragraph requests (digit and word)', () => {
  assert.equal(wantsSingleParagraphSynthesis('responde en un solo párrafo'), true);
  assert.equal(wantsSingleParagraphSynthesis('en un parrafo'), true);
  assert.equal(wantsSingleParagraphSynthesis('parrafo unico'), true);
  assert.equal(parseOutputFormatRequest('en un solo párrafo').paragraphs, 1);
  assert.equal(wantsSingleParagraphSynthesis('en dos párrafos'), false);
});

test('detects bullet and numbered lists', () => {
  assert.equal(parseOutputFormatRequest('dame una lista de puntos clave').list, 'bullet');
  assert.equal(parseOutputFormatRequest('con viñetas').list, 'bullet');
  assert.equal(parseOutputFormatRequest('en una lista numerada').list, 'numbered');
  assert.equal(parseOutputFormatRequest('enuméralos por favor').list, 'numbered');
  assert.equal(wantsBulletList('dame puntos clave'), true);
  assert.equal(wantsBulletList('un resumen normal'), false);
});

test('detects table requests', () => {
  assert.equal(parseOutputFormatRequest('preséntalo en una tabla').table, true);
  assert.equal(parseOutputFormatRequest('un cuadro comparativo').table, true);
  assert.equal(parseOutputFormatRequest('un resumen breve').table, false);
});

test('detects word and sentence limits', () => {
  assert.equal(parseOutputFormatRequest('en máximo 100 palabras').maxWords, 100);
  assert.equal(parseOutputFormatRequest('responde en 3 oraciones').maxSentences, 3);
  assert.equal(parseOutputFormatRequest('en dos frases').maxSentences, 2);
});

test('builds Spanish directive lines for paragraph requests', () => {
  const lines = buildFormatDirectiveLines('en 2 párrafos', { lang: 'es' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 parrafos/);
  assert.match(lines[0], /exactamente 2 parrafos/);
});

test('builds English directive lines prefixed with bullet dash', () => {
  const lines = buildFormatDirectiveLines('in 3 paragraphs... en 3 párrafos', { lang: 'en' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('- '));
  assert.match(lines[0], /exactly 3/);
});

test('table directive takes precedence over paragraph directive', () => {
  const lines = buildFormatDirectiveLines('resúmelo en una tabla de 2 párrafos', { lang: 'es' });
  // Only the table structure line is emitted (mutually exclusive).
  assert.equal(lines.length, 1);
  assert.match(lines[0], /tabla/i);
});

test('length constraints compose with structure directives', () => {
  const lines = buildFormatDirectiveLines('en 2 párrafos, máximo 80 palabras', { lang: 'es' });
  assert.equal(lines.length, 2);
  assert.match(lines.join('\n'), /2 parrafos/);
  assert.match(lines.join('\n'), /80 palabras/);
});

test('returns no directive lines when no format was requested', () => {
  assert.deepEqual(buildFormatDirectiveLines('¿de qué trata el documento?', { lang: 'es' }), []);
  assert.deepEqual(buildFormatDirectiveLines('', { lang: 'en' }), []);
});
