'use strict';

// ocr-engine × ocr-input × ocr-quality wiring (G6a):
//  - every image entry point gets normalised pages (HEIC/BMP/TIFF/EXIF/OSD)
//    and the vision rungs receive a provider-safe PNG/JPEG;
//  - multi-page images keep [page N] blocks and MARK unreadable/capped pages;
//  - Tesseract workers come only from createOcrWorker: local tessdata, a
//    bounded init, a single fallback to the download path, a cooldown;
//  - the quality gate counts every script, short math, and variant ranking
//    discounts implausible words;
//  - new preprocessing variants (CLAHE, Sauvola, 2× lanczos + unsharp).
// Tesseract, Ollama and the cloud are always fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const engine = require('../src/services/ocr-engine');
const realOcrInput = require('../src/services/ocr-input');

const { resetWorkerState, workerState, tesseractWorkerOptions, tessdataOptions, OcrWorkerInitError } = engine._internals;

// Restores run LIFO, so overriding the same key twice in one test unwinds
// to the true original (node:test runs `after` hooks in registration order).
const restoreStacks = new WeakMap();
function onRestore(t, fn) {
  let stack = restoreStacks.get(t);
  if (!stack) {
    stack = [];
    restoreStacks.set(t, stack);
    t.after(() => { while (stack.length) stack.pop()(); });
  }
  stack.push(fn);
}

function override(t, target, props) {
  for (const [key, value] of Object.entries(props)) {
    const own = Object.prototype.hasOwnProperty.call(target, key);
    const saved = target[key];
    target[key] = value;
    onRestore(t, () => {
      if (own) target[key] = saved;
      else delete target[key];
    });
  }
}

function withEnv(t, vars) {
  for (const [key, value] of Object.entries(vars)) {
    const saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    onRestore(t, () => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
  }
}

function quietWarnings(t) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  t.after(() => { console.warn = original; });
  return lines;
}

function fakeInput(overrides = {}) {
  return {
    ...realOcrInput,
    resolveLocalTessdata: () => null,
    tessdataCacheDir: () => '/tmp/fake-tess-cache',
    detectOrientation: async () => ({ ok: false, reason: 'osd_data_missing' }),
    measureBlur: async () => ({ ok: true, variance: 500, blurry: false }),
    ...overrides,
  };
}

function worker(recognize) {
  return {
    terminated: 0,
    async recognize(img) { return { data: await recognize(img) }; },
    async setParameters() {},
    async terminate() { this.terminated += 1; },
  };
}

async function png(width, height, value = 255) {
  return sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
}

const CLEAN = 'La factura fue emitida por la empresa en Lima el día de ayer y debe pagarse antes del viernes próximo.';

test.beforeEach(() => resetWorkerState());

// ── Workers and tessdata ──────────────────────────────────────────────────

test('worker options: local tessdata when every language is installed, otherwise a writable download cache', (t) => {
  const warnings = quietWarnings(t);
  const local = tesseractWorkerOptions('spa+eng', { inputModule: fakeInput({ resolveLocalTessdata: () => ({ dir: '/usr/share/tessdata', languages: ['spa', 'eng'] }) }) });
  assert.equal(local.langPath, '/usr/share/tessdata');
  assert.equal(local.gzip, false, 'apk tessdata is plain .traineddata');
  assert.equal(local.cacheMethod, 'none', 'no copy of local data into a cache');
  assert.equal(typeof local.errorHandler, 'function');

  const cdn = tesseractWorkerOptions('spa+que', { inputModule: fakeInput() });
  assert.equal(cdn.langPath, undefined);
  assert.equal(cdn.cachePath, '/tmp/fake-tess-cache');
  tesseractWorkerOptions('spa+que', { inputModule: fakeInput() });
  assert.equal(warnings.filter((l) => /no local tessdata/.test(l)).length, 1, 'one WARN per language');

  assert.deepEqual(Object.keys(tesseractWorkerOptions()), ['errorHandler'], 'no language: noise filter only (legacy shape)');
  assert.deepEqual(tessdataOptions('spa', { inputModule: fakeInput({ tessdataCacheDir: () => null }) }), {});
});

