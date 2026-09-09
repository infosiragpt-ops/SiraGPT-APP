'use strict';

const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

// Keep the real serialized privacy boundary, but do not mix Pino's direct
// stdout writes with node:test's binary child-process result protocol.
const consoleRecords = [];
for (const level of ['log', 'warn', 'error']) {
  mock.method(console, level, (...args) => consoleRecords.push({ level, args }));
}
const { symbols: pinoSymbols } = require('pino');
const { logger } = require('../src/middleware/logger');
const originalSink = logger[pinoSymbols.streamSym];
const logRecords = [];
logger[pinoSymbols.streamSym] = { write(line) { logRecords.push(JSON.parse(String(line))); return true; } };
after(() => { logger[pinoSymbols.streamSym] = originalSink; });

const acceptance = require('../src/services/ai/acceptance-spend-guard');
let currentGuard = acceptance.createAcceptanceSpendGuard();
// The real service and SSE module resolve these functions at import time;
// delegate only the scope to a private fixture, never to env or a live key.
for (const method of ['isActive', 'denyUnbudgetedOperation']) {
  mock.method(acceptance, method, (...args) => currentGuard[method](...args));
}
const service = require('../src/services/ai-service');
const { generateStreamFailure, publicGenerateErrorMessage, isProviderClientError } = require('../src/services/ai/generate-sse-close');
const lifecycle = require('../src/services/ai/acceptance-quota-lifecycle');
const { getBreaker } = require('../src/services/circuit-breaker');
const OpenAI = require('openai');
const axios = require('axios');

const IDENTITY = { userId: 'stream-quota-user', chatId: 'stream-quota-chat' };
const BUDGET_MESSAGE = 'La prueba no puede continuar con el presupuesto acreditado. Revisa la campaña de pruebas.';
const MODEL = 'muse-spark-1.3-contributor';

function setup(t, maxTotalMicros = 5_000_000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-stream-quota-'));
  t.after(() => { currentGuard = acceptance.createAcceptanceSpendGuard(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ledgerPath = path.join(directory, 'ledger.json');
  const policyFile = path.join(directory, 'policy.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, campaignId: 'stream-quota', maxTotalMicros,
    reservationMicros: 1_000_000, usedMicros: 0, reservations: [] }), { mode: 0o600 });
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, campaignId: 'stream-quota', ...IDENTITY,
    expiresAt: '2030-01-01T00:00:00Z', ledgerPath, maxTotalMicros, reservationMicros: 1_000_000,
    pricing: { verified: true, inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 200_000,
      inputTokenCeiling: 1_048_576, outputTokenCeiling: 16_384 } }), { mode: 0o600 });
  currentGuard = acceptance.createAcceptanceSpendGuard({ policyFile });
  return { guard: currentGuard, read: () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) };
}

function sdkQuota(guard) {
  let quota;
  guard.withAcceptanceScope(IDENTITY, () => {
    try { guard.denyUnbudgetedOperation(); } catch (error) { quota = error; }
  });
  assert.ok(quota);
  return new OpenAI.APIConnectionError({ message: 'PRIVATE_SDK_QUOTA Bearer SYNTHETIC_TOKEN', cause: quota });
}

function response() {
  return { chunks: [], writableEnded: false, destroyed: false,
    write(frame) { this.chunks.push(String(frame)); return true; },
    end() { this.writableEnded = true; },
  };
}

function turn(res, client, extra = {}) {
  return { provider: 'Meta', model: MODEL, res, client,
    messages: [{ role: 'user', content: 'Explica un juego de ajedrez sintético con pasos concretos.' }],
    userPrompt: 'Explica un juego de ajedrez sintético con pasos concretos.', qualityGuard: false,
    thinkingLevel: 'high', ...extra };
}

const sse = (res) => res.chunks.join('');
const doneCount = (res) => (sse(res).match(/data: \[DONE\]/g) || []).length;
const frames = (res) => res.chunks.flatMap((chunk) => chunk.split('\n\n')).filter((chunk) => chunk.startsWith('data: {'))
  .map((chunk) => JSON.parse(chunk.slice(6)));

test('SDK-wrapped acceptance quota uses fixed Spanish E_QUOTA without leaking SDK or campaign data', (t) => {
  const { guard } = setup(t);
  const wrapped = sdkQuota(guard);
  assert.deepEqual(generateStreamFailure(wrapped), { code: 'E_QUOTA', message: BUDGET_MESSAGE });
  assert.equal(publicGenerateErrorMessage(wrapped), BUDGET_MESSAGE);
  assert.equal(isProviderClientError(wrapped), true);
  assert.doesNotMatch(JSON.stringify(generateStreamFailure(wrapped)), /PRIVATE_|Bearer|stream-quota|muse-spark/);
  assert.equal(generateStreamFailure(new Error('E_QUOTA without a trusted cause')).code, 'E_PROVIDER');
});

