'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ocrEngine = require('../src/services/ocr-engine');

function makeFactories(names) {
  return names.map((name) => ({
    name,
    make: async () => Buffer.from(name),
  }));
}

test('OCR multipass selector keeps scanning variants until a high-quality page is found', async () => {
  const calls = [];
  const worker = {
    async recognize(buffer) {
      const name = buffer.toString('utf8');
      calls.push(name);
      if (name === 'normalize_sharpen') {
        return { data: { text: '   ', confidence: 10 } };
      }
      return {
        data: {
          text: 'Contrato marco con obligaciones, penalidades, fechas y condiciones de cumplimiento claramente legibles.',
          confidence: 96,
        },
      };
    },
  };

  const result = await ocrEngine.recognizeBestVariant(
    worker,
    makeFactories(['normalize_sharpen', 'contrast_sharpen', 'threshold_165']),
    { ...ocrEngine.config, minUsefulChars: 20, minConfidence: 70 },
    { maxVariants: 3 },
  );

  assert.deepEqual(calls, ['normalize_sharpen', 'contrast_sharpen']);
  assert.equal(result.variant, 'contrast_sharpen');
  assert.equal(result.variants, 2);
  assert.equal(result.quality.accepted, true);
});

test('OCR multipass selector respects maxVariants on weak pages', async () => {
  let calls = 0;
  const worker = {
    async recognize() {
      calls += 1;
      return { data: { text: 'ruido', confidence: 12 } };
    },
  };

  const result = await ocrEngine.recognizeBestVariant(
    worker,
    makeFactories(['v1', 'v2', 'v3', 'v4', 'v5']),
    { ...ocrEngine.config, minUsefulChars: 30, minConfidence: 70 },
    { maxVariants: 3 },
  );

  assert.equal(calls, 3);
  assert.equal(result.variants, 3);
  assert.equal(result.quality.accepted, false);
});

test('OCR multipass selector skips a broken preprocessing variant', async () => {
  let calls = 0;
  const worker = {
    async recognize() {
      calls += 1;
      return {
        data: {
          text: 'Texto recuperado despues de una variante rota con suficiente contenido verificable.',
          confidence: 91,
        },
      };
    },
  };

  const result = await ocrEngine.recognizeBestVariant(
    worker,
    [
      { name: 'broken', make: async () => { throw new Error('sharp failed'); } },
      { name: 'normalize_sharpen', make: async () => Buffer.from('ok') },
    ],
    { ...ocrEngine.config, minUsefulChars: 20, minConfidence: 70 },
    { maxVariants: 2 },
  );

  assert.equal(calls, 1);
  assert.equal(result.variant, 'normalize_sharpen');
  assert.equal(result.quality.accepted, true);
});

test('OCR PDF variant config is bounded for production safety', () => {
  const saved = process.env.OCR_PDF_MAX_VARIANTS;
  process.env.OCR_PDF_MAX_VARIANTS = '99';
  try {
    assert.equal(ocrEngine.config.pdfMaxVariants, 5);
  } finally {
    if (saved === undefined) delete process.env.OCR_PDF_MAX_VARIANTS;
    else process.env.OCR_PDF_MAX_VARIANTS = saved;
  }
});