test('createOcrWorker: a local load that fails switches to the download path once, then works', async (t) => {
  const warnings = quietWarnings(t);
  const calls = [];
  override(t, engine, {
    ocrInput: fakeInput({ resolveLocalTessdata: () => ({ dir: '/usr/share/tessdata', languages: ['spa', 'eng'] }) }),
    createWorkerImpl: (lang, oem, options) => {
      calls.push({ lang, options });
      if (options.langPath) {
        // tesseract.js reports a loadLanguage failure through errorHandler and
        // leaves createWorker pending forever.
        setTimeout(() => options.errorHandler('Error: failed to read spa.traineddata'), 5);
        return new Promise(() => {});
      }
      return Promise.resolve(worker(async () => ({ text: 'ok', confidence: 90 })));
    },
  });
  const w = await engine.createOcrWorker('spa+eng');
  assert.equal(typeof w.recognize, 'function');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.langPath, '/usr/share/tessdata');
  assert.equal(calls[1].options.langPath, undefined);
  assert.equal(calls[1].options.cachePath, '/tmp/fake-tess-cache');
  assert.equal(workerState.localBroken, true);
  assert.equal(warnings.filter((l) => /local tessdata could not be loaded/.test(l)).length, 1);
  // From now on this process goes straight to the download path.
  await engine.createOcrWorker('spa+eng');
  assert.equal(calls[2].options.langPath, undefined);
});

test('createOcrWorker: a silent hang is bounded, cools down, and a late worker is terminated', async (t) => {
  quietWarnings(t);
  withEnv(t, { SIRAGPT_OCR_WORKER_INIT_TIMEOUT_MS: '1000', SIRAGPT_OCR_WORKER_RETRY_MS: '60000' });
  const late = worker(async () => ({ text: '', confidence: 0 }));
  let created = 0;
  override(t, engine, {
    ocrInput: fakeInput(),
    createWorkerImpl: () => {
      created += 1;
      return new Promise((resolve) => setTimeout(() => resolve(late), 1300));
    },
  });
  const t0 = Date.now();
  await assert.rejects(engine.createOcrWorker('spa+eng'), (err) => err instanceof OcrWorkerInitError && err.code === 'tesseract_init_timeout');
  assert.ok(Date.now() - t0 < 3000);
  await assert.rejects(engine.createOcrWorker('spa+eng'), (err) => err.code === 'tesseract_unavailable');
  assert.equal(created, 1, 'cooldown: no new worker while tesseract is known dead');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(late.terminated, 1, 'the worker that came up late was not leaked');
});

test('the error handler still swallows Tesseract noise after init', async (t) => {
  const warnings = quietWarnings(t);
  let handler = null;
  override(t, engine, {
    ocrInput: fakeInput(),
    createWorkerImpl: async (lang, oem, options) => { handler = options.errorHandler; return worker(async () => ({ text: '', confidence: 0 })); },
  });
  await engine.createOcrWorker('spa');
  handler('Image too small to scale!!');
  handler('Error: real worker failure');
  assert.equal(warnings.filter((l) => /tesseract worker/.test(l)).length, 1);
});

// ── Quality gate and ranking ──────────────────────────────────────────────

test('evaluateQuality accepts perfect non-Latin and math reads the old gate threw away', () => {
  const cyr = engine.evaluateQuality({ text: 'Договор аренды заключён на двенадцать месяцев', confidence: 95 });
  assert.equal(cyr.accepted, true);
  const cjk = engine.evaluateQuality({ text: '本合同自签字之日起生效', confidence: 95 });
  assert.equal(cjk.enoughText, true, '11 ideographs weigh 22');
  const arabic = engine.evaluateQuality({ text: 'هذا العقد ساري المفعول لمدة سنة واحدة', confidence: 95 });
  assert.equal(arabic.accepted, true);
  const math = engine.evaluateQuality({ text: '√2', confidence: 95 });
  assert.equal(math.legibleShort, true);
  assert.equal(engine.hasUsefulText('Привет'), true);
});