test('SDK-wrapped quota is terminal before retry or fallback, with one DONE', async (t) => {
  const { guard } = setup(t);
  const wrapped = sdkQuota(guard);
  const previousFallbacks = process.env.FALLBACK_MODELS;
  process.env.FALLBACK_MODELS = 'gpt-4o-mini';
  t.after(() => { if (previousFallbacks === undefined) delete process.env.FALLBACK_MODELS; else process.env.FALLBACK_MODELS = previousFallbacks; });
  getBreaker(`Meta:${MODEL}`).reset();
  getBreaker('OpenAI:gpt-4o-mini').reset();
  let primaryCalls = 0;
  let fallbackClients = 0;
  const client = { chat: { completions: { create: async () => { primaryCalls += 1; throw wrapped; } } } };
  t.mock.method(service, 'getClient', () => { fallbackClients += 1; return client; });
  const res = response();
  const beforeLogs = logRecords.length;
  const result = await guard.withAcceptanceScope(IDENTITY, () => service.generateStream(turn(res, client)));
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackClients, 0);
  assert.equal(result, BUDGET_MESSAGE);
  assert.equal(doneCount(res), 1);
  assert.equal(res.writableEnded, true);
  assert.equal(frames(res).filter((frame) => frame.code === 'E_QUOTA').length, 1);
  assert.doesNotMatch(sse(res), /PRIVATE_|Bearer|stream-quota|temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(logRecords.slice(beforeLogs)), /PRIVATE_|Bearer|stream-quota|ajedrez|muse-spark/);
});

test('private quota failures do not open the shared provider breaker for ordinary users', async (t) => {
  const { guard } = setup(t);
  const breaker = getBreaker(`Meta:${MODEL}`);
  breaker.reset();
  const wrapped = sdkQuota(guard);
  let calls = 0;
  const client = { chat: { completions: { create: async () => { calls += 1; throw wrapped; } } } };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await guard.withAcceptanceScope(IDENTITY, () => service.generateStream(turn(response(), client)));
  }
  assert.equal(calls, 6);
  assert.equal(breaker.state, 'CLOSED');
  assert.equal(breaker.failureCount, 0);
});

test('corrective-pass quota preserves partial text and defers DONE until caller persistence', async (t) => {
  const { guard, read } = setup(t, 1_000_000);
  getBreaker(`Meta:${MODEL}`).reset();
  let physicalCalls = 0;
  let sdkCalls = 0;
  const sdkOptions = [];
  const send = guard.guardedFetch(async () => {
    physicalCalls += 1;
    return (async function* () { yield { choices: [{ delta: { content: 'Borrador breve.' } }] }; })();
  });
  const client = { chat: { completions: { create: async (payload, options) => {
    sdkCalls += 1;
    sdkOptions.push(options);
    try { return await send(acceptance.ENDPOINT, { method: 'POST', body: JSON.stringify(payload), signal: options.signal }); }
    catch (cause) { throw new OpenAI.APIConnectionError({ message: 'PRIVATE_CORRECTIVE_QUOTA Bearer SYNTHETIC_TOKEN', cause }); }
  } } } };
  t.mock.method(service, 'getClient', () => client);
  const beforeConsole = consoleRecords.length;
  const res = response();
  const result = await guard.withAcceptanceScope(IDENTITY, () => service.generateStream(turn(res, client, {
    qualityGuard: true, skipDoneSentinel: true,
  })));
  assert.equal(sdkCalls, 2, 'one primary attempt and one denied corrective attempt');
  assert.equal(physicalCalls, 1, 'the corrective attempt cannot leave the process');
  assert.equal(read().usedMicros, 1_000_000);
  assert.equal(result, `Borrador breve.\n\n${BUDGET_MESSAGE}`);
  assert.ok(sdkOptions.every((options) => options.maxRetries === 0), 'each scoped SDK operation must disable hidden retries');
  assert.equal(doneCount(res), 0, 'the persistence owner must receive the returned partial first');
  assert.equal(res.writableEnded, false);
  assert.equal(frames(res).filter((frame) => frame.code === 'E_QUOTA').length, 0, 'terminal error waits for persistence too');
  assert.equal(frames(res).filter((frame) => frame.replace).length, 0);
  let persisted;
  await lifecycle.persistAcceptanceFailure({ res, persist: async (content) => {
    persisted = content;
    return { assistantMessage: { id: 'synthetic-row', content, metadata: lifecycle.acceptanceFailureMetadata() } };
  } });
  await lifecycle.finalizeAcceptanceFailure({ res });
  assert.equal(persisted, result);
  assert.equal(frames(res).filter((frame) => frame.code === 'E_QUOTA' && frame.recovered === false).length, 1);
  assert.equal(doneCount(res), 1);
  assert.doesNotMatch(JSON.stringify(consoleRecords.slice(beforeConsole)), /PRIVATE_CORRECTIVE|Bearer/);
});

