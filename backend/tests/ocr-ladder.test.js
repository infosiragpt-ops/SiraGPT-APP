'use strict';

// OCR ladder (C8 · G6b): GLM-OCR quality gate, multi-runtime cloud vision
// ladder with bands, ensemble reconciliation, calibrated confidence, the
// fileProcessor vision-fallback confidence fix and chat photo transcription.
// All offline: Ollama fetch, cloud clients and sharp inputs are fakes or
// tiny in-memory images.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ensemble = require('../src/services/ocr-ensemble');
const ollamaOcr = require('../src/services/ollama-ocr');
const engine = require('../src/services/ocr-engine');
const keyHealth = require('../src/utils/provider-key-health');
const imageVision = require('../src/services/image-attachment-vision');

const VISION_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY',
  'OCR_VISION_MODEL', 'VISION_MODEL', 'GEMINI_VISION_MODEL', 'XAI_VISION_MODEL', 'OCR_ENSEMBLE_VERIFY_GLM', 'OCR_VISION_LADDER_MAX',
  'OCR_ENSEMBLE_MAX_CLOUD_CALLS', 'SIRAGPT_OCR_PDF_VISION_CLOUD'];

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of new Set([...VISION_KEYS, ...Object.keys(vars)])) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Replace engine instance props for one test. */
function override(t, target, props) {
  const saved = {};
  for (const [key, value] of Object.entries(props)) {
    saved[key] = Object.prototype.hasOwnProperty.call(target, key) ? { own: true, value: target[key] } : { own: false };
    target[key] = value;
  }
  t.after(() => {
    for (const [key, entry] of Object.entries(saved)) {
      if (entry.own) target[key] = entry.value;
      else delete target[key];
    }
  });
}

function quiet(t) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => { console.log = log; console.warn = warn; });
}

function fakeGlm({ text = '', ok = true, reason = null, loop = null, truncated = false, available = true, onRecognize } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    config: () => ({ model: 'glm-ocr' }),
    ensureAvailable: async () => (available ? { available: true } : { available: false, reason: reason || 'model_not_found' }),
    recognize: async (args) => {
      calls.push(args);
      if (onRecognize) return onRecognize(args);
      if (!ok) return { ok: false, reason: reason || 'timeout' };
      return { ok: true, text, provider: 'ollama:glm-ocr', durationMs: 50, task: args.task || 'text', loop, truncated, doneReason: truncated ? 'length' : 'stop' };
    },
  };
}

/** Cloud client factory: responder(candidate, payload, n) → content | Error | { content, finish }. */
function cloudFactory(responder) {
  const calls = [];
  const factory = (candidate) => ({
    chat: {
      completions: {
        create: async (payload, opts) => {
          calls.push({ provider: candidate.provider, model: candidate.model, payload, opts });
          const out = await responder(candidate, payload, calls.length);
          if (out instanceof Error) throw out;
          const content = typeof out === 'string' ? out : out.content;
          const finish = typeof out === 'string' ? 'stop' : (out.finish || 'stop');
          return { choices: [{ message: { content }, finish_reason: finish }] };
        },
      },
    },
  });
  return { factory, calls };
}

function httpError(status, message) {
  const err = new Error(message || `${status} status code`);
  err.status = status;
  return err;
}

const TESS_CLEAN = 'El contrato de alquiler se firma el 03/10/2026 entre las partes por un monto de 1.250 soles mensuales.';

function localQuality(text, confidence = 70) {
  return engine.evaluateQuality({ text, confidence });
}