test('variant ranking: 300 junk glyphs at 40 % no longer beat 100 clean characters at 80 %', () => {
  const clean = engine.evaluateQuality({ text: CLEAN, confidence: 80 });
  const junk = engine.evaluateQuality({
    text: Array.from({ length: 60 }, (_, i) => ['rnmw', 'xqzpt', 'tHe', 'vvbnk', 'zzrt', 'pkkqw'][i % 6]).join(' '),
    confidence: 40,
  });
  assert.ok(junk.usefulChars > clean.usefulChars * 2);
  assert.ok(engine.scoreQuality(clean) > engine.scoreQuality(junk));
  assert.equal(junk.garbageLikely, true);
  assert.equal(clean.garbageLikely, false);
  // Short/numeric reads keep the old weight (nothing to judge).
  const short = engine.evaluateQuality({ text: 'RUC 20123456789', confidence: 90 });
  assert.equal(short.wordRatio, null);
});

// ── Variants ──────────────────────────────────────────────────────────────

test('variant order: CLAHE early for images, upscale early when blurry, PDFs keep their first four', () => {
  const names = (opts) => engine.createImageVariantFactories(Buffer.from('x'), opts).map((f) => f.name);
  assert.deepEqual(names({ maxSide: 3000 }).slice(0, 4), ['normalize_sharpen', 'clahe', 'contrast_sharpen', 'adaptive_threshold']);
  assert.deepEqual(names({ maxSide: 3000, blurry: true }).slice(0, 3), ['normalize_sharpen', 'upscale_unsharp', 'clahe']);
  assert.deepEqual(names({ maxSide: 2600, profile: 'pdf' }).slice(0, 4), ['normalize_sharpen', 'contrast_sharpen', 'threshold_165', 'adaptive_threshold']);
  assert.ok(names({}).includes('deskew_plus_3'));
  assert.ok(names({ deskew: false }).every((n) => !n.startsWith('deskew')));
});

test('real variants: Sauvola is binary, CLAHE and the 2× lanczos upscale render', async () => {
  const W = 400;
  const H = 160;
  const raw = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const light = 120 + Math.round((x / W) * 110);
      raw[y * W + x] = ((x % 40) < 8 && y > 60 && y < 100) ? light - 100 : light;
    }
  }
  const input = await sharp(raw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  const factories = await engine.createImageVariantsForInput(input, { maxSide: 800 });
  const byName = Object.fromEntries(factories.map((f) => [f.name, f]));
  const adaptive = await byName.adaptive_threshold.make();
  assert.equal((await sharp(adaptive).metadata()).channels, 1, 'single-channel PNG');
  const { data } = await sharp(adaptive).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data.every((v) => v === 0 || v === 255), 'binary output');
  assert.ok(data.some((v) => v === 0) && data.some((v) => v === 255), 'ink and paper both present');
  const clahe = await sharp(await byName.clahe.make()).metadata();
  assert.equal(clahe.width, 800);
  const up = await sharp(await byName.upscale_unsharp.make()).metadata();
  assert.equal(Math.max(up.width, up.height), 800, 'upscale target = max(maxSide, 2 × native) capped at 4000');
  const factories2 = engine.createImageVariantFactories(input, { maxSide: 600, nativeMaxSide: 400 });
  const up2 = await sharp(await factories2.find((f) => f.name === 'upscale_unsharp').make()).metadata();
  assert.equal(up2.width, 800, '2 × native when that beats maxSide');
});

// ── Normalisation wiring ──────────────────────────────────────────────────