test('quota after visible partial text emits one terminal frame and one standalone DONE', async (t) => {
  const { guard } = setup(t);
  getBreaker(`Meta:${MODEL}`).reset();
  let calls = 0;
  const wrapped = sdkQuota(guard);
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return (async function* () { yield { choices: [{ delta: { content: 'Texto parcial de prueba.' } }] }; throw wrapped; })();
  } } } };
  const res = response();
  const result = await guard.withAcceptanceScope(IDENTITY, () => service.generateStream(turn(res, client)));
  assert.equal(calls, 1);
  assert.equal(result, `Texto parcial de prueba.\n\n${BUDGET_MESSAGE}`);
  assert.equal(doneCount(res), 1);
  assert.equal(frames(res).filter((frame) => frame.code === 'E_QUOTA').length, 1);
});

test('unsupported image, upload and code-interpreter operations deny before client, file or HTTP I/O', async (t) => {
  const { guard } = setup(t);
  const beforeLogs = consoleRecords.length;
  let clientCalls = 0;
  let fileCalls = 0;
  let httpCalls = 0;
  t.mock.method(service, 'getClient', () => { clientCalls += 1; throw new Error('unexpected client'); });
  t.mock.method(fs, 'readFileSync', () => { fileCalls += 1; throw new Error('unexpected read'); });
  t.mock.method(fs, 'createReadStream', () => { fileCalls += 1; throw new Error('unexpected stream'); });
  t.mock.method(axios, 'post', async () => { httpCalls += 1; throw new Error('unexpected post'); });
  t.mock.method(axios, 'get', async () => { httpCalls += 1; throw new Error('unexpected get'); });
  for (const run of [
    () => service.generateImageFromImage('/synthetic.png', 'PRIVATE_IMAGE_PROMPT', 'Gemini'),
    () => service.generateImageFromImage('/synthetic.png', 'PRIVATE_IMAGE_PROMPT', 'OpenAI'),
    () => service.generateImage('PRIVATE_IMAGE_PROMPT'),
    () => service.uploadFileToContainer('/synthetic.txt', 'private-container'),
    () => service.generateChartWithCodeInterpreter([{ role: 'user', content: 'PRIVATE_CHART_PROMPT' }], 'private-file'),
  ]) {
    await assert.rejects(guard.withAcceptanceScope(IDENTITY, run), (error) => {
      assert.equal(acceptance.isAcceptanceSpendError(error), true);
      assert.equal(error.code, 'E_QUOTA');
      return true;
    });
  }
  assert.deepEqual({ clientCalls, fileCalls, httpCalls }, { clientCalls: 0, fileCalls: 0, httpCalls: 0 });
  assert.doesNotMatch(JSON.stringify(consoleRecords.slice(beforeLogs)), /PRIVATE_|private-container|private-file/);
});

test('ordinary users retain image generation, upload, code-interpreter and corrective failure behavior', async (t) => {
  setup(t);
  let imageCalls = 0;
  let responseCalls = 0;
  const client = {
    images: { generate: async () => { imageCalls += 1; return { data: [{ b64_json: 'synthetic-image' }] }; } },
    responses: { create: async () => { responseCalls += 1; return { output: [] }; } },
    chat: { completions: { create: async (_payload, options) => {
      assert.equal(Object.hasOwn(options, 'maxRetries'), false);
      throw new Error('synthetic ordinary provider failure');
    } } },
  };
  t.mock.method(service, 'getClient', () => client);
  t.mock.method(fs, 'createReadStream', () => new PassThrough());
  let uploadCalls = 0;
  t.mock.method(axios, 'post', async () => { uploadCalls += 1; return { data: { id: 'synthetic-file' } }; });
  assert.equal(await service.generateImage('Synthetic ordinary prompt.'), 'synthetic-image');
  assert.deepEqual(await service.uploadFileToContainer('/synthetic.txt', 'synthetic-container'), { id: 'synthetic-file' });
  assert.deepEqual(await service.generateChartWithCodeInterpreter([{ role: 'user', content: 'Synthetic chart.' }]), {
    imageUrl: null, pythonCode: null, response: [],
  });
  assert.equal(await service._runCorrectivePass({ provider: 'Meta', model: MODEL,
    baseMessages: [{ role: 'user', content: 'Synthetic prompt.' }], userPrompt: 'Synthetic prompt.', language: 'es' }), '');
  assert.deepEqual({ imageCalls, responseCalls, uploadCalls }, { imageCalls: 1, responseCalls: 1, uploadCalls: 1 });
});
