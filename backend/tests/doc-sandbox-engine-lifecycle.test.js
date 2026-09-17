'use strict';

// Pure startup ownership tests. No editor/validator/database is mocked or run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDocumentStartupCleanup, waitForDocumentStartup } = require('../dist/doc-sandbox/index');
const { IndependentDocumentValidator } = require('../dist/doc-sandbox/validation');
const { DocumentReadinessLease } = require('../dist/doc-sandbox/readiness');

test('startup failure unwinds every previously registered resource before rejection', async () => {
  const tracked = [];
  await assert.rejects(withDocumentStartupCleanup(() => {
    tracked.push({ released: false });
    tracked.push({ released: false });
    throw new Error('connector body with private credentials');
  }, async () => { for (const resource of tracked) resource.released = true; }),
  (error) => error.message === 'DOC_START_FAILED' && error.cause === undefined);
  assert.equal(tracked.length, 2);
  assert.ok(tracked.every((resource) => resource.released));
});

test('successful startup does not destroy the live resources', async () => {
  let initialized = false; let cleanup = false;
  await withDocumentStartupCleanup(async () => { initialized = true; }, async () => { cleanup = true; });
  assert.equal(initialized, true); assert.equal(cleanup, false);
});

test('a cleanup failure still returns a sanitized typed startup failure', async () => {
  await assert.rejects(withDocumentStartupCleanup(() => { throw new Error('private setup'); },
    async () => { throw new Error('private cleanup'); }), (error) => error.message === 'DOC_START_FAILED' && error.cause === undefined);
});

test('queue startup has a real deadline and unwinds on caller cancellation', async () => {
  await assert.rejects(waitForDocumentStartup(new Promise(() => {}), new AbortController().signal, 10),
    /DOC_START_TIMEOUT/);
  const controller = new AbortController();
  const waiting = waitForDocumentStartup(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /DOC_START_ABORTED/);
  assert.equal(await waitForDocumentStartup(Promise.resolve('connected'), new AbortController().signal), 'connected');
});

test('real preflight refuses unsafe runtime before any worker resources can be allocated', async () => {
  const validator = new IndependentDocumentValidator({ image: `sha256:${'a'.repeat(64)}`, runtime: 'runc' });
  let allocated = false; let cleaned = false;
  await assert.rejects(withDocumentStartupCleanup(async () => {
    await validator.preflight();
    allocated = true;
  }, async () => { cleaned = true; }), /DOC_START_FAILED/);
  assert.equal(allocated, false); assert.equal(cleaned, true);
});

test('readiness requires a recent successful probe and expires without a refresh', () => {
  const lease = new DocumentReadinessLease(100);
  assert.equal(lease.isReady(0), false);
  assert.equal(lease.confirm(lease.ticket(), 1000), true);
  assert.equal(lease.isReady(1099), true);
  assert.equal(lease.isReady(1100), false);
});

test('a disconnect invalidates readiness immediately but a new healthy probe recovers it', () => {
  const lease = new DocumentReadinessLease(100);
  lease.confirm(lease.ticket(), 1000);
  lease.invalidate();
  assert.equal(lease.isReady(1001), false);
  assert.equal(lease.confirm(lease.ticket(), 1010), true);
  assert.equal(lease.isReady(1011), true);
});

test('a stale probe cannot reopen admission after an intervening disconnect', () => {
  const lease = new DocumentReadinessLease(100);
  const oldTicket = lease.ticket();
  lease.invalidate();
  assert.equal(lease.confirm(oldTicket, 1000), false);
  assert.equal(lease.isReady(1000), false);
});

test('shutdown permanently prevents late successful probes from reopening admission', () => {
  const lease = new DocumentReadinessLease(100);
  const ticket = lease.ticket();
  lease.stop();
  assert.equal(lease.confirm(ticket, 1000), false);
  assert.equal(lease.confirm(lease.ticket(), 1000), false);
  assert.equal(lease.isReady(1000), false);
});

test('readiness rejects invalid lease lifetimes', () => {
  for (const ttl of [0, -1, NaN, Infinity]) assert.throws(() => new DocumentReadinessLease(ttl), /DOC_READINESS_TTL/);
});