test('extractFromImage: a HEIC page reaches the vision rung as JPEG, never as image/heic', async (t) => {
  quietWarnings(t);
  const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const seen = [];
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async () => ({
        ok: true,
        format: 'heic',
        totalPages: 1,
        truncatedPages: 0,
        warnings: ['heic_decoded_by_ffmpeg'],
        pages: [{ page: 1, buffer: jpeg, mime: 'image/jpeg', width: 900, height: 600, rotation: 0, source: 'heif-dec', format: 'heic' }],
      }),
    }),
    createWorkerImpl: async () => worker(async () => ({ text: '', confidence: 0 })),
    runVisionFallback: async (args) => {
      seen.push(args);
      return { text: 'Texto leído por visión', ocr: { status: 'vision_fallback', confidence: 95, provider: 'ollama:glm-ocr' } };
    },
  });
  const res = await engine.extractFromImage(Buffer.from('raw-heic-bytes'), { mimeType: 'image/heic', localBudgetMs: 2000 });
  assert.equal(res.ocr.status, 'vision_fallback');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mimeType, 'image/jpeg');
  assert.equal(seen[0].buffer, jpeg);
  assert.deepEqual(res.ocr.input, { format: 'heic', source: 'heif-dec', rotation: 0, pages: 1, warnings: ['heic_decoded_by_ffmpeg'] });
});

test('extractFromImage: a failed normalisation keeps the raw input (today’s behaviour) and says why', async (t) => {
  const raw = Buffer.from('raw-heic-bytes');
  let localInput = null;
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: async () => ({ ok: false, error: 'heic_decode_failed', format: 'heic', pages: [], warnings: [] }) }),
    runLocalImageOcr: async (input) => {
      localInput = input;
      return { quality: engine.evaluateQuality({ text: CLEAN, confidence: 92 }) };
    },
  });
  const res = await engine.extractFromImage(raw, { mimeType: 'image/heic', analyze: false });
  assert.equal(localInput, raw);
  assert.equal(res.ocr.status, 'local_ok');
  assert.deepEqual(res.ocr.input, { format: 'heic', error: 'heic_decode_failed' });
});

test('extractFromImage: a large normalised page is fitted for the vision APIs (≤3072 px)', async (t) => {
  quietWarnings(t);
  const big = await png(5000, 1200);
  const seen = [];
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async () => ({
        ok: true, format: 'png', totalPages: 1, truncatedPages: 0, warnings: [],
        pages: [{ page: 1, buffer: big, mime: 'image/png', width: 5000, height: 1200, rotation: 0, source: 'original', format: 'png' }],
      }),
    }),
    runLocalImageOcr: async () => ({ quality: engine.evaluateQuality({ text: '', confidence: 0 }) }),
    runVisionFallback: async (args) => { seen.push(args); return { text: '', ocr: { status: 'failed', reason: 'x' } }; },
  });
  await engine.extractFromImage(big, { analyze: false });
  const meta = await sharp(seen[0].buffer).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 3072);
  assert.equal(seen[0].mimeType, 'image/jpeg');
});

test('extractFromImage: normalize:false skips the stage; a plain PNG keeps the old result shape', async (t) => {
  quietWarnings(t);
  let normalizeCalls = 0;
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: async (...args) => { normalizeCalls += 1; return realOcrInput.normalizeImageInput(args[0], { ...args[1], osd: false }); } }),
    createWorkerImpl: async () => worker(async () => ({ text: CLEAN, confidence: 93 })),
  });
  const image = await png(1200, 400);
  const res = await engine.extractFromImage(image, { mimeType: 'image/png' });
  assert.equal(res.ocr.status, 'local_ok');
  assert.equal(res.ocr.input, undefined, 'nothing to report for a clean PNG');
  assert.equal(res.ocr.image.blurry, false);
  assert.equal(normalizeCalls, 1);
  await engine.extractFromImage(image, { mimeType: 'image/png', normalize: false });
  assert.equal(normalizeCalls, 1);
});

