/**
 * Lifecycle + bounding tests for long-term-memory.
 *
 * Pairs with `long-term-memory.scoring.test.js` (which covers the pure
 * scoring math). This file exercises:
 *   - LRU-by-lastSeen eviction when a user hits the per-user cap
 *   - pruneFactMeta() drops stale + unreinforced facts only
 *   - listFactMeta() snapshot used by /admin/memory diagnostics
 *   - extractFactsAsync respects SIRAGPT_MEMORY_DISABLED
 *
 * The factMeta map is module-level state, so each test uses a unique
 * userId (UUID-like) to avoid cross-test contamination — same pattern
 * as the existing scoring suite.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ltm = require('../src/services/long-term-memory');

function uniqueUser(prefix = 'lifecycle') {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

test('upsertFactMeta evicts least-recently-seen entry at capOverride', async () => {
  const userId = uniqueUser();
  // Date.now() has 1ms resolution — without small awaits, all four
  // upserts can land on the same millisecond and the iteration-order
  // tiebreak picks the wrong eviction candidate. Awaiting 2ms between
  // mutations gives each entry a distinct lastSeen.
  const tick = () => new Promise((r) => setTimeout(r, 2));

  // cap=3, insert 4 facts → oldest by lastSeen should be evicted.
  ltm.upsertFactMeta(userId, 'fact one', 3);   await tick();
  ltm.upsertFactMeta(userId, 'fact two', 3);   await tick();
  ltm.upsertFactMeta(userId, 'fact three', 3); await tick();
  // Reinforce 'fact one' so it's the most-recently-seen of the first three.
  ltm.upsertFactMeta(userId, 'fact one', 3);   await tick();
  // Insert a 4th distinct fact → eviction kicks in. 'fact two' is now
  // the oldest by lastSeen (fact one was refreshed, fact three came
  // after fact two) and should get dropped.
  ltm.upsertFactMeta(userId, 'fact four', 3);

  const snapshot = ltm.listFactMeta(userId).map(e => e.norm).sort();
  assert.equal(snapshot.length, 3);
  assert.deepEqual(snapshot, ['fact four', 'fact one', 'fact three']);
});

test('upsertFactMeta cap defaults to MAX_FACTS_PER_USER and is generous', () => {
  // Smoke: inserting a couple of facts under default cap does NOT evict.
  const userId = uniqueUser();
  ltm.upsertFactMeta(userId, 'a');
  ltm.upsertFactMeta(userId, 'b');
  ltm.upsertFactMeta(userId, 'c');
  assert.equal(ltm.listFactMeta(userId).length, 3);
  assert.ok(ltm.MAX_FACTS_PER_USER >= 10, 'default cap should be roomy');
});

test('upsertFactMeta capOverride <= 0 falls back to default', () => {
  const userId = uniqueUser();
  ltm.upsertFactMeta(userId, 'a', 0);     // bogus → default
  ltm.upsertFactMeta(userId, 'b', -5);    // bogus → default
  ltm.upsertFactMeta(userId, 'c', NaN);   // bogus → default
  assert.equal(ltm.listFactMeta(userId).length, 3);
});

test('pruneFactMeta drops stale + unreinforced; keeps repeated', () => {
  const userId = uniqueUser();
  // Three facts: two single-mention (will be pruned), one with
  // mentions=2 (will be kept by the minMentions threshold).
  ltm.upsertFactMeta(userId, 'stale single a');
  ltm.upsertFactMeta(userId, 'stale repeated');
  ltm.upsertFactMeta(userId, 'stale repeated'); // mentions=2
  ltm.upsertFactMeta(userId, 'stale single b');

  // pruneFactMeta with NEGATIVE maxAgeDays makes the cutoff sit in
  // the future, so every existing entry's lastSeen is "stale" by
  // definition. With minMentions=1, only the two single-mention
  // entries are eligible — 'stale repeated' (mentions=2) survives.
  const pruned = ltm.pruneFactMeta({ userId, maxAgeDays: -1, minMentions: 1 });
  assert.equal(pruned, 2);

  const remaining = ltm.listFactMeta(userId).map(e => e.norm).sort();
  assert.deepEqual(remaining, ['stale repeated']);
});

test('pruneFactMeta returns 0 when nothing matches and is a no-op', () => {
  const userId = uniqueUser();
  ltm.upsertFactMeta(userId, 'fresh fact');
  const pruned = ltm.pruneFactMeta({ userId, maxAgeDays: 365, minMentions: 1 });
  assert.equal(pruned, 0);
  assert.equal(ltm.listFactMeta(userId).length, 1);
});

test('pruneFactMeta without userId scans all users', () => {
  const userA = uniqueUser('A');
  const userB = uniqueUser('B');
  ltm.upsertFactMeta(userA, 'a-fact');
  ltm.upsertFactMeta(userB, 'b-fact');
  const pruned = ltm.pruneFactMeta({ maxAgeDays: -1, minMentions: 1 });
  assert.ok(pruned >= 2, `expected >=2 entries pruned across users, got ${pruned}`);
});

test('listFactMeta returns empty array for unknown user (no crash)', () => {
  assert.deepEqual(ltm.listFactMeta('never-touched'), []);
});

test('listFactMeta ageDays reflects firstSeen, not lastSeen', () => {
  const userId = uniqueUser();
  ltm.upsertFactMeta(userId, 'aged fact');
  // mention again → lastSeen updates but firstSeen stays
  ltm.upsertFactMeta(userId, 'aged fact');
  const [entry] = ltm.listFactMeta(userId);
  assert.equal(entry.norm, 'aged fact');
  assert.equal(entry.mentions, 2);
  assert.ok(entry.firstSeen <= entry.lastSeen);
});

test('extractFactsAsync no-ops when SIRAGPT_MEMORY_DISABLED is set', async () => {
  // Manipulate the env BEFORE re-requiring the module so MEMORY_DISABLED
  // re-reads as true. We use a fresh require to dodge the const cache.
  const prev = process.env.SIRAGPT_MEMORY_DISABLED;
  process.env.SIRAGPT_MEMORY_DISABLED = '1';
  delete require.cache[require.resolve('../src/services/long-term-memory')];
  // rag-service is also required transitively; clear it so any stub
  // it might hold doesn't leak. (It's idempotent in practice — this
  // is belt-and-braces for the next person reading.)
  // NOTE: We do NOT clear rag-service cache here because the production
  // code holds a long-lived collection; doing so could break parallel
  // tests in the same suite.
  const reloaded = require('../src/services/long-term-memory');
  assert.equal(reloaded.MEMORY_DISABLED, true);

  // Spy on rag.ingest by passing a no-op openai — extractFactsAsync
  // should bail BEFORE invoking openai.chat.completions.create.
  let openaiCalled = false;
  const fakeOpenai = {
    chat: {
      completions: {
        create: async () => { openaiCalled = true; return { choices: [{ message: { content: '{"facts":[]}' } }] }; },
      },
    },
  };
  reloaded.extractFactsAsync({
    openai: fakeOpenai,
    userId: 'u',
    userMessage: 'hi',
    assistantMessage: 'hello',
  });
  // Wait one microtask + one immediate tick to give a hypothetical
  // setImmediate scheduler a chance to run if our guard is broken.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(openaiCalled, false, 'extraction must not run when disabled');

  // Restore env + module cache for downstream tests in the runner.
  if (prev === undefined) delete process.env.SIRAGPT_MEMORY_DISABLED;
  else process.env.SIRAGPT_MEMORY_DISABLED = prev;
  delete require.cache[require.resolve('../src/services/long-term-memory')];
});
