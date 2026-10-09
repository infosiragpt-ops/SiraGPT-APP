'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { quoteMediaCost } = require('../src/services/media/pricing');
const { downloadToFile, readLimitedResponse } = require('../src/services/media/transfer');
const { submitFalQueueOnce } = require('../src/services/media/fal-submit-once');
const { createVideoJobRunner } = require('../src/services/media/video-job-runner');
const { createMediaWorker } = require('../src/services/media/job-worker');

test('media cost provenance uses dimensioned prices; unknown is not zero or a fabricated tariff', () => {
  assert.equal(quoteMediaCost({ billing: 'per_generation', qualityRank: 10 }).estimatedCostUSD, null);
  assert.equal(quoteMediaCost({ per_second: 0.2, source: 'admin_price' }, { durationSeconds: 8 }).estimatedCostUSD, 1.6);
  assert.equal(quoteMediaCost({ per_image: 0.04 }, { count: 3 }).estimatedCostUSD, 0.12);
  assert.equal(quoteMediaCost({ per_generation: 0 }).estimatedCostUSD, 0);
  assert.equal(quoteMediaCost({ per_image: 1, currency: 'EUR' }).estimatedCostUSD, null);
  assert.equal(quoteMediaCost({ per_image: 1 }, { count: Infinity }).estimatedCostUSD, null);
});
test('paid Fal queue submission is exactly one HTTP attempt, even on an ambiguous503', async () => {
  let calls = 0;
  await assert.rejects(submitFalQueueOnce('fal-ai/veo3/fast', { input: { prompt: 'test' }, credentials: 'synthetic-not-live',
    fetchImpl: async () => { calls++; return new Response('upstream unavailable', { status: 503 }); },
  }), { status: 503 });
  assert.equal(calls, 1);
});
test('bounded transfer stops a chunked body without Content-Length and removes partial files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-limit-'));
  const file = path.join(dir, 'asset.partial'); let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(Buffer.alloc(600)); }, cancel() { cancelled = true; } });
  try {
    await assert.rejects(downloadToFile(new Response(body), file, { maxBytes: 1024 }), { code: 'MEDIA_TOO_LARGE' });
    assert.equal(cancelled, true);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    await assert.rejects(readLimitedResponse(new Response(Buffer.alloc(2000)), { maxBytes: 1024 }), { code: 'MEDIA_TOO_LARGE' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('download abort destroys the network body and partial file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-abort-'));
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200); res.write(Buffer.alloc(1024));
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 5);
    res.on('close', () => { clearInterval(timer); disconnected(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/asset`);
    const pending = downloadToFile(response, path.join(dir, 'aborted'), { maxBytes: 1024 * 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending, { name: 'AbortError' });
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('network body leaked')), 1000))]);
    await assert.rejects(fs.stat(path.join(dir, 'aborted')), { code: 'ENOENT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});
test('video crash after provider acceptance resumes saved ID without a second paid submit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-recovery-'));
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('offline video bytes'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let submitted = 0, statusReads = 0;
  const job = { checkpoint: { dispatchState: 'submitted', providerRequestId: 'saved-upstream-id' }, age_ms: 0 };
  const ctx = { jobId: 'j', job, signal: new AbortController().signal,
    checkpoint: async patch => Object.assign(job.checkpoint, patch), progress: async () => {} };
  const fal = { queue: {
    submit: async () => { submitted++; throw new Error('must not submit'); },
    status: async (_model, options) => { statusReads++; assert.equal(options.requestId, 'saved-upstream-id'); return { status: 'COMPLETED' }; },
    result: async () => ({ data: { video: { url: `http://127.0.0.1:${server.address().port}/v` } } }),
  } };
  try {
    const run = createVideoJobRunner({ fal, videosDir: dir, prepareImageUrl: async url => url, storage: { enabled: () => false, videoKey: name => name } });
    const result = await run(ctx, { model: 'fal-ai/veo3/fast', filename: 'video.mp4', duration: '8s', aspectRatio: '16:9', resolution: '720p', audio: true, publicOperation: {} });
    assert.equal(submitted, 0); assert.equal(statusReads, 1); assert.equal(result.file_size, 19);
    assert.equal(await fs.readFile(path.join(dir, 'video.mp4'), 'utf8'), 'offline video bytes');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});
test('video crash in ambiguous submit window cannot make a second paid request', async () => {
  let called = false;
  const run = createVideoJobRunner({ fal: { queue: { submit: async () => { called = true; } } } });
  await assert.rejects(run({ job: { checkpoint: { dispatchState: 'submitting' } } }, {}), { code: 'MEDIA_DISPATCH_UNKNOWN' });
  assert.equal(called, false);
});
test('durable worker settles queued Stop without calling any provider', async () => {
  let ran = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const jobs = [{ id: 'cancel-before-start', kind: 'test', checkpoint: {} }];
  const store = { claim: async () => jobs.shift(), heartbeat: async () => ({ cancelRequested: true }),
    settle: async (_job, result) => { resolveDone(result); } };
  const worker = createMediaWorker({ store, registry: new Map([['test', async () => { ran = true; }]]) });
  worker.start(); const result = await done; await worker.stop();
  assert.equal(ran, false); assert.equal(result.status, 'cancelled');
});
test('durable worker shutdown releases a checkpointed lease, never marks it a user cancellation', async () => {
  let started, released = false, terminal = false;
  const began = new Promise(resolve => { started = resolve; });
  const jobs = [{ id: 'restart', kind: 'test', checkpoint: { providerRequestId: 'existing' } }];
  const store = { claim: async () => jobs.shift(), heartbeat: async () => ({ cancelRequested: false }),
    defer: async () => { released = true; }, settle: async () => { terminal = true; } };
  const runner = ctx => new Promise((_, reject) => { started(); ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)); });
  const worker = createMediaWorker({ store, registry: new Map([['test', runner]]) });
  worker.start(); await began; await worker.stop();
  assert.equal(released, true); assert.equal(terminal, false);
});