test('multi-page images: [page N] blocks, unreadable pages and the page cap are marked, never dropped', async (t) => {
  const pages = [1, 2, 3].map((n) => ({ page: n, buffer: Buffer.from(`p${n}`), mime: 'image/png', width: 100, height: 100, rotation: 0, source: `sharp:tiff#${n}`, format: 'tiff' }));
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async () => ({ ok: true, format: 'tiff', totalPages: 5, truncatedPages: 2, warnings: ['page_cap'], pages }),
    }),
    _extractFromSingleImage: async (buffer, options) => {
      const n = options.page.page;
      if (n === 1) return { text: 'Primera página legible', ocr: { status: 'local_ok', provider: 'tesseract', confidence: 90, usefulChars: 20, lineCount: 1 } };
      if (n === 2) return { text: '', ocr: { status: 'failed', reason: 'too_little_text', confidence: 10 } };
      return { text: 'Tercera página por visión', ocr: { status: 'vision_fallback', provider: 'ollama:glm-ocr', confidence: 95, usefulChars: 22, lineCount: 1 } };
    },
  });
  const res = await engine.extractFromImage('/fake/scan.tif', { mimeType: 'image/tiff' });
  assert.equal(res.text, [
    '[page 1]\nPrimera página legible',
    '[page 2]\n[página 2 — no legible: sin texto legible]',
    '[page 3]\nTercera página por visión',
    '[páginas 4–5 sin OCR: límite]',
  ].join('\n\n'));
  assert.equal(res.ocr.status, 'vision_fallback');
  assert.equal(res.ocr.provider, 'tesseract+ollama:glm-ocr');
  assert.equal(res.ocr.pages, 5);
  assert.equal(res.ocr.pagesRead, 3);
  assert.equal(res.ocr.pagesWithText, 2);
  assert.equal(res.ocr.usefulChars, 42, 'markers never count as text');
  assert.equal(res.ocr.partial, true);
  assert.equal(res.ocr.partialReason, 'page_cap');
  assert.equal(res.ocr.pageQuality[1].reason, 'too_little_text');
  assert.equal(res.ocr.input.format, 'tiff');
});

test('multi-page images: nothing legible → a clean failure (no marker-only text); budget and abort stop honestly', async (t) => {
  const pages = [1, 2, 3].map((n) => ({ page: n, buffer: Buffer.from(`p${n}`), mime: 'image/png', rotation: 0, source: 'sharp', format: 'tiff' }));
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: async () => ({ ok: true, format: 'tiff', totalPages: 3, truncatedPages: 0, warnings: [], pages }) }),
    _extractFromSingleImage: async () => ({ text: '', ocr: { status: 'failed', reason: 'too_little_text' } }),
  });
  const empty = await engine.extractFromImage('/fake/scan.tif');
  assert.equal(empty.text, '');
  assert.equal(empty.ocr.status, 'failed');
  assert.equal(empty.ocr.reason, 'no_page_text');

  withEnv(t, { SIRAGPT_OCR_MULTIPAGE_BUDGET_MS: '1000' });
  override(t, engine, {
    _extractFromSingleImage: async () => {
      await new Promise((r) => setTimeout(r, 1100));
      return { text: 'Lento pero legible', ocr: { status: 'local_ok', provider: 'tesseract', confidence: 90, usefulChars: 15, lineCount: 1 } };
    },
  });
  const slow = await engine.extractFromImage('/fake/scan.tif');
  assert.match(slow.text, /^\[page 1\]\nLento pero legible/);
  assert.match(slow.text, /\[páginas 2–3 sin OCR: tiempo agotado\]$/);
  assert.equal(slow.ocr.partialReason, 'budget');

  const controller = new AbortController();
  controller.abort();
  const aborted = await engine.extractFromImage('/fake/scan.tif', { signal: controller.signal });
  assert.equal(aborted.ocr.reason, 'aborted');
});