async function png(width, height, background = 'white') {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

// ── ocr-ensemble (pure) ───────────────────────────────────────────────────

test('reconcile keeps agreed text, marks a contested amount instead of guessing it', () => {
  const rec = ensemble.reconcile([
    { engine: 'gemini:x', kind: 'vlm', text: 'Señor Huamán Quispe, el monto es S/ 1.250,00 del 03/10/2026.' },
    { engine: 'ollama:glm-ocr', kind: 'glm', text: 'Señor Huaman Quispe, el monto es S/ 1.280,00 del 03/10/2026.' },
  ]);
  assert.equal(rec.text, 'Señor Huamán Quispe, el monto es S/ [¿1.250,00?] del 03/10/2026.');
  assert.equal(rec.contestedNumbers, 1);
  assert.equal(rec.voters, 2);
  assert.ok(rec.agreement > 0.8);
  assert.equal(rec.conflict, false);
});

test('reconcile: a third engine confirming a word keeps it; Tesseract only contests numbers unless it agrees well overall', () => {
  const three = ensemble.reconcile([
    { engine: 'gemini:x', kind: 'vlm', text: 'El profesor Ccori dicta Cálculo II los lunes.' },
    { engine: 'ollama:glm-ocr', kind: 'glm', text: 'El profesor Kori dicta Calculo II los lunes.' },
    { engine: 'tesseract', kind: 'tesseract', text: 'El profesor Ccori dicta Calculo II los lunes.' },
  ]);
  assert.equal(three.text, 'El profesor Ccori dicta Cálculo II los lunes.');
  // A noisy Tesseract read (agreement < 0.75) may not mark words…
  const noisy = ensemble.reconcile([
    { engine: 'gemini:x', kind: 'vlm', text: 'Resumen de la reunión del lunes con el equipo de ventas y el gerente regional 2026' },
    { engine: 'tesseract', kind: 'tesseract', text: 'Resumen de la reuni0n del lunes con el equlpo de ventas y el gerentc regionaI 2025' },
  ]);
  assert.doesNotMatch(noisy.text, /\[¿(reunión|equipo|gerente|regional)\?\]/);
  // …but a number it read differently is still contested.
  assert.match(noisy.text, /\[¿2026\?\]/);
});

test('reconcile: reads of different things do not vote; a VLM-vs-VLM split is a conflict', () => {
  const rec = ensemble.reconcile([
    { engine: 'gemini:x', kind: 'vlm', text: 'Factura electrónica número F001-2345 emitida a Comercial Andina SAC' },
    { engine: 'ollama:glm-ocr', kind: 'glm', text: 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod' },
  ]);
  assert.equal(rec.text, 'Factura electrónica número F001-2345 emitida a Comercial Andina SAC');
  assert.equal(rec.voters, 1);
  assert.equal(rec.conflict, true);
});

test('diffKeys is bounded: beyond maxD it gives up instead of burning CPU', () => {
  const a = Array.from({ length: 400 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 400 }, (_, i) => `b${i}`);
  assert.equal(ensemble.diffKeys(a, b, { maxD: 100 }), null);
  const ops = ensemble.diffKeys(['x', 'y', 'z'], ['x', 'q', 'z']);
  assert.deepEqual(ops.map((o) => o.op), ['equal', 'delete', 'insert', 'equal']);
});

test('calibrated confidence: agreement drives it, problems lower it, never a fixed 95', () => {
  assert.equal(ensemble.calibrateConfidence({ agreement: 1, voters: 2 }), 97);
  assert.ok(ensemble.calibrateConfidence({ agreement: 0.5, voters: 2 }) < 85);
  assert.equal(ensemble.calibrateConfidence({ kind: 'glm' }), 66);
  assert.ok(ensemble.calibrateConfidence({ kind: 'vlm', loop: true, truncated: true }) < 60);
  assert.ok(ensemble.calibrateConfidence({ agreement: 0.95, voters: 3, illegibleRatio: 0.3 }) < 85);
  assert.equal(ensemble.confidenceLevel(90), 'alta');
  assert.equal(ensemble.confidenceLevel(70), 'media');
  assert.equal(ensemble.confidenceLevel(40), 'baja');
  assert.equal(ensemble.describeEngines('ollama:glm-ocr+gemini:gemini-3.5-flash+tesseract'), 'GLM-OCR (local) + Gemini + Tesseract (local)');
});

test('bands: full-width strips, cuts snapped to blank rows, seams de-duplicated without merging different lines', () => {
  const bands = ensemble.planBands(3000, 4000, { maxBands: 4 });
  assert.equal(bands.length, 3);
  assert.ok(bands.every((b) => b.left === 0 && b.width === 3000));
  assert.equal(bands[0].top, 0);
  assert.equal(bands[2].top + bands[2].height, 4000);
  assert.deepEqual(ensemble.planBands(1400, 900), [], 'a landscape page is one band');
  // Ink everywhere except rows 250 and 560: the cuts land there.
  const ink = new Uint32Array(800).fill(50);
  ink[250] = 0;
  ink[560] = 0;
  const planned = ensemble.planBands(300, 800, { maxBands: 3 });
  assert.equal(planned.length, 3);
  const snapped = ensemble.snapCutsToWhitespace(planned, ink);
  assert.equal(snapped.length, 3);
  const firstBottom = snapped[0].top + snapped[0].height;
  assert.ok(firstBottom >= 250 && firstBottom <= 250 + 12, `first cut near row 250 (got ${firstBottom})`);
  assert.ok(snapped[2].top <= 560 && snapped[2].top >= 560 - 12, `last cut near row 560 (got ${snapped[2].top})`);
  assert.equal(snapped[2].top + snapped[2].height, 800);
  const merged = ensemble.mergeBandTexts(['línea 1\nlínea 2\nTotal a pagar: 100', 'Total a pagar: 100\nlínea 4\nlínea 5', '[ilegible]\nlínea 5\nlínea 6']);
  assert.equal(merged, 'línea 1\nlínea 2\nTotal a pagar: 100\nlínea 4\nlínea 5\nlínea 6');
});

test('GLM task follows the image class: table rows → table, short math → formula, else text', () => {
  assert.equal(ensemble.chooseGlmTask({ text: '| Producto | Cant | Precio |\n|---|---|---|\n| Pan | 2 | 1.50 |\n| Leche | 1 | 3.20 |' }), 'table');
  assert.equal(ensemble.chooseGlmTask({ text: 'Mes Ventas Costos\nEnero 1.200 800\nFebrero 1.350 820\nMarzo 1.410 900\nAbril 1.500 950\nMayo 1.620 990' }), 'table');
  assert.equal(ensemble.chooseGlmTask({ text: 'Bodega Don Pepe\nAv. Grau 123\nPan 2 1.50\nTotal 1.50' }), 'text', 'a receipt keeps the text prompt');
  assert.equal(ensemble.chooseGlmTask({ text: 'x² + 2x = √9' }), 'formula');
  assert.equal(ensemble.chooseGlmTask({ text: TESS_CLEAN }), 'text');
  assert.equal(ensemble.chooseGlmTask({}), 'text');
});

// ── ollama-ocr client: streaming, loops, truncation, cooldown, upscale ────

function ndjsonBody(lines, { delayMs = 0, onCancel } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          if (i >= lines.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(`${JSON.stringify(lines[i++])}\n`) };
        },
        async cancel() { if (onCancel) onCancel(); },
        releaseLock() {},
      };
    },
  };
}

function glmClient({ env = {}, fetchImpl } = {}) {
  return ollamaOcr.createOllamaOcrClient({
    env: { NODE_ENV: 'test', SIRAGPT_OLLAMA_OCR: '1', ...env },
    fetchImpl,
    sharpImpl: () => ({ rotate() { return this; }, resize() { return this; }, png() { return this; }, async toBuffer() { return Buffer.from('p'); } }),
    logger: { log() {}, warn() {} },
  });
}

