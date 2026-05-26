/**
 * Tests for the GPT-4o-vision fallback in fileProcessor.processImage.
 *
 * No real I/O against ocrEngine or OpenAI — every test stubs both.
 * Coverage:
 *   - _shouldApplyVisionFallback honours env flag + char/confidence
 *     thresholds + presence of an OpenAI client (env OR injected)
 *   - _flattenLayoutToText preserves headings (markdown), figures,
 *     captions, and blank-line separators
 *   - processImage with forceVisionFallback=true swaps Tesseract output
 *     for the vision result when the vision text is longer
 *   - processImage with forceVisionFallback=true KEEPS Tesseract result
 *     when vision output is shorter (no regression)
 *   - processImage swallows vision-side failures without tearing down
 *     the upload (fallback to whatever Tesseract gave us)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub ocrEngine BEFORE requiring fileProcessor so the fileProcessor
// instance picks up our fake implementation.
const ocrCalls = [];
let ocrResponse = { text: '', ocr: { confidence: 1, provider: 'tesseract' } };
require.cache[require.resolve('../src/services/ocr-engine')] = {
  exports: {
    extractFromImage: async (filePath, options) => {
      ocrCalls.push({ filePath, options });
      return ocrResponse;
    },
    extractFromPdfImages: async () => ({ text: '', ocr: {} }),
    hasUsefulText: (t) => !!t && t.length > 0,
    skipped: (reason) => ({ text: '', ocr: { reason, status: 'skipped' } }),
  },
};

const fileProcessor = require('../src/services/fileProcessor');

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function fakeOpenai(layoutPayload) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(layoutPayload) } }],
        }),
      },
    },
  };
}

// Tiny PNG file on disk so processImage can fs.readFile without crashing.
function tempImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-vision-'));
  const file = path.join(dir, 'in.png');
  // Smallest valid PNG (1x1 transparent). Bytes lifted from spec.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
      '5d0a2db40000000049454e44ae426082',
    'hex',
  );
  fs.writeFileSync(file, png);
  return file;
}

// ── _shouldApplyVisionFallback ────────────────────────────────────────────

test('_shouldApplyVisionFallback returns false by default (env flag off)', () => {
  const out = fileProcessor._shouldApplyVisionFallback(
    { text: 'a', ocr: { confidence: 0.1 } },
    {},
  );
  assert.equal(out, false);
});

test('_shouldApplyVisionFallback returns false without any OpenAI key/client', async () => {
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '1', OPENAI_API_KEY: undefined }, () => {
    const out = fileProcessor._shouldApplyVisionFallback(
      { text: 'short', ocr: { confidence: 0.1 } },
      {},
    );
    assert.equal(out, false);
  });
});

test('_shouldApplyVisionFallback triggers on short Tesseract output when enabled', async () => {
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '1', OPENAI_API_KEY: 'sk-test' }, () => {
    const out = fileProcessor._shouldApplyVisionFallback(
      { text: 'short', ocr: { confidence: 0.95 } },
      {},
    );
    assert.equal(out, true);
  });
});

test('_shouldApplyVisionFallback triggers on low confidence even when text is long', async () => {
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '1', OPENAI_API_KEY: 'sk-test' }, () => {
    const longText = 'a'.repeat(500);
    const out = fileProcessor._shouldApplyVisionFallback(
      { text: longText, ocr: { confidence: 0.2 } },
      {},
    );
    assert.equal(out, true);
  });
});

test('_shouldApplyVisionFallback does NOT trigger with long text + high confidence', async () => {
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '1', OPENAI_API_KEY: 'sk-test' }, () => {
    const out = fileProcessor._shouldApplyVisionFallback(
      { text: 'a'.repeat(500), ocr: { confidence: 0.95 } },
      {},
    );
    assert.equal(out, false);
  });
});

test('_shouldApplyVisionFallback honours options.forceVisionFallback override', () => {
  assert.equal(
    fileProcessor._shouldApplyVisionFallback({ text: 'a'.repeat(500), ocr: { confidence: 1 } }, { forceVisionFallback: true }),
    true,
  );
  assert.equal(
    fileProcessor._shouldApplyVisionFallback({ text: '', ocr: { confidence: 0 } }, { forceVisionFallback: false }),
    false,
  );
});

test('_shouldApplyVisionFallback accepts an injected openai client (no env key)', async () => {
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '1', OPENAI_API_KEY: undefined }, () => {
    const out = fileProcessor._shouldApplyVisionFallback(
      { text: 'short', ocr: { confidence: 0.1 } },
      { openai: { chat: { completions: { create: async () => ({}) } } } },
    );
    assert.equal(out, true);
  });
});

// ── _flattenLayoutToText ─────────────────────────────────────────────────

test('_flattenLayoutToText preserves headings as markdown and joins with blank lines', () => {
  const text = fileProcessor._flattenLayoutToText({
    elements: [
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'First paragraph.' },
      { type: 'heading', level: 2, text: 'Sub' },
      { type: 'paragraph', text: 'Second paragraph.' },
    ],
  });
  assert.equal(text, '# Title\n\nFirst paragraph.\n\n## Sub\n\nSecond paragraph.');
});

test('_flattenLayoutToText labels figures and italicises captions', () => {
  const text = fileProcessor._flattenLayoutToText({
    elements: [
      { type: 'figure', text: 'Bar chart of monthly rainfall.' },
      { type: 'caption', text: 'Figure 1. Monthly rainfall.' },
    ],
  });
  assert.match(text, /\[figure\] Bar chart/);
  assert.match(text, /\*Figure 1\. Monthly rainfall\.\*/);
});