test('OSD fallback: when the upright guess reads worse, the pre-rotation page wins', async (t) => {
  const rotated = Buffer.from('rotated-page');
  const original = Buffer.from('original-page');
  override(t, engine, {
    ocrInput: fakeInput(),
    createImageVariantsForInput: async (input) => [1, 2, 3].map((i) => ({ name: `v${i}`, make: async () => Buffer.from(`${input.toString()}#${i}`) })),
    createWorkerImpl: async () => worker(async (img) => (
      img.toString().startsWith('original-page')
        ? { text: CLEAN, confidence: 92 }
        : { text: 'rn mw', confidence: 20 }
    )),
  });
  const res = await engine.runLocalImageOcr(rotated, { alternateInput: original, blur: null, localBudgetMs: 5000 });
  assert.equal(res.usedAlternate, true);
  assert.equal(res.quality.accepted, true);

  let passed = null;
  override(t, engine, {
    runLocalImageOcr: async (input, options) => { passed = options.alternateInput; return { quality: engine.evaluateQuality({ text: CLEAN, confidence: 92 }) }; },
  });
  await engine._extractFromSingleImage(rotated, {
    analyze: false,
    page: { page: 1, buffer: rotated, mime: 'image/png', preRotation: { buffer: original, mime: 'image/png' } },
  });
  assert.equal(passed, original);
});

test('weak PDF page: OSD says sideways → re-read upright, keep the better read; accepted pages skip OSD', async (t) => {
  let osdCalls = 0;
  override(t, engine, {
    ocrInput: fakeInput({
      detectOrientation: async () => { osdCalls += 1; return { ok: true, rotate: 90, confidence: 7 }; },
      // A weak page's OSD retry is only an alternate that must read better:
      // the hint level (2) is enough, not the rotation level (14).
      inputConfig: () => ({ osdMinConfidence: 14, osdHintConfidence: 2 }),
    }),
    recognizeBestVariant: async () => ({ quality: engine.evaluateQuality({ text: CLEAN, confidence: 91 }), variants: 2, variant: 'normalize_sharpen' }),
  });
  const page = await png(300, 500);
  const weak = { quality: engine.evaluateQuality({ text: 'rn', confidence: 12 }), variants: 4 };
  const out = await engine._retryOrientedPage({}, page, weak, engine.config);
  assert.equal(out.rotated, 90);
  assert.equal(out.quality.accepted, true);
  const meta = await sharp(out.orientedBuffer).metadata();
  assert.deepEqual([meta.width, meta.height], [500, 300]);

  const good = { quality: engine.evaluateQuality({ text: CLEAN, confidence: 95 }), variants: 1 };
  assert.equal(await engine._retryOrientedPage({}, page, good, engine.config), good);
  assert.equal(osdCalls, 1);
});

// ── Orientation alternates, abort, unreadable pages (verifier fixes) ──────

async function isLandscape(img) {
  const meta = await sharp(img).metadata();
  return meta.width > meta.height;
}

function countingWorkers(recognize) {
  const created = [];
  const impl = async () => {
    const w = worker(recognize);
    created.push(w);
    return w;
  };
  impl.created = created;
  return impl;
}

function singlePage(page) {
  return async () => ({ ok: true, format: 'png', totalPages: 1, truncatedPages: 0, warnings: page.warnings || [], unreadablePages: [], pages: [page] });
}

test('low-confidence OSD hint + a first pass that runs out of time: the hint is still tried, vision gets the UPRIGHT original', async (t) => {
  quietWarnings(t);
  const original = await png(600, 300);
  const seen = [];
  const recognizedPortrait = [];
  const workers = countingWorkers(async (img) => {
    if (await isLandscape(img)) return new Promise(() => {}); // upright sweep hangs
    recognizedPortrait.push(img);
    return { text: '', confidence: 0 };
  });
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: singlePage({
        page: 1, buffer: original, mime: 'image/png', width: 600, height: 300, rotation: 0,
        source: 'original', format: 'png', osd: { rotate: 90, confidence: 6 }, orientationHint: { rotate: 90, confidence: 6 },
      }),
    }),
    createWorkerImpl: workers,
    runVisionFallback: async (args) => {
      seen.push(args);
      return { text: 'Texto leído por visión', ocr: { status: 'vision_fallback', confidence: 95, provider: 'ollama:glm-ocr' } };
    },
  });
  const t0 = Date.now();
  const res = await engine.extractFromImage(original, { mimeType: 'image/png', analyze: false, localBudgetMs: 1000 });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(workers.created.length, 2, 'the timed-out worker is replaced for the alternate');
  assert.ok(workers.created[0].terminated >= 1);
  assert.ok(recognizedPortrait.length >= 1, 'the hinted orientation was tried within the reserved budget');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].buffer, original, 'vision reads the upright original');
  assert.equal(seen[0].mimeType, 'image/png');
  assert.equal(res.ocr.status, 'vision_fallback');
  assert.equal(res.ocr.input, undefined, 'no rotation claimed');
});

