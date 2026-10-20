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

// Timers and Date.now do not necessarily cross an integer millisecond together.
// Drive them independently, without real sleeps or replacing the OCR outcome.
function controlledClock(t, initialNow = 1000) {
  let now = initialNow;
  let nextId = 0;
  const timers = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(global, 'clearTimeout', (id) => timers.delete(id));
  return {
    get pending() { return timers.size; },
    nextDelay() {
      assert.equal(timers.size, 1, 'exactly one recognition deadline is pending');
      return timers.values().next().value.delay;
    },
    fireAt(value) {
      assert.ok(value >= now, 'the controlled wall clock never moves backwards');
      assert.equal(timers.size, 1, 'exactly one recognition deadline fires');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      now = value;
      timer.callback();
    },
  };
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('an early timer wake keeps recognition pending until the original absolute deadline', async (t) => {
  const clock = controlledClock(t);
  let calls = 0;
  let terminated = 0;
  let settled = false;
  const worker = {
    recognize() { calls += 1; return new Promise(() => {}); },
    async terminate() { terminated += 1; },
  };
  const pending = recognizeWithin(worker, Buffer.from('page'), 2200);
  pending.then(() => { settled = true; });
  await flushPromises();
  assert.equal(clock.nextDelay(), 1200);
  clock.fireAt(2199);
  await flushPromises();
  assert.equal(settled, false, 'a wake one millisecond early is not a timeout');
  assert.equal(terminated, 0, 'the running worker remains alive before the deadline');
  assert.equal(clock.nextDelay(), 1, 'only the original deadline remainder is scheduled');
  clock.fireAt(2200);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.terminated, true);
  assert.equal(calls, 1, 'rearming a timer never repeats the OCR operation');
  assert.equal(terminated, 1);
  assert.equal(clock.pending, 0);
});

test('recognition can succeed after an early wake and clears the rearmed timer', async (t) => {
  const clock = controlledClock(t);
  let resolveRecognition;
  let calls = 0;
  let terminated = 0;
  const worker = {
    recognize() {
      calls += 1;
      return new Promise((resolve) => { resolveRecognition = resolve; });
    },
    async terminate() { terminated += 1; },
  };
  const pending = recognizeWithin(worker, Buffer.from('page'), 2200);
  await flushPromises();
  clock.fireAt(2199);
  await flushPromises();
  resolveRecognition({ data: { text: 'Lectura completada', confidence: 95 } });
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.result.data.text, 'Lectura completada');
  assert.equal(calls, 1);
  assert.equal(terminated, 0);
  assert.equal(clock.pending, 0, 'the replacement timer is cleared on success');
});

test('cancellation after an early wake stops recognition and clears the rearmed timer', async (t) => {
  const clock = controlledClock(t);
  const controller = new AbortController();
  let calls = 0;
  let terminated = 0;
  const worker = {
    recognize() { calls += 1; return new Promise(() => {}); },
    async terminate() { terminated += 1; },
  };
  const pending = recognizeWithin(worker, Buffer.from('page'), 2200, controller.signal);
  await flushPromises();
  clock.fireAt(2199);
  await flushPromises();
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false, 'an early wake cannot win against later cancellation');
  assert.equal(result.terminated, true);
  assert.equal(calls, 1);
  assert.equal(terminated, 1);
  assert.equal(clock.pending, 0, 'the replacement timer is cleared on cancellation');
});

