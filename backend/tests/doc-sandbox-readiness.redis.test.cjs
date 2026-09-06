'use strict';

// Real ephemeral Redis and BullMQ, no model/validator/isolation mocks. The test
// owns a fresh loopback port and process; it never reads REDIS_URL or production.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const { DocumentReadinessLease, createDocumentWorkerReadinessProbe } = require('../dist/doc-sandbox/readiness');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let directory, redis, port, producer, execution, queue, worker, probe, lease;
let paused = false;
const lifetime = new AbortController();

async function startRedis() {
  const binary = process.env.DOC_SANDBOX_TEST_REDIS_BINARY || 'redis-server';
  redis = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--protected-mode', 'yes', '--dir', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const child = redis;
  child.stderr.on('data', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('DOC_TEST_REDIS_START_TIMEOUT')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('DOC_TEST_REDIS_BINARY_UNAVAILABLE')); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`DOC_TEST_REDIS_START_EXIT_${code}`)); });
    child.stdout.on('data', (data) => {
      if (data.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); }
    });
  });
}

async function stopRedis() {
  if (!redis || redis.exitCode !== null) return;
  const child = redis;
  if (paused) { child.kill('SIGCONT'); paused = false; }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('DOC_TEST_REDIS_STOP_TIMEOUT')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function refresh(signal = lifetime.signal) {
  const ticket = lease.ticket();
  const healthy = await probe.check(signal);
  if (!healthy) { lease.invalidate(); return false; }
  return lease.confirm(ticket);
}

async function awaitHealthy() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await refresh()) return;
    await pause(50);
  }
  assert.fail('real Redis/BullMQ did not recover readiness within 5 seconds');
}

test.before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'siragpt-readiness-redis-'));
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await startRedis();
  const connection = { host: '127.0.0.1', port, connectTimeout: 500, retryStrategy: () => 50 };
  producer = new IORedis({ ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1000 });
  execution = new IORedis({ ...connection, maxRetriesPerRequest: null, enableOfflineQueue: true });
  producer.on('error', () => {}); execution.on('error', () => {});
  const name = `doc-readiness-${randomUUID()}`;
  queue = new Queue(name, { connection: producer }); queue.on('error', () => {});
  worker = new Worker(name, async () => { throw new Error('readiness test must not enqueue document jobs'); },
    { connection: execution, autorun: false, drainDelay: 0.1 });
  worker.on('error', () => {});
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  lease = new DocumentReadinessLease(1000);
  probe = createDocumentWorkerReadinessProbe(queue, worker, () => lease.invalidate(), 450);
  void worker.run().catch(() => lease.invalidate());
  await awaitHealthy();
});

test.after(async () => {
  lifetime.abort(); probe?.close(); lease?.stop();
  if (paused) { redis.kill('SIGCONT'); paused = false; }
  await worker?.close(true);
  await queue?.close();
  producer?.disconnect(); execution?.disconnect();
  await stopRedis();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('healthy real idle worker answers producer, worker and blocking-connection probes', async () => {
  assert.equal(await refresh(), true);
  assert.equal(lease.isReady(), true);
  assert.equal(await queue.getJobCountByTypes('wait', 'active', 'completed', 'failed'), 0);
});

test('clean socket close revokes readiness without relying on an error event and recovers', async () => {
  let errors = 0;
  const countError = () => { errors++; };
  producer.on('error', countError);
  const ended = new Promise((resolve) => producer.once('end', resolve));
  producer.disconnect();
  await ended;
  assert.equal(errors, 0);
  assert.equal(lease.isReady(), false);
  assert.equal(await refresh(), false);
  await producer.connect();
  await awaitHealthy();
  assert.equal(lease.isReady(), true);
  producer.off('error', countError);
});

test('real Redis shutdown and restart closes admission then restores it without restarting the worker', async () => {
  const originalWorker = worker;
  await stopRedis();
  await pause(60);
  assert.equal(lease.isReady(), false);
  assert.equal(await refresh(), false);
  await startRedis();
  await awaitHealthy();
  assert.equal(worker, originalWorker);
  assert.equal(lease.isReady(), true);
});

test('unresponsive Redis fails a bounded probe and retains at most one outstanding ping per client', async () => {
  redis.kill('SIGSTOP'); paused = true;
  const began = Date.now();
  assert.equal(await refresh(), false);
  assert.ok(Date.now() - began < 1200);
  assert.equal(lease.isReady(), false);
  const blocking = await worker.waitUntilReady();
  const sizes = [producer.commandQueue.length, execution.commandQueue.length, blocking.commandQueue.length];
  assert.equal(await refresh(), false);
  assert.deepEqual([producer.commandQueue.length, execution.commandQueue.length, blocking.commandQueue.length], sizes);
  // Producer commandTimeout expires before the worker sockets' pending PINGs.
  // A Promise.all early rejection would clear ownership and enqueue duplicates.
  await pause(250);
  const workerSizes = [execution.commandQueue.length, blocking.commandQueue.length];
  assert.equal(await refresh(), false);
  assert.deepEqual([execution.commandQueue.length, blocking.commandQueue.length], workerSizes);
  redis.kill('SIGCONT'); paused = false;
  await awaitHealthy();
});

test('cancellation returns promptly during a real stalled ping and late replies cannot reopen a stopped lease', async () => {
  redis.kill('SIGSTOP'); paused = true;
  const controller = new AbortController();
  const began = Date.now();
  const pending = refresh(controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.ok(Date.now() - began < 200);
  lease.stop();
  redis.kill('SIGCONT'); paused = false;
  await pause(150);
  assert.equal(lease.isReady(), false);
});