test('low-confidence OSD hint that reads better: Tesseract keeps it and ocr.input reports the rotation used', async (t) => {
  quietWarnings(t);
  const original = await png(600, 300);
  let visionCalls = 0;
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: singlePage({
        page: 1, buffer: original, mime: 'image/png', width: 600, height: 300, rotation: 0,
        source: 'original', format: 'png', osd: { rotate: 270, confidence: 9 }, orientationHint: { rotate: 270, confidence: 9 },
      }),
    }),
    createWorkerImpl: async () => worker(async (img) => (
      (await isLandscape(img)) ? { text: 'rn mw', confidence: 20 } : { text: CLEAN, confidence: 92 }
    )),
    runVisionFallback: async () => { visionCalls += 1; return { text: '', ocr: { status: 'failed' } }; },
  });
  const res = await engine.extractFromImage(original, { mimeType: 'image/png', analyze: false, localBudgetMs: 5000 });
  assert.equal(res.ocr.status, 'local_ok');
  assert.equal(res.text, CLEAN);
  assert.equal(visionCalls, 0);
  assert.equal(res.ocr.input.rotation, 270);
  assert.ok(res.ocr.input.warnings.includes('osd_hint_applied'));
});

test('confident OSD rotation that reads worse: the pre-rotation page wins even after a timed-out first pass, and vision gets it', async (t) => {
  quietWarnings(t);
  const original = await png(600, 300);
  const rotated = await png(300, 600);
  const page = {
    page: 1, buffer: rotated, mime: 'image/png', width: 300, height: 600, rotation: 90, source: 'sharp', format: 'png',
    osd: { rotate: 90, confidence: 15 }, preRotation: { buffer: original, mime: 'image/png', width: 600, height: 300 },
    warnings: ['osd_rotated_90'],
  };
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: singlePage(page) }),
    createWorkerImpl: async () => worker(async (img) => (
      (await isLandscape(img)) ? { text: CLEAN, confidence: 92 } : new Promise(() => {})
    )),
  });
  const accepted = await engine.extractFromImage(original, { analyze: false, localBudgetMs: 1000 });
  assert.equal(accepted.ocr.status, 'local_ok');
  assert.equal(accepted.text, CLEAN);
  assert.equal(accepted.ocr.input.rotation, 0, 'reports the orientation that was used');
  assert.ok(accepted.ocr.input.warnings.includes('osd_rotation_reverted'));

  // Both reads weak, the original a little better: the vision rung gets it.
  const seen = [];
  override(t, engine, {
    createWorkerImpl: async () => worker(async (img) => (
      (await isLandscape(img)) ? { text: 'Texto parcial', confidence: 40 } : { text: 'rn', confidence: 10 }
    )),
    runVisionFallback: async (args) => { seen.push(args); return { text: 'Lectura de visión completa', ocr: { status: 'vision_fallback', confidence: 95, provider: 'x' } }; },
  });
  const viaVision = await engine.extractFromImage(original, { analyze: false, localBudgetMs: 5000 });
  assert.equal(viaVision.ocr.status, 'vision_fallback');
  assert.equal(seen[0].buffer, original);
  assert.equal(viaVision.ocr.input.rotation, 0);
});

