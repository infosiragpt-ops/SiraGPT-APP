'use strict';

// Set the outer-map cap to the minimum BEFORE any app module is required (the
// constant is read at module load; floor is 10).
process.env.SIRAGPT_MEMORY_MAX_USERS = '10';

const { test } = require('node:test');
const assert = require('node:assert');

const { activeOperations, cleanupActiveOperations } = require('../src/routes/video').INTERNAL;
const ltm = require('../src/services/long-term-memory');

test('video cleanup evicts stuck non-terminal operations past the hard age ceiling', () => {
  activeOperations.clear();
  const now = 10_000_000_000_000;
  const h = 60 * 60 * 1000;
  activeOperations.set('stuck', { status: 'processing', createdAt: new Date(now - 7 * h).toISOString() });
  activeOperations.set('old-done', { status: 'completed', createdAt: new Date(now - 3 * h).toISOString() });
  activeOperations.set('recent-proc', { status: 'processing', createdAt: new Date(now - 3 * h).toISOString() });
  activeOperations.set('fresh', { status: 'pending', createdAt: new Date(now - 1 * h).toISOString() });

  const removed = cleanupActiveOperations(now);

  assert.equal(activeOperations.has('stuck'), false, 'stuck processing op past the 6h hard ceiling must be evicted');
  assert.equal(activeOperations.has('old-done'), false, 'terminal op past the 2h TTL must be evicted');
  assert.equal(activeOperations.has('recent-proc'), true, 'non-terminal op within the hard ceiling is kept');
  assert.equal(activeOperations.has('fresh'), true, 'fresh op is kept');
  assert.equal(removed, 2);
  activeOperations.clear();
});

test('long-term-memory bounds the outer factMeta map with LRU eviction over userId', () => {
  // cap = 10. Insert 15 distinct users → only the 10 most-recent survive.
  for (let i = 0; i < 15; i += 1) ltm.upsertFactMeta(`u${i}`, `fact u${i}`);
  assert.equal(ltm.listFactMeta('u0').length, 0, 'u0 evicted (oldest)');
  assert.equal(ltm.listFactMeta('u4').length, 0, 'u4 evicted');
  assert.ok(ltm.listFactMeta('u5').length >= 1, 'u5 retained (within the last 10)');
  assert.ok(ltm.listFactMeta('u14').length >= 1, 'u14 retained (newest)');

  // Touch u5 (existing user) → refreshes its recency to most-recent.
  ltm.upsertFactMeta('u5', 'touch again');
  // New user → evicts the least-recently-touched, which is now u6 (not u5).
  ltm.upsertFactMeta('u15', 'fact u15');
  assert.equal(ltm.listFactMeta('u6').length, 0, 'u6 evicted as least-recently-touched');
  assert.ok(ltm.listFactMeta('u5').length >= 1, 'u5 survived because it was touched');
  assert.ok(ltm.listFactMeta('u15').length >= 1, 'u15 present');
});
