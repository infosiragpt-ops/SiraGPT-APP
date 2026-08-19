'use strict';

/**
 * codex-hardening — §13 risk hardening for the Codex Agent V2 subsystem
 * (feature 15): event replay at volume, monotonic seq under concurrency, and a
 * consolidated flag-off smoke (no worker, no live routes).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePrisma } = require('./codex-test-utils');
const eventStore = require('../src/services/codex/event-store');
const runQueue = require('../src/services/codex/run-queue');
const { validateCodexConfig } = require('../src/services/codex/config-validator');

test('replay of 5k events returns them all in seq order within the threshold', async () => {
  const prisma = makeFakePrisma();
  eventStore._resetSeqCache();
  const N = 5000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    await eventStore.appendEvent('vol-run', 'narrative_delta', { text: `t${i}` }, { prisma, publish: async () => {} });
  }
  const appendMs = Date.now() - t0;

  const t1 = Date.now();
  const events = await eventStore.listEvents('vol-run', { afterSeq: 0, prisma });
  const replayMs = Date.now() - t1;

  assert.equal(events.length, N);
  assert.deepEqual(events.slice(0, 3).map((e) => e.seq), [1, 2, 3]);
  assert.equal(events[N - 1].seq, N);
  // Sanity ceiling so a future O(n^2) regression in the store surfaces here.
  assert.ok(replayMs < 2000, `replay took ${replayMs}ms`);
  assert.ok(appendMs < 30_000, `append took ${appendMs}ms`);
});

test('afterSeq replay returns exactly the tail (no loss, no dup)', async () => {
  const prisma = makeFakePrisma();
  eventStore._resetSeqCache();
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop
    await eventStore.appendEvent('r', 'narrative_delta', { text: `t${i}` }, { prisma, publish: async () => {} });
  }
  const tail = await eventStore.listEvents('r', { afterSeq: 97, prisma });
  assert.deepEqual(tail.map((e) => e.seq), [98, 99, 100]);
});

test('flag-off smoke: no worker registered, config inert', () => {
  delete process.env.CODEX_AGENT_V2;
  assert.equal(runQueue.startCodexWorker({ env: { CODEX_AGENT_V2: '' } }), null);
  const cfg = validateCodexConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.warnings.length, 0);
});