test('GLM stream: a repetition loop is cut as soon as it shows; the text before it is kept and flagged', async () => {
  const lines = [{ message: { content: 'Factura 001\nCliente: Ana Torres\n' } }];
  for (let i = 0; i < 400; i += 1) lines.push({ message: { content: 'Repetido sin fin en esta línea\n' } });
  lines.push({ done: true, done_reason: 'stop' });
  let cancelled = false;
  const client = glmClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: ndjsonBody(lines, { onCancel: () => { cancelled = true; } }),
    }),
  });
  const res = await client.recognize({ buffer: Buffer.from('img') });
  assert.equal(res.ok, true);
  assert.ok(res.loop && res.loop.repeats >= 4);
  assert.equal(res.truncated, true);
  assert.equal(res.doneReason, 'loop');
  assert.equal(res.text, 'Factura 001\nCliente: Ana Torres\nRepetido sin fin en esta línea');
  assert.equal(cancelled, true, 'the request is cut, not read to the end');
});

test('GLM: done_reason length is truncation; a timeout keeps the partial text; two timeouts park the rung', async () => {
  const lengthClient = glmClient({
    fetchImpl: async () => ({ ok: true, status: 200, body: ndjsonBody([{ message: { content: 'Texto largo cortado' } }, { done: true, done_reason: 'length', eval_count: 8192, eval_duration: 4e9 }]) }),
  });
  const cut = await lengthClient.recognize({ buffer: Buffer.from('x') });
  assert.equal(cut.truncated, true);
  assert.equal(cut.doneReason, 'length');
  assert.equal(cut.tokensPerSec, 2048);

  const slowFetch = async (_url, init) => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (!sent) { sent = true; return { done: false, value: new TextEncoder().encode(`${JSON.stringify({ message: { content: 'Primera parte legible' } })}\n`) }; }
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
            });
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  });
  const client = glmClient({ env: { OLLAMA_OCR_TIMEOUT_MS: '1000', OLLAMA_OCR_TIMEOUT_STREAK: '2' }, fetchImpl: slowFetch });
  const partial = await client.recognize({ buffer: Buffer.from('x') });
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.equal(partial.truncated, true);
  assert.equal(partial.text, 'Primera parte legible');
  await client.recognize({ buffer: Buffer.from('x') });
  const state = await client.ensureAvailable();
  assert.equal(state.available, false);
  assert.equal(state.reason, 'timeout_cooldown');
});

test('GLM: queue waits and ladder-shortened reads never park a slow but healthy Ollama', async () => {
  // Ollama answers every read in 1.1 s; the configured inference timeout is
  // 1.8 s. Three concurrent reads queue on the concurrency-1 gate (the third
  // waits 2.2 s), and two reads get a ladder deadline shorter than the
  // answer time. None of that is an Ollama timeout.
  const ANSWER_MS = 1100;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, async json() { return { models: [{ name: 'glm-ocr:latest' }] }; } };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ANSWER_MS);
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        }, { once: true });
      }
    });
    return { ok: true, status: 200, body: ndjsonBody([{ message: { content: 'Texto leído por GLM' } }, { done: true, done_reason: 'stop' }]) };
  };
  // Default queue budget (= the inference timeout): the third read may give
  // up waiting (queue_timeout), which is never counted against Ollama.
  const strict = glmClient({ env: { OLLAMA_OCR_TIMEOUT_MS: '1800', OLLAMA_OCR_TIMEOUT_STREAK: '2' }, fetchImpl });
  const queued = await Promise.all([1, 2, 3].map(() => strict.recognize({ buffer: Buffer.from('x') })));
  assert.deepEqual(queued.map((r) => (r.ok ? 'ok' : r.reason)), ['ok', 'ok', 'queue_timeout']);
  assert.equal(strict.describe().timeoutStreak, 0);

  const client = glmClient({ env: { OLLAMA_OCR_TIMEOUT_MS: '1800', OLLAMA_OCR_TIMEOUT_STREAK: '2', OLLAMA_OCR_QUEUE_TIMEOUT_MS: '5000' }, fetchImpl });
  const concurrent = await Promise.all([1, 2, 3].map(() => client.recognize({ buffer: Buffer.from('x') })));
  assert.deepEqual(concurrent.map((r) => r.ok), [true, true, true], 'the inference timer starts after the gate');
  for (let i = 0; i < 2; i += 1) {
    const shortened = await client.recognize({ buffer: Buffer.from('x'), timeoutMs: 1000 });
    assert.equal(shortened.ok, false);
    assert.equal(shortened.reason, 'timeout');
  }
  assert.equal(client.describe().timeoutStreak, 0, 'shortened reads are not counted');
  const state = await client.ensureAvailable();
  assert.equal(state.available, true);
  assert.notEqual(state.reason, 'timeout_cooldown');
});

test('GLM: one request at a time on the shared Ollama (FIFO gate), formula task prompt, sampling knobs opt-in', async () => {
  let active = 0;
  let maxActive = 0;
  const bodies = [];
  const client = glmClient({
    env: { OLLAMA_OCR_REPEAT_PENALTY: '1.1' },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { ok: true, status: 200, body: ndjsonBody([{ message: { content: 'ok' } }, { done: true, done_reason: 'stop' }]) };
    },
  });
  await Promise.all([client.recognize({ buffer: Buffer.from('a'), task: 'formula' }), client.recognize({ buffer: Buffer.from('b') })]);
  assert.equal(maxActive, 1);
  assert.equal(bodies[0].messages[0].content, 'Formula Recognition:');
  assert.equal(bodies[0].options.repeat_penalty, 1.1);
  assert.equal(bodies[1].options.repeat_last_n, undefined);
});

