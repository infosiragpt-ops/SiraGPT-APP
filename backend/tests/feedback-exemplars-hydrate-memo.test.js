'use strict';

// «feedback-exemplars exceeded 900ms»: the chat turn's exemplar lookup re-read
// Message.feedback on every turn for users without rated answers, hydrated
// twice on concurrent first turns, embedded each row serially and wrote the
// already-durable rows back to the preference store.

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const ledger = require('../src/services/agents/feedback-ledger');
const store = require('../src/services/rlhf/preference-store');
const steering = require('../src/services/rlhf/steering');

const ENV_KEYS = ['SIRAGPT_RLHF_HYDRATE_TTL_MS', 'SIRAGPT_RLHF_HYDRATE_MAX_USERS'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ledger._reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function countingEmbedder() {
  const fn = async (texts) => {
    fn.calls += 1;
    fn.texts.push(...texts);
    return texts.map((t) => Float32Array.from([String(t).includes('sort') ? 1 : 0, 1, t.length]));
  };
  fn.calls = 0;
  fn.texts = [];
  return fn;
}

function countingLoader(rowsOrError, delayMs = 0) {
  const fn = async () => {
    fn.calls += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const value = typeof rowsOrError === 'function' ? rowsOrError(fn.calls) : rowsOrError;
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = 0;
  return fn;
}

const rows = (n, helpful = true) => Array.from({ length: n }, (_, i) => ({
  runId: `m${i}`, agent: 'chat', request: `how do I sort list ${i}?`, response: `answer ${i}`, helpful,
}));

describe('feedback exemplars · durable hydration memo', () => {
  it('reads Message.feedback once, not on every turn, for a user without rated answers', async () => {
    const loader = countingLoader([]);
    const embedder = countingEmbedder();
    for (let i = 0; i < 3; i += 1) {
      const hits = await ledger.findExemplars({ userId: 'u-empty', request: 'explica algo', embedder, loader });
      assert.deepEqual(hits, []);
    }
    assert.equal(loader.calls, 1);
    assert.equal(embedder.calls, 0);
  });

  it('buildSteeringBlock (the chat turn path) inherits the memo', async () => {
    const loader = countingLoader([]);
    const embedder = countingEmbedder();
    for (let i = 0; i < 3; i += 1) {
      const out = await steering.buildSteeringBlock({ userId: 'u-steer', prompt: 'explica algo largo', embedder, loader });
      assert.equal(out.applied, false);
    }
    assert.equal(loader.calls, 1);
  });

  it('concurrent first turns share one hydration', async () => {
    const loader = countingLoader(rows(2), 20);
    const embedder = countingEmbedder();
    const [a, b] = await Promise.all([1, 2].map(() => ledger.findExemplars({
      userId: 'u-conc', request: 'please sort this', embedder, loader, k: 1,
    })));
    assert.equal(loader.calls, 1);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(ledger.stats('u-conc').total, 2);
  });

  it('re-reads after SIRAGPT_RLHF_HYDRATE_TTL_MS', async () => {
    process.env.SIRAGPT_RLHF_HYDRATE_TTL_MS = '5';
    const loader = countingLoader([]);
    await ledger.findExemplars({ userId: 'u-ttl', request: 'x', embedder: countingEmbedder(), loader });
    await new Promise((r) => setTimeout(r, 15));
    await ledger.findExemplars({ userId: 'u-ttl', request: 'x', embedder: countingEmbedder(), loader });
    assert.equal(loader.calls, 2);
  });

  it('a thumb recorded after an empty read is used on the very next turn', async () => {
    const loader = countingLoader([]);
    const embedder = countingEmbedder();
    await ledger.findExemplars({ userId: 'u-thumb', request: 'sort it', embedder, loader });
    await ledger.record({
      userId: 'u-thumb', runId: 'fresh', agent: 'chat', request: 'how do I sort?', response: 'Array.sort', helpful: true, embedder,
    });
    const hits = await ledger.findExemplars({ userId: 'u-thumb', request: 'sort it', embedder, loader, k: 1 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].runId, 'fresh');
    assert.equal(loader.calls, 1);
  });

  it('a failed read is retried on the next turn, then memoized', async () => {
    const loader = countingLoader((n) => (n === 1 ? new Error('db down') : []));
    for (let i = 0; i < 3; i += 1) {
      await ledger.findExemplars({ userId: 'u-fail', request: 'x', embedder: countingEmbedder(), loader });
    }
    assert.equal(loader.calls, 2);
  });

  it('SIRAGPT_RLHF_HYDRATE_TTL_MS=0 drops the negative memo but keeps the in-flight dedupe', async () => {
    process.env.SIRAGPT_RLHF_HYDRATE_TTL_MS = '0';
    const loader = countingLoader([], 15);
    await Promise.all([1, 2].map(() => ledger.findExemplars({ userId: 'u-ttl0', request: 'x', embedder: countingEmbedder(), loader })));
    assert.equal(loader.calls, 1, 'concurrent turns still share one read');
    await ledger.findExemplars({ userId: 'u-ttl0', request: 'x', embedder: countingEmbedder(), loader });
    assert.equal(loader.calls, 2, 'the next turn reads again');
  });

  it('a loader-less caller does not mark the user as hydrated', async () => {
    const embedder = countingEmbedder();
    await ledger.findExemplars({ userId: 'u-noload', request: 'sort', embedder });
    const loader = countingLoader(rows(1));
    const hits = await ledger.findExemplars({ userId: 'u-noload', request: 'sort', embedder, loader, k: 1 });
    assert.equal(loader.calls, 1);
    assert.equal(hits.length, 1);
  });

  it('clearUser forgets the memo', async () => {
    const loader = countingLoader([]);
    await ledger.findExemplars({ userId: 'u-clear', request: 'x', embedder: countingEmbedder(), loader });
    ledger.clearUser('u-clear');
    await ledger.findExemplars({ userId: 'u-clear', request: 'x', embedder: countingEmbedder(), loader });
    assert.equal(loader.calls, 2);
  });

  it('the memo is LRU-bounded by SIRAGPT_RLHF_HYDRATE_MAX_USERS', async () => {
    process.env.SIRAGPT_RLHF_HYDRATE_MAX_USERS = '2';
    const loader = countingLoader([]);
    for (const u of ['a', 'b', 'c', 'a']) {
      await ledger.findExemplars({ userId: u, request: 'x', embedder: countingEmbedder(), loader });
    }
    assert.equal(loader.calls, 4); // «a» was evicted by «c»
    await ledger.findExemplars({ userId: 'c', request: 'x', embedder: countingEmbedder(), loader });
    assert.equal(loader.calls, 4); // «c» is still remembered
  });
});

describe('feedback exemplars · cheap hydration and query', () => {
  it('embeds every hydrated request in ONE batched call, aligned to its row', async () => {
    const embedder = countingEmbedder();
    const out = await ledger.hydrateFromRows('u-batch', rows(5), embedder);
    assert.equal(out.stored, 5);
    assert.equal(embedder.calls, 1);
    for (const e of ledger._dump('u-batch')) {
      assert.equal(e.embedding[2], e.request.length);
    }
  });

  it('large hydrations embed in slices of 64 (provider batch limits), still aligned', async () => {
    const embedder = countingEmbedder();
    const out = await ledger.hydrateFromRows('u-slices', rows(130), embedder);
    assert.equal(out.stored, 130);
    assert.equal(embedder.calls, 3);
    for (const e of ledger._dump('u-slices')) {
      assert.equal(e.embedding[2], e.request.length);
    }
  });

  it('does not write already-durable rows back to the preference store', async () => {
    await ledger.hydrateFromRows('u-nowrite', rows(3), countingEmbedder());
    assert.equal(store.dump('u-nowrite').length, 0);
  });

  it('a restart does not duplicate preference_events rows for the same thumb', async () => {
    const upserts = [];
    const fake = { preferenceEvent: {
      create: async () => {}, findMany: async () => [],
      upsert: async (args) => { upserts.push(args.where.id); },
    } };
    try {
      for (let boot = 0; boot < 2; boot += 1) {
        ledger._reset();
        store.attachPrisma(fake);
        await ledger.hydrateFromRows('u-boot', rows(1), countingEmbedder());
      }
      assert.deepEqual(upserts, []);
    } finally {
      store.attachPrisma(null);
    }
  });

  it('after a restart, backfill and re-thumbs update the durable row instead of adding one', async () => {
    const upserts = [];
    const durable = {
      id: 'durable1', userId: 'u-backfill', runId: 'm0', messageId: 'm0', agent: 'chat',
      source: 'explicit', label: 'chosen', promptText: 'how do I sort list 0?', responseText: 'answer 0',
      promptHash: 'h', createdAt: new Date(0),
    };
    const fake = { preferenceEvent: {
      create: async () => {},
      findMany: async ({ where }) => (where?.userId === 'u-backfill' ? [durable] : []),
      upsert: async (args) => { upserts.push(args.where.id); },
    } };
    try {
      for (let boot = 0; boot < 2; boot += 1) {
        ledger._reset(); // a restart empties the in-memory stores
        store.attachPrisma(fake);
        await store.ingestThumb({
          userId: 'u-backfill', runId: 'm0', agent: 'chat', request: 'how do I sort list 0?',
          response: 'answer 0', helpful: true, embedder: countingEmbedder(), source: 'explicit',
        });
      }
      assert.deepEqual(upserts, ['durable1', 'durable1']);
    } finally {
      store.attachPrisma(null);
    }
  });

  it('a short embedding response stores entries without vectors, never misaligned', async () => {
    const partial = async (texts) => texts.slice(1).map(() => Float32Array.from([1, 1, 1]));
    await ledger.hydrateFromRows('u-partial', rows(3), partial);
    assert.ok(ledger._dump('u-partial').every((e) => e.embedding === null));
  });

  it('skips the query embedding when no entry can match', async () => {
    const embedder = countingEmbedder();
    await ledger.hydrateFromRows('u-dislikes', rows(2, false), embedder);
    embedder.calls = 0;
    const hits = await ledger.findExemplars({ userId: 'u-dislikes', request: 'sort', embedder, onlyHelpful: true });
    assert.deepEqual(hits, []);
    assert.equal(embedder.calls, 0);
  });
});
