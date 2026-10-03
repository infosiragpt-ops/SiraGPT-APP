'use strict';

// Prod 2026-10-03: a WhatsApp photo kept Tesseract busy for 371 s (hundreds
// of "Image too small to scale!!" lines) before the vision rungs ran. The
// local pass now has a wall-clock budget: past the deadline no further
// variant starts, a recognize() still running is abandoned by terminating
// the worker, and the engine hands the image to GLM-OCR / cloud vision.

const test = require('node:test');
const assert = require('node:assert/strict');

const ocrEngine = require('../src/services/ocr-engine');
const { recognizeWithin, tesseractWorkerOptions, localImageBudgetMs, TESSERACT_NOISE_RE } = ocrEngine._internals;

const factories = (names) => names.map((name) => ({ name, make: async () => Buffer.from(name) }));

test('recognizeBestVariant abandons a hung recognize() at the deadline and terminates the worker', async () => {
  let terminated = 0;
  let calls = 0;
  const worker = {
    recognize() { calls += 1; return new Promise(() => {}); }, // never settles
    async terminate() { terminated += 1; },
  };
  const t0 = Date.now();
  const result = await ocrEngine.recognizeBestVariant(worker, factories(['a', 'b', 'c']), ocrEngine.config, {
    maxVariants: 3,
    deadlineAt: Date.now() + 120,
  });
  assert.ok(Date.now() - t0 < 2000, 'returns promptly after the deadline');
  assert.equal(result.timedOut, true);
  assert.equal(calls, 1, 'no further variant after the timeout');
  assert.equal(terminated, 1, 'the WASM job is stopped by terminating the worker');
  assert.equal(result.variants, 0);
  assert.equal(result.quality.accepted, false);
});

test('a deadline already in the past means no recognize() call at all', async () => {
  let calls = 0;
  const worker = { async recognize() { calls += 1; return { data: { text: 'x', confidence: 1 } }; }, async terminate() {} };
  const result = await ocrEngine.recognizeBestVariant(worker, factories(['a']), ocrEngine.config, {
    maxVariants: 1,
    deadlineAt: Date.now() - 1,
  });
  assert.equal(calls, 0);
  assert.equal(result.timedOut, true);
});

test('without a deadline the selector behaves as before (fast variants, no timeout flag)', async () => {
  let calls = 0;
  const worker = {
    async recognize() {
      calls += 1;
      return { data: { text: 'Texto limpio con suficiente contenido para ser aceptado por el motor OCR.', confidence: 95 } };
    },
    async terminate() {},
  };
  const result = await ocrEngine.recognizeBestVariant(worker, factories(['a', 'b']), { ...ocrEngine.config, minUsefulChars: 20, minConfidence: 70 }, { maxVariants: 2 });
  assert.equal(calls, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.quality.accepted, true);
});

test('recognizeWithin resolves the real result when it beats the deadline', async () => {
  const worker = { async recognize() { return { data: { text: 'ok', confidence: 90 } }; }, async terminate() { throw new Error('must not terminate'); } };
  const out = await recognizeWithin(worker, Buffer.from('x'), Date.now() + 5000);
  assert.equal(out.timedOut, false);
  assert.equal(out.result.data.text, 'ok');
});

test('local image budget: env override, option override, 20 s default', () => {
  const saved = process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS;
  try {
    delete process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS;
    assert.equal(localImageBudgetMs(), 20_000);
    process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS = '7000';
    assert.equal(localImageBudgetMs(), 7000);
    assert.equal(localImageBudgetMs({ localBudgetMs: 1500 }), 1500);
    process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS = 'nope';
    assert.equal(localImageBudgetMs(), 20_000);
  } finally {
    if (saved === undefined) delete process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS;
    else process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS = saved;
  }
});

test('tesseract worker error handler swallows blob-rejection noise but keeps real worker errors', () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const { errorHandler } = tesseractWorkerOptions();
    errorHandler('Image too small to scale!! (2x36 vs min width of 3)');
    errorHandler(new Error('Line cannot be recognized!!'));
    assert.equal(warned.length, 0);
    errorHandler(new Error('Error: Failed to load language data'));
    assert.equal(warned.length, 1);
    assert.match(warned[0], /tesseract worker/);
    assert.ok(TESSERACT_NOISE_RE.test('Estimating resolution as 300'));
  } finally {
    console.warn = origWarn;
  }
});

test('extractFromImage source: a timed-out local pass skips tiling and reports local_ocr_timeout', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ocr-engine.js'), 'utf8');
  assert.match(src, /!localResult\.timedOut && imageAnalyzer\.shouldTileOcr/);
  assert.match(src, /localResult\.timedOut \? 'local_ocr_timeout'/);
  // Every worker gets the noise filter (image, tiled, PDF pages, streaming).
  const created = (src.match(/await createWorker\(/g) || []).length;
  const filtered = (src.match(/await createWorker\([^\n]*tesseractWorkerOptions\(\)\)/g) || []).length;
  assert.equal(created, filtered, 'every createWorker call passes tesseractWorkerOptions()');
});