test('GLM input: small crops are upscaled (≤ 4×, never past maxSide); big photos are downscaled', async () => {
  assert.equal(ollamaOcr.planGlmScale(610, 94, { maxSide: 2048, minShortSide: 1024 }), 2048 / 610);
  assert.equal(ollamaOcr.planGlmScale(400, 300, { maxSide: 2048, minShortSide: 1024 }), 1024 / 300);
  assert.equal(ollamaOcr.planGlmScale(200, 150, { maxSide: 2048, minShortSide: 1024 }), 4);
  assert.equal(ollamaOcr.planGlmScale(4000, 3000, { maxSide: 2048 }), 2048 / 4000);
  assert.equal(ollamaOcr.planGlmScale(1600, 1200, { maxSide: 2048, minShortSide: 1024 }), 1);
  const small = await ollamaOcr.prepareImage(await png(300, 80), { maxSide: 2048, minShortSide: 1024 });
  const meta = await sharp(small).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 320);
});

// ── engine ladder ─────────────────────────────────────────────────────────

test('GLM read confirmed by Tesseract ends the ladder: no cloud call, calibrated confidence', async (t) => {
  quiet(t);
  const glm = fakeGlm({ text: TESS_CLEAN.replace('1.250', '1.250') });
  const cloud = cloudFactory(() => 'no debería llamarse');
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g-key' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality(TESS_CLEAN, 72) });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(res.ocr.provider, 'ollama:glm-ocr');
    assert.equal(cloud.calls.length, 0);
    assert.equal(res.ocr.gate.verified, true);
    assert.deepEqual(res.ocr.engines, ['ollama:glm-ocr', 'tesseract']);
    assert.ok(res.ocr.confidence >= 85 && res.ocr.confidence < 98);
    assert.equal(res.ocr.confidenceLevel, 'alta');
  });
});

test('opt-in: an unverified GLM read gets a cloud second opinion; disagreeing words are marked, not guessed', async (t) => {
  quiet(t);
  const glm = fakeGlm({ text: 'Recibí de Ana Torres la suma de 350 soles por la clase de matemática del viernes.' });
  const cloud = cloudFactory((candidate) => {
    assert.equal(candidate.provider, 'Gemini');
    return 'TIPO: fotografía\nRecibí de Ana Torres la suma de 380 soles por la clase de matemática del viernes.';
  });
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g-key', OCR_ENSEMBLE_VERIFY_GLM: '1' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality('', 0) });
    assert.equal(cloud.calls.length, 1);
    assert.equal(res.ocr.provider, 'gemini:gemini-3.5-flash');
    assert.deepEqual(res.ocr.engines, ['gemini:gemini-3.5-flash', 'ollama:glm-ocr']);
    assert.match(res.text, /la suma de \[¿380\?\] soles/);
    assert.equal(res.ocr.ensemble.contestedNumbers, 1);
    assert.equal(res.ocr.visionType, 'fotografía');
    assert.ok(res.ocr.confidence < 95);
    // The anti-hallucination contract reached the model, at temperature 0.
    const payload = cloud.calls[0].payload;
    assert.match(payload.messages[0].content, /\[ilegible\]/);
    assert.match(payload.messages[0].content, /Never infer, guess, autocomplete/);
    assert.equal(payload.temperature, 0);
  });
});

test('a looping GLM read is kept only up to the loop and escalated; the final text says it is incomplete when nothing better exists', async (t) => {
  quiet(t);
  const glm = fakeGlm({ text: 'Acta de la reunión del consejo directivo\nPunto uno aprobado por unanimidad', loop: { kind: 'line', repeats: 9, position: 'end' }, truncated: true });
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloudFactory(() => 'x').factory });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.deepEqual(res.ocr.gate.issues, ['loop']);
    assert.equal(res.ocr.truncated, true);
    assert.ok(res.text.endsWith(engine._internals.TRUNCATED_MARK));
    assert.equal(res.ocr.confidenceLevel, 'baja');
  });
});

test('cloud ladder: a dead key is memoised and skipped, the next runtime answers; reasoning OpenAI ids get no temperature', async (t) => {
  quiet(t);
  keyHealth.clear();
  t.after(() => keyHealth.clear());
  const cloud = cloudFactory((candidate) => {
    if (candidate.provider === 'Gemini') return httpError(401, 'API key not valid');
    if (candidate.provider === 'xAI') return httpError(503, 'unavailable');
    return 'TIPO: documento escaneado\nTIPO: DNI\nNombre: Rosa Quispe';
  });
  override(t, engine, { ollamaOcr: null, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g-dead', XAI_API_KEY: 'x-key', OPENAI_API_KEY: 'o-key', VISION_MODEL: 'gpt-5.6-sol', OCR_VISION_LADDER_MAX: '5' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(res.ocr.provider, 'openai:gpt-5.6-sol');
    // Only the FIRST line is the model's type verdict; the document's own
    // «TIPO: DNI» line stays in the transcription.
    assert.match(res.text, /^TIPO: DNI\nNombre: Rosa Quispe/);
    const openaiCall = cloud.calls.find((c) => c.provider === 'OpenAI');
    assert.equal(openaiCall.payload.temperature, undefined);
    assert.equal(openaiCall.payload.max_tokens, undefined);
    assert.equal(openaiCall.payload.max_completion_tokens, 8192);
    assert.equal(keyHealth.isRejected('Gemini', 'g-dead'), true);
    const before = cloud.calls.length;
    await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.ok(!cloud.calls.slice(before).some((c) => c.provider === 'Gemini'), 'the dead key is not called again');
  });
});

