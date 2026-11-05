'use strict';

// Long-lane autoscaler and scratch of the media queue (batches of long
// recordings): the pure target function, its config, the tick that moves the
// queue-wide cap and the worker, and where remote media is downloaded.
// Offline: fake queue, fake worker, temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const q = require('../src/services/media-transcription-queue');

const config = (over = {}) => ({ enabled: true, floor: 2, ceiling: 8, scaleUpThreshold: 1, scaleUpStep: 2, scaleDownAfterMs: 120_000, intervalMs: 15_000, ...over });

test('config: defaults, env overrides, disabled when the ceiling meets the floor or by flag', () => {
  assert.deepEqual(q.getMediaAutoscalerConfig({}), config());
  assert.equal(q.CONCURRENCY, 2);
  assert.equal(q.MAX_CONCURRENCY, 8);
  const custom = q.getMediaAutoscalerConfig({ SIRAGPT_MEDIA_CONCURRENCY: '4', SIRAGPT_MEDIA_MAX_CONCURRENCY: '12', SIRAGPT_MEDIA_AUTOSCALE_QUEUE_DEPTH: '3', SIRAGPT_MEDIA_AUTOSCALE_STEP: '4', SIRAGPT_MEDIA_AUTOSCALE_SCALE_DOWN_MS: '30000', SIRAGPT_MEDIA_AUTOSCALE_INTERVAL_MS: '1000' });
  assert.deepEqual(custom, config({ floor: 4, ceiling: 12, scaleUpThreshold: 3, scaleUpStep: 4, scaleDownAfterMs: 30_000, intervalMs: 5_000 }));
  assert.equal(q.getMediaAutoscalerConfig({ SIRAGPT_MEDIA_MAX_CONCURRENCY: '2' }).enabled, false);
  assert.equal(q.getMediaAutoscalerConfig({ SIRAGPT_MEDIA_CONCURRENCY: '6', SIRAGPT_MEDIA_MAX_CONCURRENCY: '3' }).ceiling, 6, 'the ceiling is never below the floor');
  assert.equal(q.getMediaAutoscalerConfig({ SIRAGPT_MEDIA_AUTOSCALE: '0' }).enabled, false);
});

test('target: grows by step while recordings wait and a cloud provider has capacity, never above the ceiling', () => {
  const up = q.nextMediaAutoscalerTarget({ depth: 40, current: 2, busySinceMs: null, now: 1000, config: config(), cloudReady: true });
  assert.deepEqual(up, { target: 4, changed: true, busySinceMs: 1000 });
  const more = q.nextMediaAutoscalerTarget({ depth: 40, current: 4, busySinceMs: 1000, now: 16_000, config: config(), cloudReady: true });
  assert.equal(more.target, 6);
  const atCeiling = q.nextMediaAutoscalerTarget({ depth: 40, current: 8, busySinceMs: 1000, now: 31_000, config: config(), cloudReady: true });
  assert.deepEqual(atCeiling, { target: 8, changed: false, busySinceMs: 31_000 });
  const belowThreshold = q.nextMediaAutoscalerTarget({ depth: 2, current: 4, busySinceMs: 1000, now: 31_000, config: config({ scaleUpThreshold: 3 }), cloudReady: true });
  assert.deepEqual(belowThreshold, { target: 4, changed: false, busySinceMs: 31_000 }, 'work still waits: hold, stay hot');
});

test('target: without cloud capacity it returns to the floor at once (whisper.cpp is CPU-bound); quiet returns it after the scale-down delay', () => {
  const noCloud = q.nextMediaAutoscalerTarget({ depth: 40, current: 8, busySinceMs: 1000, now: 2000, config: config(), cloudReady: false });
  assert.deepEqual(noCloud, { target: 2, changed: true, busySinceMs: 2000 });
  const noCloudAtFloor = q.nextMediaAutoscalerTarget({ depth: 0, current: 2, busySinceMs: null, now: 2000, config: config(), cloudReady: false });
  assert.deepEqual(noCloudAtFloor, { target: 2, changed: false, busySinceMs: null });
  const stillHot = q.nextMediaAutoscalerTarget({ depth: 0, current: 6, busySinceMs: 10_000, now: 100_000, config: config(), cloudReady: true });
  assert.deepEqual(stillHot, { target: 6, changed: false, busySinceMs: 10_000 });
  const cooled = q.nextMediaAutoscalerTarget({ depth: 0, current: 6, busySinceMs: 10_000, now: 130_000, config: config(), cloudReady: true });
  assert.deepEqual(cooled, { target: 2, changed: true, busySinceMs: null });
  const idle = q.nextMediaAutoscalerTarget({ depth: 0, current: 2, busySinceMs: null, now: 500_000, config: config(), cloudReady: true });
  assert.deepEqual(idle, { target: 2, changed: false, busySinceMs: null });
});