test('abort on the single-image path: no ladder, no vision, a typed `aborted` failure', async (t) => {
  quietWarnings(t);
  let recognizeCalls = 0;
  let visionCalls = 0;
  let normalizeCalls = 0;
  const image = await png(600, 300);
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async (...args) => { normalizeCalls += 1; return realOcrInput.normalizeImageInput(args[0], { ...args[1], osd: false }); },
    }),
    createWorkerImpl: async () => worker(async () => { recognizeCalls += 1; return { text: '', confidence: 0 }; }),
    runVisionFallback: async () => { visionCalls += 1; return { text: 'x', ocr: { status: 'vision_fallback' } }; },
  });
  const controller = new AbortController();
  controller.abort();
  const res = await engine.extractFromImage(image, { signal: controller.signal });
  assert.equal(res.ocr.status, 'failed');
  assert.equal(res.ocr.reason, 'aborted');
  assert.equal(recognizeCalls, 0);
  assert.equal(visionCalls, 0);
  assert.equal(normalizeCalls, 0);

  // Normalisation itself reporting the abort is not a "failed normalisation":
  // the raw input does not go down the ladder.
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: async () => ({ ok: false, error: 'aborted', pages: [], warnings: [] }) }),
  });
  const res2 = await engine.extractFromImage(image, {});
  assert.equal(res2.ocr.reason, 'aborted');
  assert.equal(recognizeCalls, 0);
  assert.equal(visionCalls, 0);

  // Cancelled while Tesseract is busy: the worker is stopped at once.
  const hung = worker(() => new Promise(() => {}));
  override(t, engine, {
    ocrInput: fakeInput({ normalizeImageInput: singlePage({ page: 1, buffer: image, mime: 'image/png', width: 600, height: 300, rotation: 0, source: 'original', format: 'png' }) }),
    createWorkerImpl: async () => hung,
  });
  const live = new AbortController();
  setTimeout(() => live.abort(), 80);
  const t0 = Date.now();
  const res3 = await engine.extractFromImage(image, { signal: live.signal, analyze: false, localBudgetMs: 20_000 });
  assert.ok(Date.now() - t0 < 3000, 'returns promptly, not at the 20 s budget');
  assert.equal(res3.ocr.reason, 'aborted');
  assert.ok(hung.terminated >= 1, 'the busy worker was terminated');
  assert.equal(visionCalls, 0);
});

test('multi-page images: a page the decoder could not open is marked under its own number', async (t) => {
  const mk = (n) => ({ page: n, buffer: Buffer.from(`p${n}`), mime: 'image/png', rotation: 0, source: `sharp:tiff#${n}`, format: 'tiff' });
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async () => ({
        ok: true, format: 'tiff', totalPages: 5, truncatedPages: 2, warnings: ['page_decode_failed', 'page_cap'],
        pages: [mk(1), mk(3)], unreadablePages: [{ page: 2, error: 'decode_failed' }],
      }),
    }),
    _extractFromSingleImage: async (buffer, options) => ({
      text: `Texto de la página ${options.page.page}`,
      ocr: { status: 'local_ok', provider: 'tesseract', confidence: 90, usefulChars: 18, lineCount: 1 },
    }),
  });
  const res = await engine.extractFromImage('/fake/fax.tif', { mimeType: 'image/tiff' });
  assert.equal(res.text, [
    '[page 1]\nTexto de la página 1',
    '[page 2]\n[página 2 — no legible: no se pudo abrir la página]',
    '[page 3]\nTexto de la página 3',
    '[páginas 4–5 sin OCR: límite]',
  ].join('\n\n'));
  assert.deepEqual(res.ocr.pageQuality.map((p) => [p.page, p.reason]), [[1, 'ok'], [2, 'decode_failed'], [3, 'ok']]);
  assert.equal(res.ocr.pagesWithText, 2);

  // One readable page plus one unreadable still takes the multi-page path.
  override(t, engine, {
    ocrInput: fakeInput({
      normalizeImageInput: async () => ({
        ok: true, format: 'tiff', totalPages: 2, truncatedPages: 0, warnings: ['page_decode_failed'],
        pages: [mk(2)], unreadablePages: [{ page: 1, error: 'decode_failed' }],
      }),
    }),
  });
  const two = await engine.extractFromImage('/fake/fax.tif');
  assert.equal(two.text, '[page 1]\n[página 1 — no legible: no se pudo abrir la página]\n\n[page 2]\nTexto de la página 2');
  assert.equal(two.ocr.partial, false);
});