test('opt-in: GLM and the cloud disagree → a second cloud runtime votes and the majority read becomes the primary', async (t) => {
  quiet(t);
  const truth = 'Inscripción al curso de Derecho Civil, turno mañana, aula 204, docente María Salazar.';
  const glm = fakeGlm({ text: truth });
  const cloud = cloudFactory((candidate) => (candidate.provider === 'Gemini'
    ? 'Recibo de luz del mes de agosto, consumo 120 kWh, total a pagar 85 soles.'
    : truth.replace('204', '204')));
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', OCR_ENSEMBLE_VERIFY_GLM: '1', OCR_ENSEMBLE_MAX_CLOUD_CALLS: '2' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.deepEqual(cloud.calls.map((c) => c.provider), ['Gemini', 'xAI']);
    assert.equal(res.text, truth);
    assert.notEqual(res.ocr.provider, 'gemini:gemini-3.5-flash');
    assert.equal(res.ocr.ensemble.voters >= 2, true);
  });
});

test('large dense page: the cloud reads it by full-width bands at native resolution and the seams are merged', async (t) => {
  quiet(t);
  const page = await png(1200, 3000);
  const seen = [];
  const cloud = cloudFactory((_c, payload) => {
    const prompt = payload.messages[1].content[0].text;
    const band = Number((/Franja (\d+) de/.exec(prompt) || [])[1]);
    seen.push(band);
    if (band === 1) return 'TIPO: texto denso\nlínea 1\nlínea 2\nlínea 3';
    if (band === 2) return 'línea 3\nlínea 4\nlínea 5';
    if (band === 3) return 'línea 5\nlínea 6';
    return '[ilegible]\nlínea 7';
  });
  override(t, engine, { ollamaOcr: null, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({
      buffer: page,
      sourceBuffer: page,
      localQuality: { ...localQuality('', 0), lineCount: 60, usefulChars: 2500 },
    });
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(res.text, 'línea 1\nlínea 2\nlínea 3\nlínea 4\nlínea 5\nlínea 6\nlínea 7');
    assert.equal(res.ocr.visionLadder.tiled, 4);
  });
});

test('a whole-page read cut at the token limit is retried by bands', async (t) => {
  quiet(t);
  const page = await png(1000, 1600);
  let calls = 0;
  const cloud = cloudFactory((_c, payload) => {
    calls += 1;
    const prompt = payload.messages[1].content[0].text;
    if (!/Franja/.test(prompt)) return { content: 'TIPO: documento escaneado\nprimera mitad cortada', finish: 'length' };
    return /Franja 1/.test(prompt) ? 'parte de arriba completa' : 'parte de abajo completa';
  });
  override(t, engine, { ollamaOcr: null, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({ buffer: page, sourceBuffer: page });
    assert.ok(calls >= 3);
    assert.match(res.text, /parte de arriba completa[\s\S]*parte de abajo completa/);
    assert.equal(res.ocr.truncated, false);
  });
});

test('no GLM and no cloud runtime: a typed failure that says why, nothing attempted', async (t) => {
  quiet(t);
  override(t, engine, { ollamaOcr: fakeGlm({ available: false, reason: 'model_pulling' }) });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'failed');
    assert.equal(res.ocr.reason, 'vision_api_unavailable');
    assert.equal(res.ocr.ollamaOcr, 'model_pulling');
  });
});

test('a cancelled read never calls a vision rung', async (t) => {
  quiet(t);
  const glm = fakeGlm({ text: 'x' });
  const cloud = cloudFactory(() => 'x');
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloud.factory });
  const controller = new AbortController();
  controller.abort();
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), signal: controller.signal });
    assert.equal(res.ocr.reason, 'aborted');
    assert.equal(glm.calls.length, 0);
    assert.equal(cloud.calls.length, 0);
  });
});

test('GLM task by image class reaches Ollama (table read → Table Recognition)', async (t) => {
  quiet(t);
  const glm = fakeGlm({ text: 'Producto | Cant\nPan | 2' });
  override(t, engine, { ollamaOcr: glm, createVisionRuntimeClient: cloudFactory(() => 'Producto | Cant\nPan | 2').factory });
  await withEnv({}, async () => {
    await engine.runOllamaOcrFallback({ buffer: Buffer.from('img'), localQuality: localQuality('Mes Ventas Costos\nEnero 1.200 800\nFebrero 1.350 820\nMarzo 1.410 900\nAbril 1.500 950\nMayo 1.620 990', 50) });
    assert.equal(glm.calls[0].task, 'table');
  });
});

// ── fileProcessor: confidence units + no duplicate ladder ─────────────────

test('fileProcessor vision fallback: 0–100 confidence is normalised and the duplicate ladder is skipped', async () => {
  const fileProcessor = require('../src/services/fileProcessor');
  await withEnv({ GEMINI_API_KEY: 'g', SIRAGPT_VISION_FALLBACK_ENABLED: '1', SIRAGPT_VISION_FALLBACK_MIN_CONFIDENCE: undefined }, async () => {
    const long = 'a'.repeat(300);
    assert.equal(fileProcessor._shouldApplyVisionFallback({ text: long, ocr: { confidence: 45, status: 'local_ok' } }), true, '45 % is weak');
    assert.equal(fileProcessor._shouldApplyVisionFallback({ text: long, ocr: { confidence: 92, status: 'local_ok' } }), false);
    assert.equal(fileProcessor._shouldApplyVisionFallback({ text: long, ocr: { confidence: 0.3 } }), true, 'legacy 0–1 still works');
    assert.equal(fileProcessor._shouldApplyVisionFallback({ text: 'x', ocr: { confidence: 40, status: 'local_ok', visionLadder: { attempted: true } } }), false);
    assert.equal(fileProcessor._shouldApplyVisionFallback({ text: 'x', ocr: { confidence: 70, status: 'vision_fallback' } }), false);
  });
  assert.equal(fileProcessor._preferVisionText({ text: 'Texto local bueno y claro con bastante contenido legible para leer', ocr: { confidence: 92 } }, 'corto'), false);
  assert.equal(fileProcessor._preferVisionText({ text: 'qx zv', ocr: { confidence: 40 } }, 'Texto leído por visión'), true);
  assert.equal(fileProcessor._preferVisionText({ text: 'El texto local es correcto y legible para todos', ocr: { confidence: 90 } }, '#$%& !!@@ ##$$ %%^^ &&** (( ))__ ++== ~~``'), false);
});

