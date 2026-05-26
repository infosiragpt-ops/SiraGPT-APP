const test = require('node:test');
const assert = require('node:assert/strict');

const ocrEngine = require('../src/services/ocr-engine');

test('OcrEngine rejects empty OCR placeholders as invalid text', () => {
  assert.equal(ocrEngine.hasUsefulText('No text found in image'), false);
  assert.equal(ocrEngine.hasUsefulText('No text detected in image PDF'), false);
  assert.equal(ocrEngine.hasUsefulText('File "capture.png" uploaded successfully. Content type: image/png'), false);
});

test('OcrEngine accepts local OCR when text and confidence are strong', () => {
  const quality = ocrEngine.evaluateQuality({
    text: 'FACULTAD DE NEGOCIOS\nAdministracion y negocios internacionales',
    confidence: 91,
  });

  assert.equal(quality.accepted, true);
  assert.equal(quality.reason, 'ok');
  assert.ok(quality.usefulChars >= 20);
});

test('OcrEngine requests vision fallback for weak local OCR in hybrid mode', () => {
  const quality = ocrEngine.evaluateQuality({
    text: 'FACULTAD DE NEGOCIOS ADMINISTRACION',
    confidence: 42,
  });

  assert.equal(quality.accepted, false);
  assert.equal(quality.usefulButWeak, true);
  assert.equal(ocrEngine.shouldUseVisionFallback(quality, { mode: 'hybrid' }), true);
  assert.equal(ocrEngine.shouldUseVisionFallback(quality, { mode: 'local' }), false);
});

test('OcrEngine keeps short but confident transcriptions usable', () => {
  const quality = ocrEngine.evaluateQuality({
    text: 'hola',
    confidence: 94,
  });

  assert.equal(quality.accepted, false);
  assert.equal(quality.legibleShort, true);
  assert.equal(ocrEngine.hasUsefulText('hola'), true);
});