test('_flattenLayoutToText skips empty/invalid elements', () => {
  const text = fileProcessor._flattenLayoutToText({
    elements: [
      { type: 'paragraph', text: 'real' },
      { type: 'paragraph', text: '' },
      null,
      { type: 'paragraph' },
    ],
  });
  assert.equal(text, 'real');
});

test('_flattenLayoutToText returns empty string on non-object input', () => {
  assert.equal(fileProcessor._flattenLayoutToText(null), '');
  assert.equal(fileProcessor._flattenLayoutToText({}), '');
});

// ── processImage integration ─────────────────────────────────────────────

test('processImage swaps Tesseract output for vision result when vision text is longer', async () => {
  ocrResponse = { text: 'short', ocr: { confidence: 0.3, provider: 'tesseract' } };
  ocrCalls.length = 0;

  const visionPayload = {
    language: 'es',
    elements: [
      { type: 'heading', readingOrder: 1, text: 'Título del documento', level: 1, rows: 0 },
      { type: 'paragraph', readingOrder: 2, text: 'Cuerpo extendido con mucho más texto que el OCR.', level: 0, rows: 0 },
      { type: 'table', readingOrder: 3, text: '| col | val |\n|-----|-----|\n| a | 1 |', level: 0, rows: 3 },
    ],
    hasTables: true,
    hasFigures: false,
    hasMath: false,
  };

  const file = tempImage();
  const out = await fileProcessor.processImage(file, {
    detailed: true,
    forceVisionFallback: true,
    openai: fakeOpenai(visionPayload),
    mimeType: 'image/png',
  });

  assert.ok(out.extractedText.includes('# Título del documento'));
  assert.ok(out.extractedText.includes('| col | val |'));
  assert.equal(out.ocr.visionFallback, true);
  assert.equal(out.ocr.originalProvider, 'tesseract');
  assert.equal(out.ocr.provider, 'gpt-4o-vision');
});

test('processImage keeps Tesseract result when vision output is shorter', async () => {
  ocrResponse = { text: 'a long enough tesseract result that the vision will not beat', ocr: { confidence: 0.9, provider: 'tesseract' } };

  const visionPayload = {
    language: 'es',
    elements: [{ type: 'paragraph', readingOrder: 1, text: 'short', level: 0, rows: 0 }],
    hasTables: false, hasFigures: false, hasMath: false,
  };

  const file = tempImage();
  const out = await fileProcessor.processImage(file, {
    detailed: true,
    forceVisionFallback: true,
    openai: fakeOpenai(visionPayload),
    mimeType: 'image/png',
  });
  assert.match(out.extractedText, /tesseract result/);
  assert.equal(out.ocr.visionFallback, undefined);
});

test('processImage swallows vision-side failures and returns Tesseract result', async () => {
  ocrResponse = { text: 'fallback tesseract text', ocr: { confidence: 0.3, provider: 'tesseract' } };

  const file = tempImage();
  const throwingOpenai = { chat: { completions: { create: async () => { throw new Error('vision down'); } } } };
  const out = await fileProcessor.processImage(file, {
    detailed: true,
    forceVisionFallback: true,
    openai: throwingOpenai,
    mimeType: 'image/png',
  });
  // No crash; Tesseract text is returned unchanged.
  assert.equal(out.extractedText, 'fallback tesseract text');
  assert.equal(out.ocr.provider, 'tesseract');
});