test('processImage header carries the engines and the calibrated confidence of the read', async (t) => {
  const fileProcessor = require('../src/services/fileProcessor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-ladder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'foto.png');
  fs.writeFileSync(file, await png(40, 40));
  override(t, engine, {
    extractFromImage: async () => ({
      text: 'Hola mundo desde la foto',
      ocr: {
        status: 'vision_fallback',
        confidence: 72,
        confidenceLevel: 'media',
        provider: 'gemini:gemini-3.5-flash',
        engines: ['gemini:gemini-3.5-flash', 'ollama:glm-ocr'],
        image: { width: 40, height: 40, type: 'photo', typeLabelEs: 'fotografía' },
      },
    }),
  });
  const out = await fileProcessor.processImage(file, { detailed: true, mimeType: 'image/png' });
  assert.match(out.extractedText, /^Imagen — fotografía \(40×40 px\) — 24 caracteres extraídos · OCR: Gemini \+ GLM-OCR \(local\) · confianza media \(72 %\)\n---\nHola mundo/);
  const prov = imageVision.parseOcrProvenance(out.extractedText);
  assert.equal(prov.level, 'media');
  assert.equal(prov.confidence, 72);
  assert.equal(prov.body, 'Hola mundo desde la foto');
});

// ── chat photo transcription ──────────────────────────────────────────────

test('transcription requests are recognised; other image tasks are not', () => {
  for (const yes of ['transcribe esta foto', 'qué dice esta imagen borrosa', 'pásalo a texto', 'copia el texto', 'Transcripción literal', 'lee lo que dice', 'What does it say?', 'extract the text', 'trascribir la hoja']) {
    assert.equal(imageVision.isTranscriptionRequest(yes), true, yes);
  }
  for (const no of ['resuelve el ejercicio', 'explica la gráfica', 'traduce al inglés', 'pasame la tarea']) {
    assert.equal(imageVision.isTranscriptionRequest(no), false, no);
  }
});

test('a transcription combined with another operation is a TASK, not a copy-only transcription', () => {
  // Each of these asks for something the verbatim protocol forbids
  // («do NOT translate, correct, summarize…»): they must get the task protocol.
  for (const combined of [
    'traduce lo que dice esta imagen al inglés',
    'resume lo que dice la foto',
    'lee la imagen y resuelve el ejercicio',
    'explica qué dice este gráfico',
    'corrige la ortografía de lo que dice',
    '¿qué dice este problema? resuélvelo',
    'read the text and translate it',
    'transcríbelo y tradúcelo',
    'qué significa lo que dice',
    'haz lo que dice la imagen',
  ]) {
    assert.equal(imageVision.isTranscriptionRequest(combined), false, combined);
    assert.doesNotMatch(imageVision.buildImageTaskText(combined, {}), /IMAGE TRANSCRIPTION PROTOCOL/, combined);
  }
  // A negated operation is part of the copy contract; nouns are not verbs.
  for (const pure of [
    'transcribe la foto sin traducir',
    'transcríbelo, no lo corrijas',
    "transcribe the text, don't translate it",
    'dime lo que dice la imagen',
    'transcribe la explicación de la pizarra',
    'transcribe las respuestas del examen',
  ]) {
    assert.equal(imageVision.isTranscriptionRequest(pure), true, pure);
  }
});

test('OCR text is labelled with engine and confidence; unknown provenance is never presented as exact', () => {
  const low = imageVision.parseOcrProvenance('Imagen — fotografía — 9 caracteres extraídos · OCR: Tesseract (local) · confianza baja (41 %)\n---\nQx lrem 3');
  assert.equal(low.level, 'baja');
  assert.match(imageVision.describeOcrProvenance(low), /confianza baja \(41 %\).*verifícalo contra la imagen/);
  assert.match(imageVision.describeOcrProvenance(imageVision.parseOcrProvenance('texto suelto')), /confianza desconocida/);
});

test('photo transcription: verbatim protocol with [ilegible], labelled OCR cross-check, temperature 0', async () => {
  const text = imageVision.buildImageTaskText('transcribe esta foto', {
    ocrHint: 'Imagen — fotografía — 10 caracteres extraídos · OCR: GLM-OCR (local) · confianza media (70 %)\n---\nHola mundo',
  });
  assert.match(text, /IMAGE TRANSCRIPTION PROTOCOL/);
  assert.match(text, /\[ilegible\]/);
  assert.match(text, /\[¿palabra\?\]/);
  assert.match(text, /OCR adjunto \(texto leído por OCR — motor: GLM-OCR \(local\), confianza media \(70 %\)/);
  assert.doesNotMatch(text, /Never claim the image has no readable text/);
  const general = imageVision.buildImageTaskText('resuelve', {});
  assert.match(general, /mark that part \[ilegible\] instead of guessing/);

  const requests = [];
  const getClient = () => ({ chat: { completions: { create: async (req) => { requests.push(req); return { choices: [{ message: { content: 'ok' } }] }; } } } });
  const prepareImage = async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  const files = [{ path: '/tmp/x.png', mimeType: 'image/png', name: 'x.png' }];
  await imageVision.answerImageTurnWithVision({ prompt: 'transcribe esta foto', imageFiles: files, provider: 'Gemini', model: 'gemini-3.5-flash', prepareImage, getClient, env: { GEMINI_API_KEY: 'g' } });
  await imageVision.answerImageTurnWithVision({ prompt: 'resuelve el ejercicio', imageFiles: files, provider: 'Gemini', model: 'gemini-3.5-flash', prepareImage, getClient, env: { GEMINI_API_KEY: 'g' } });
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[1].temperature, 0.2);
});

test('chat route wiring: OCR text labels, transcription protocol and temperature 0 (source contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(src, /imageAttachmentVision\.describeOcrProvenance\(ocrProvenance\)/);
  assert.match(src, /imageAttachmentVision\.isTranscriptionRequest\(prompt\)/);
  assert.match(src, /buildImageTranscriptionProtocol\(\)/);
  assert.match(src, /imageTranscriptionTurn[\s\S]{0,600}actualTemperature = 0;/);
});