test('tick: reads the waiting depth and the cloud capacity, sets the queue-wide cap BEFORE the worker concurrency, logs once per change', async () => {
  const log = { info: [], warn: [] };
  const calls = [];
  let waiting = 30;
  let cloud = true;
  const worker = { concurrency: 2 };
  const queue = { async getWaitingCount() { calls.push('depth'); return waiting; }, async setGlobalConcurrency(n) { calls.push(`global:${n}`); } };
  const state = { busySinceMs: null, current: 2 };
  let now = 1000;
  const tick = q.createMediaAutoscalerTick({ worker, getQueue: () => queue, config: config(), cloudReady: () => cloud, state,
    log: { info: (m) => log.info.push(m), warn: (m) => log.warn.push(m) }, now: () => now });
  assert.deepEqual(await tick(), { depth: 30, cloudReady: true, target: 4, changed: true });
  assert.deepEqual(calls, ['depth', 'global:4']);
  assert.equal(worker.concurrency, 4);
  assert.match(log.info[0], /autoscaler concurrency 4 \(waiting=30 cloud=ready\)/);
  now += 15_000;
  await tick();
  assert.equal(worker.concurrency, 6);
  cloud = false;
  now += 15_000;
  assert.deepEqual(await tick(), { depth: 30, cloudReady: false, target: 2, changed: true });
  assert.equal(worker.concurrency, 2);
  assert.equal(calls.filter((c) => c.startsWith('global:')).length, 3);
  waiting = 0;
  cloud = true;
  now += 15_000;
  assert.equal((await tick()).changed, false, 'nothing waits: hold at the floor');
  assert.equal(log.warn.length, 0);
  queue.getWaitingCount = async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); };
  assert.equal(await tick(), null);
  assert.match(log.warn[0], /autoscaler tick failed: ECONNRESET/);
  const throwingCloud = q.createMediaAutoscalerTick({ worker, getQueue: () => ({ async getWaitingCount() { return 9; }, async setGlobalConcurrency() {} }), config: config(),
    cloudReady: () => { throw new Error('no engine'); }, state: { busySinceMs: null, current: 6 }, log: { info() {}, warn() {} }, now: () => 1 });
  assert.deepEqual(await throwingCloud(), { depth: 9, cloudReady: false, target: 2, changed: true }, 'a cloud probe that throws counts as no capacity');
});

test('scratch root: SIRAGPT_MEDIA_SCRATCH_DIR, else <UPLOAD_DIR>/.media-scratch (never served), else the OS temp dir', () => {
  assert.equal(q.mediaScratchRoot({ SIRAGPT_MEDIA_SCRATCH_DIR: '/data/scratch' }), '/data/scratch');
  assert.equal(q.mediaScratchRoot({ UPLOAD_DIR: '/app/uploads' }), path.join('/app/uploads', '.media-scratch'));
  assert.equal(q.mediaScratchRoot({}), os.tmpdir());
});

test('remote media is downloaded under the scratch root (created on demand); stale scratch is swept, fresh scratch and other names are kept', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-scratch-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'nested', '.media-scratch');
  const local = await q.materializeMedia('r2:uploads/audio.mp3', { scratchRoot: root, storage: {
    isRemote: () => true, keyFromRef: () => 'uploads/audio.mp3',
    readStream: async () => ({ stream: Readable.from(['audio', '-bytes']) }),
  } });
  assert.equal(path.dirname(path.dirname(local.path)), root, 'the download lives in a sira-media-* dir under the root');
  assert.equal(await fs.promises.readFile(local.path, 'utf8'), 'audio-bytes');
  await local.cleanup();
  await assert.rejects(fs.promises.stat(local.path), { code: 'ENOENT' });

  const stale = path.join(root, 'sira-media-stale');
  const fresh = path.join(root, 'sira-media-fresh');
  const other = path.join(root, 'checkpoints');
  for (const dir of [stale, fresh, other]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(stale, 'source.mp4'), 'x');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  assert.equal(await q.sweepMediaScratch({ root }), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
  assert.equal(await q.sweepMediaScratch({ root: path.join(root, 'does-not-exist') }), 0, 'a missing root is not an error');
});
