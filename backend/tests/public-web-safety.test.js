'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  scrubPublicWebResponse,
} = require('../src/services/ai/public-web-safety');

test('public-web response scrub removes CREATE_DOCUMENT controls', () => {
  assert.deepEqual(
    scrubPublicWebResponse('Respuesta\n[CREATE_DOCUMENT:secret.txt]contenido[/CREATE_DOCUMENT]'),
    { content: 'Respuesta\ncontenido', changed: true },
  );
});

test('control-only output becomes a localized safe response', () => {
  const spanish = scrubPublicWebResponse(
    '[CREATE_DOCUMENT:secret.txt][/CREATE_DOCUMENT]',
    { language: 'es' },
  );
  const english = scrubPublicWebResponse(
    '[CREATE_DOCUMENT:secret.txt][/CREATE_DOCUMENT]',
    { language: 'en' },
  );

  assert.equal(spanish.changed, true);
  assert.match(spanish.content, /respuesta segura/i);
  assert.equal(english.changed, true);
  assert.match(english.content, /safe answer/i);
  assert.doesNotMatch(`${spanish.content}${english.content}`, /CREATE_DOCUMENT/i);
});

test('clean output is preserved byte-for-byte', () => {
  assert.deepEqual(
    scrubPublicWebResponse('Respuesta pública limpia'),
    { content: 'Respuesta pública limpia', changed: false },
  );
});