test('paid second opinions are opt-in: by default a clean GLM read is the free final rung; a tiny one is never checked', async (t) => {
  quiet(t);
  assert.equal(engine.config.ensembleVerifyGlm, false, 'OCR_ENSEMBLE_VERIFY_GLM defaults off');
  assert.equal(engine.config.ensembleMaxCloudCalls, 1, 'a second cloud runtime is opt-in');
  assert.equal(engine.config.pdfVisionCloudEnabled, false, 'cloud on full scanned PDFs is opt-in');
  const cloud = cloudFactory(() => 'no debería llamarse');
  override(t, engine, { ollamaOcr: fakeGlm({ text: 'Café Andino' }), createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g', OCR_ENSEMBLE_VERIFY_GLM: '1' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(cloud.calls.length, 0, 'a tiny read is not worth a paid call');
  });
  override(t, engine, { ollamaOcr: fakeGlm({ text: 'Reglamento interno de la biblioteca central: los préstamos duran siete días hábiles.' }) });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(cloud.calls.length, 0, 'default: no paid verification');
  });
  await withEnv({ GEMINI_API_KEY: 'g', OCR_ENSEMBLE_VERIFY_GLM: '1' }, async () => {
    await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(cloud.calls.length, 1, 'opted in: a substantial unverified read is checked');
  });
});

test('a short vision read («√2», «Total: 45») is usable text: no Tesseract confidence threshold on vision reads', async (t) => {
  quiet(t);
  override(t, engine, { ollamaOcr: fakeGlm({ text: '√2' }), createVisionRuntimeClient: cloudFactory(() => 'x').factory });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(res.text, '√2');
  });
});

test('single-image path: the vision ladder gets the provider-safe copy AND the native page, plus the image class', async (t) => {
  quiet(t);
  const page = await png(5000, 1200);
  const seen = [];
  override(t, engine, {
    ocrInput: {
      ...require('../src/services/ocr-input'),
      normalizeImageInput: async () => ({
        ok: true, format: 'png', totalPages: 1, truncatedPages: 0, warnings: [],
        pages: [{ page: 1, buffer: page, mime: 'image/png', width: 5000, height: 1200, rotation: 0, source: 'original', format: 'png' }],
      }),
    },
    runLocalImageOcr: async () => ({ quality: engine.evaluateQuality({ text: '', confidence: 0 }) }),
    // No real Tesseract in unit tests (the tiled pass would start a worker).
    runTiledImageOcr: async () => null,
    runVisionFallback: async (args) => { seen.push(args); return { text: 'Texto', ocr: { status: 'vision_fallback', provider: 'x', confidence: 70, confidenceLevel: 'media' } }; },
  });
  await engine.extractFromImage(page, {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourceBuffer, page, 'native resolution for band reads');
  assert.ok(seen[0].buffer.length < page.length || seen[0].buffer !== page);
  assert.equal(typeof seen[0].imageType, 'string');
});

test('a «confident» Tesseract read made of implausible words still goes to the vision ladder', async (t) => {
  quiet(t);
  const garbage = 'xq zvrr ttk qq wpl zz xxr kkq vvb zqx prr wwk tth qqr';
  let visionCalls = 0;
  override(t, engine, {
    runLocalImageOcr: async () => ({ quality: engine.evaluateQuality({ text: garbage, confidence: 91 }) }),
    runTiledImageOcr: async () => null,
    runVisionFallback: async () => { visionCalls += 1; return { text: 'Lectura real de la imagen por visión', ocr: { status: 'vision_fallback', provider: 'x', confidence: 74, confidenceLevel: 'media' } }; },
  });
  const res = await engine.extractFromImage(await png(800, 600), { normalize: false });
  assert.equal(visionCalls, 1);
  assert.equal(res.text, 'Lectura real de la imagen por visión');
  assert.equal(engine.shouldUseVisionFallback({ accepted: true, garbageLikely: true }, { mode: 'hybrid' }), true);
  assert.equal(engine.shouldUseVisionFallback({ accepted: true, garbageLikely: false }, { mode: 'hybrid' }), false);
});

// ── the gate decides (vision output never replaces a usable local read on its own) ──

test('a garbage GLM read with no cloud never replaces a usable Tesseract read: the local text wins with its warning', async (t) => {
  quiet(t);
  const garbage = 'xq zvrr ttk qq wpl zz xxr kkq vvb zqx prr wwk tth qqr';
  override(t, engine, {
    ollamaOcr: fakeGlm({ text: garbage }),
    runLocalImageOcr: async () => ({ quality: engine.evaluateQuality({ text: TESS_CLEAN, confidence: 70 }) }),
    runTiledImageOcr: async () => null,
  });
  await withEnv({}, async () => {
    const direct = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality(TESS_CLEAN, 70) });
    assert.equal(direct.ocr.status, 'failed');
    assert.equal(direct.ocr.reason, 'vision_read_gated');
    assert.ok(direct.ocr.gate.issues.includes('garbage'));
    assert.equal(direct.text, '');

    const res = await engine.extractFromImage(await png(400, 300), { normalize: false });
    assert.equal(res.ocr.status, 'local_ok');
    assert.equal(res.text, TESS_CLEAN);
    assert.equal(res.ocr.visionReason, 'vision_read_gated');
    assert.equal(res.ocr.warning, 'vision_fallback_unavailable_or_weaker');
    assert.notEqual(res.ocr.confidenceLevel, 'alta');
  });
});