// Prepared page buffers bypass rendering only. Recognition, variant selection,
// per-page reads, worker disposal and both PDF traversals stay real.
function controlledPdf(t, pageBudgetMs) {
  const clock = controlledClock(t);
  const calls = [];
  const workers = [];
  const rendered = [];
  let pageTwoStarted;
  const started = new Promise((resolve) => { pageTwoStarted = resolve; });
  const config = { ...ocrEngine.config, pdfPageBudgetMs: pageBudgetMs, pdfMaxVariants: 1 };
  t.mock.getter(ocrEngine, 'config', () => config);
  t.mock.method(ocrEngine, 'createPdfPageVariants', (buffer) => [async () => buffer]);
  t.mock.method(ocrEngine, '_openPdf', async () => ({
    length: 3,
    async getPage(page) { rendered.push(page); return Buffer.from([page]); },
    async* [Symbol.asyncIterator]() {
      for (let page = 1; page <= 3; page += 1) {
        rendered.push(page);
        yield Buffer.from([page]);
      }
    },
  }));
  t.mock.method(ocrEngine, 'createOcrWorker', async () => {
    const worker = {
      terminated: false,
      async setParameters() {},
      async terminate() { worker.terminated = true; },
      recognize(buffer) {
        const page = buffer[0];
        calls.push(page);
        if (page === 2) {
          pageTwoStarted();
          return new Promise(() => {});
        }
        return Promise.resolve({
          data: {
            text: 'Contrato de arrendamiento celebrado entre las partes para el local comercial ubicado en Lima.',
            confidence: 94,
          },
        });
      },
    };
    workers.push(worker);
    return worker;
  });
  return { clock, calls, workers, rendered, started };
}

for (const mode of ['streaming', 'subset']) {
  for (const pageBudgetMs of [5000, 1000]) {
    const documentExpires = pageBudgetMs > 1200;
    test(`${mode} PDF: an early ${documentExpires ? 'document' : 'page'} deadline wake preserves the correct traversal boundary`, async (t) => {
      const { clock, calls, workers, rendered, started } = controlledPdf(t, pageBudgetMs);
      const options = { budgetMs: 1200, allowVision: false };
      const pending = mode === 'streaming'
        ? ocrEngine.extractFromPdfImagesStreaming('/fake.pdf', options)
        : ocrEngine.extractPdfPagesSubset('/fake.pdf', [1, 2, 3], options);
      await started;
      const deadline = documentExpires ? 2200 : 2000;
      clock.fireAt(deadline - 1);
      await flushPromises();
      assert.deepEqual(calls, [1, 2], 'the still-running second page owns the worker');
      assert.equal(workers[0].terminated, false);
      assert.equal(clock.nextDelay(), 1);
      clock.fireAt(deadline);
      const result = await pending;
      assert.equal(workers[0].terminated, true);
      assert.deepEqual(calls, documentExpires ? [1, 2] : [1, 2, 3]);
      assert.equal(workers.length, documentExpires ? 1 : 2, 'only a page timeout allows a fresh worker');
      assert.equal(clock.pending, 0);
      if (mode === 'streaming') {
        assert.equal(result.ocr.partial, documentExpires);
        assert.equal(result.ocr.partialReason, documentExpires ? 'budget' : null);
        assert.match(result.text, /\[page 1\]\nContrato/);
        assert.match(result.text, /\[página 2 — no legible: tiempo agotado\]/);
        assert.match(result.text, documentExpires
          ? /\[página 3 sin OCR: tiempo agotado\]/
          : /\[page 3\]\nContrato/);
      } else {
        assert.equal(result.ocr.budgetHit, documentExpires);
        assert.deepEqual(rendered, documentExpires ? [1, 2] : [1, 2, 3]);
        assert.equal(result.pages[0].reason, 'ok');
        assert.equal(result.pages[1].reason, 'timeout');
        assert.equal(result.pages[2].reason, documentExpires ? 'budget' : 'ok');
      }
    });
  }
}

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
  // Every worker (image, tiled, PDF pages, streaming, subset) comes from the
  // one bounded factory, which always passes the noise filter + tessdata
  // options; nothing calls tesseract.js' createWorker directly.
  assert.equal((src.match(/await createWorker\(/g) || []).length, 0, 'no direct createWorker call');
  assert.ok((src.match(/await this\.createOcrWorker\(/g) || []).length >= 5, 'all paths use createOcrWorker');
  assert.match(src, /const options = tesseractWorkerOptions\(language, \{/);
  assert.match(src, /createWorkerImpl\(language, undefined, options\)/);
});