test('a garbage-looking cloud read loses to a usable Tesseract read; a GLM read that contradicts it alone loses too', async (t) => {
  quiet(t);
  const cloud = cloudFactory(() => 'TIPO: fotografía\nxq zvrr ttk qq wpl zz xxr kkq vvb zqx prr wwk tth qqr');
  override(t, engine, { ollamaOcr: null, createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality(TESS_CLEAN, 72) });
    assert.equal(res.ocr.status, 'failed');
    assert.equal(res.ocr.reason, 'vision_read_gated');
  });
  // A fluent read about something else entirely (a hallucination).
  override(t, engine, { ollamaOcr: fakeGlm({ text: 'Recibo de luz del mes de agosto, consumo 120 kWh, total a pagar 85 soles en la agencia.' }) });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality(TESS_CLEAN, 72) });
    assert.equal(res.ocr.reason, 'vision_read_gated');
    assert.ok(res.ocr.gate.issues.includes('tesseract_disagrees'));
  });
});

test('a fuller GLM read that CONTAINS the partial Tesseract read is not a contradiction; no Tesseract read means no gate', async (t) => {
  quiet(t);
  const partial = 'El contrato de alquiler se firma entre las partes';
  const fuller = `${TESS_CLEAN} La garantía equivale a dos meses de renta y se devuelve al finalizar el contrato sin daños en el inmueble. El arrendatario asume los servicios de luz, agua e internet durante toda la vigencia.`;
  override(t, engine, { ollamaOcr: fakeGlm({ text: fuller }) });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality(partial, 60) });
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.match(res.text, /La garantía equivale/);
  });
  override(t, engine, { ollamaOcr: fakeGlm({ text: 'xq zvrr ttk qq wpl zz xxr kkq vvb zqx prr wwk tth qqr' }) });
  await withEnv({}, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), localQuality: localQuality('', 0) });
    // Nothing better exists: the read is kept, honestly rated low.
    assert.equal(res.ocr.status, 'vision_fallback');
    assert.equal(res.ocr.confidenceLevel, 'baja');
  });
});

test('the OCR_EMPTY sentinel is recognised as models really write it (Markdown, punctuation, a note)', async (t) => {
  quiet(t);
  const { isOcrEmptySentinel } = engine._internals;
  for (const yes of ['OCR_EMPTY', '**OCR_EMPTY**', 'OCR_EMPTY.', 'OCR_EMPTY (sin texto)', '`OCR_EMPTY`', '> OCR_EMPTY']) {
    assert.equal(isOcrEmptySentinel(yes), true, yes);
  }
  for (const no of ['Factura OCR_EMPTY 001', 'OCR_EMPTY\nTotal: 45', 'Total: 45']) {
    assert.equal(isOcrEmptySentinel(no), false, no);
  }
  const cloud = cloudFactory(() => 'TIPO: otro\n**OCR_EMPTY**');
  override(t, engine, { ollamaOcr: fakeGlm({ text: 'OCR_EMPTY.' }), createVisionRuntimeClient: cloud.factory });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const res = await engine.runVisionFallback({ buffer: Buffer.from('img') });
    assert.equal(res.ocr.status, 'failed');
    assert.equal(res.text, '');
    assert.equal(res.ocr.reason, 'vision_fallback_empty');
  });
});

test('single attachment on a text-only turn: the uploaded OCR context carries the provenance label', () => {
  const lowImage = {
    name: 'pizarra.jpg',
    mimeType: 'image/jpeg',
    extractedText: 'Imagen — fotografía — 9 caracteres extraídos · OCR: Tesseract (local) · confianza baja (41 %)\n---\nQx lrem 3',
  };
  const context = 'Archivo adjunto: pizarra.jpg\nQx lrem 3';
  const labelled = imageVision.labelUploadedOcrContext(context, lowImage, { isImage: true, imageAttached: false });
  assert.match(labelled, /^\[Contenido de «pizarra\.jpg»: texto leído por OCR — motor: Tesseract \(local\), confianza baja \(41 %\); puede tener errores: verifícalo contra la imagen y no lo des por exacto\]\n/);
  assert.ok(labelled.endsWith(context));
  // An image without a provenance header is still never presented as exact.
  assert.match(imageVision.labelUploadedOcrContext(context, { name: 'x.png', extractedText: 'texto' }, { isImage: true }), /confianza desconocida/);
  // Plain documents are untouched.
  const doc = { name: 'informe.docx', extractedText: 'Informe anual de la empresa' };
  assert.equal(imageVision.labelUploadedOcrContext('Contenido del informe', doc, { isImage: false }), 'Contenido del informe');
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(src, /fileContext = uploadedFileContextForTurn\s*\?\s*imageAttachmentVision\.labelUploadedOcrContext\(uploadedFileContextForTurn, singleFile/);
});
