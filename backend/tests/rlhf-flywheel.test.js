'use strict';

/**
 * RLHF flywheel — preference store, Bradley-Terry reward model, pairing,
 * regenerate implicit labels, SFT/DPO export, RLAIF abstention.
 */

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
process.env.SIRAGPT_RLHF_ENABLED = '1';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

const vectors = require('../src/services/rlhf/vectors');
const rewardModel = require('../src/services/rlhf/reward-model');
const store = require('../src/services/rlhf/preference-store');
const trainer = require('../src/services/rlhf/trainer');
const policy = require('../src/services/rlhf/policy');
const rlaif = require('../src/services/rlhf/rlaif');
const exporter = require('../src/services/rlhf/export');
const ledger = require('../src/services/agents/feedback-ledger');

function vec(arr) {
  return new Float32Array(arr);
}

function fakeEmbedder(table) {
  return async (texts) => texts.map((t) => {
    if (table[t]) return table[t];
    // Stable hash-like embedding so similar strings stay similar.
    const out = new Float32Array(4);
    for (let i = 0; i < t.length; i++) out[i % 4] += (t.charCodeAt(i) % 13) / 13;
    return out;
  });
}

beforeEach(() => {
  store._reset();
  trainer._reset();
  ledger._reset();
});

describe('vectors', () => {
  it('round-trips float32 embeddings through BYTEA', () => {
    const original = vec([0.25, -1.5, 0, 3.125]);
    const buf = vectors.encodeF32(original);
    const back = vectors.decodeF32(buf);
    assert.equal(back.length, 4);
    assert.deepEqual([...back], [...original].map((n) => Math.fround(n)));
  });

  it('cosine is 1 for identical vectors and ~0 for orthogonal', () => {
    assert.ok(Math.abs(vectors.cosine(vec([1, 0]), vec([1, 0])) - 1) < 1e-6);
    assert.ok(Math.abs(vectors.cosine(vec([1, 0]), vec([0, 1]))) < 1e-6);
  });

  it('hashPrompt normalises whitespace and case', () => {
    assert.equal(vectors.hashPrompt('Hola  Mundo'), vectors.hashPrompt('hola mundo'));
    assert.notEqual(vectors.hashPrompt('hola'), vectors.hashPrompt('adios'));
  });
});

describe('preference-store', () => {
  it('records thumbs and reports stats', async () => {
    await store.ingestThumb({
      userId: 'u1', runId: 'm1', request: 'explica RLHF', response: 'es feedback humano',
      helpful: true,
    });
    await store.ingestThumb({
      userId: 'u1', runId: 'm2', request: 'explica PPO', response: 'no sé',
      helpful: false,
    });
    const s = store.stats('u1');
    assert.equal(s.total, 2);
    assert.equal(s.chosen, 1);
    assert.equal(s.rejected, 1);
    assert.equal(s.helpful, 1);
  });

  it('pairs chosen+rejected on the same prompt hash', async () => {
    const prompt = 'how does DPO work?';
    await store.recordEvent({
      userId: 'u1', runId: 'a', source: 'pairwise', label: 'chosen',
      promptText: prompt, responseText: 'good answer',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'b', source: 'pairwise', label: 'rejected',
      promptText: prompt, responseText: 'bad answer',
    });
    const pairs = store.pairsFor('u1');
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].chosen.responseText, 'good answer');
    assert.equal(pairs[0].rejected.responseText, 'bad answer');
    assert.equal(pairs[0].chosen.pairId, pairs[0].rejected.pairId);
  });

  it('regenerate marks the prior response rejected and stores the new candidate', async () => {
    const prompt = 'escribe un haiku';
    await store.recordEvent({
      userId: 'u1', runId: 'old', messageId: 'old',
      promptText: prompt, responseText: 'mal haiku', label: 'unlabeled', source: 'explicit',
    });
    const out = await store.ingestRegenerate({
      userId: 'u1', messageId: 'new', prompt, response: 'mejor haiku', agent: 'chat',
    });
    assert.equal(out.priorRejected, true);
    const dumped = store.dump('u1');
    const prior = dumped.find((e) => e.messageId === 'old');
    const next = dumped.find((e) => e.messageId === 'new');
    assert.equal(prior.label, 'rejected');
    assert.equal(next.label, 'unlabeled');
    assert.equal(next.source, 'regenerate');
  });

  it('isolates users', async () => {
    await store.ingestThumb({ userId: 'a', runId: '1', request: 'q', response: 'x', helpful: true });
    await store.ingestThumb({ userId: 'b', runId: '1', request: 'q', response: 'y', helpful: false });
    assert.equal(store.stats('a').total, 1);
    assert.equal(store.stats('b').rejected, 1);
  });

  it('respects SIRAGPT_RLHF_ENABLED=0', async () => {
    const orig = process.env.SIRAGPT_RLHF_ENABLED;
    process.env.SIRAGPT_RLHF_ENABLED = '0';
    try {
      const r = await store.ingestThumb({
        userId: 'u1', runId: 'm1', request: 'q', response: 'a', helpful: true,
      });
      assert.equal(r.stored, false);
      assert.equal(store.stats('u1').total, 0);
    } finally {
      process.env.SIRAGPT_RLHF_ENABLED = orig;
    }
  });
});

describe('reward-model', () => {
  it('ranks the chosen response above the rejected one after BT training', () => {
    const prompt = vec([1, 0, 0, 0]);
    const good = vec([1, 0, 0, 0]);
    const bad = vec([0, 1, 0, 0]);
    const pairs = [];
    const pointwise = [];
    for (let i = 0; i < 24; i++) {
      pairs.push({ promptEmb: prompt, chosenEmb: good, rejectedEmb: bad });
      pointwise.push({ promptEmb: prompt, responseEmb: good, y: 1 });
      pointwise.push({ promptEmb: prompt, responseEmb: bad, y: 0 });
    }
    const result = rewardModel.train({
      pairs,
      pointwise,
      opts: { minPairs: 4, minPointwise: 4, epochs: 25, l2: 1e-4 },
    });
    assert.equal(result.ok, true);
    const sGood = rewardModel.score(result.model, prompt, good);
    const sBad = rewardModel.score(result.model, prompt, bad);
    assert.ok(sGood > sBad, `expected chosen > rejected (${sGood} vs ${sBad})`);
    assert.ok(result.metrics.pairAcc === 1);
  });

  it('refuses to train on empty data', () => {
    const result = rewardModel.train({ pairs: [], pointwise: [] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_data');
  });

  it('serialize/deserialize preserves scores', () => {
    const prompt = vec([0.5, 0.5]);
    const resp = vec([0.2, 0.8]);
    const trained = rewardModel.train({
      pointwise: [
        { promptEmb: prompt, responseEmb: resp, y: 1 },
        { promptEmb: prompt, responseEmb: vec([0.9, 0.1]), y: 0 },
        { promptEmb: vec([1, 0]), responseEmb: vec([1, 0]), y: 1 },
        { promptEmb: vec([1, 0]), responseEmb: vec([0, 1]), y: 0 },
        { promptEmb: vec([0, 1]), responseEmb: vec([0, 1]), y: 1 },
        { promptEmb: vec([0, 1]), responseEmb: vec([1, 0]), y: 0 },
        { promptEmb: vec([0.3, 0.7]), responseEmb: vec([0.3, 0.7]), y: 1 },
        { promptEmb: vec([0.3, 0.7]), responseEmb: vec([0.7, 0.3]), y: 0 },
      ],
      opts: { minPointwise: 4, minPairs: 99, epochs: 8 },
    });
    assert.equal(trained.ok, true);
    const buf = rewardModel.serialize(trained.model);
    const restored = rewardModel.deserialize(buf);
    const a = rewardModel.score(trained.model, prompt, resp);
    const b = rewardModel.score(restored, prompt, resp);
    assert.ok(Math.abs(a - b) < 1e-9);
  });
});

describe('trainer + policy', () => {
  it('fits from the store and ranks samples with the RM', async () => {
    const prompt = 'explica DPO';
    const good = 'DPO optimiza la política directo con pares de preferencia.';
    const bad = 'asdf qwerty';
    const embedder = fakeEmbedder({
      [prompt]: vec([1, 0, 0, 0]),
      [good]: vec([1, 0, 0, 0]),
      [bad]: vec([0, 1, 0, 0]),
    });
    for (let i = 0; i < 10; i++) {
      await store.recordEvent({
        userId: 'u1', runId: `c${i}`, promptText: prompt, responseText: good,
        label: 'chosen', source: 'explicit', embedder,
      });
      await store.recordEvent({
        userId: 'u1', runId: `r${i}`, promptText: prompt, responseText: bad,
        label: 'rejected', source: 'explicit', embedder,
      });
    }
    const trained = await trainer.train({ rmOpts: { minPairs: 4, minPointwise: 4, epochs: 20 } });
    assert.equal(trained.ok, true);
    assert.equal(trainer.hasActiveModel(), true);

    const ranked = await policy.rankSamples({
      prompt, samples: [bad, good], embedder,
    });
    assert.ok(ranked);
    assert.equal(ranked.winner.response, good);
    assert.equal(ranked.source, 'reward_model');
  });
});

describe('rlaif', () => {
  it('commits only confident HHH scores', () => {
    assert.equal(rlaif.decide({ overall: 9 }).label, 'chosen');
    assert.equal(rlaif.decide({ overall: 2 }).label, 'rejected');
    assert.equal(rlaif.decide({ overall: 6 }).label, null);
    assert.equal(rlaif.decide({ overall: 6 }).reason, 'abstain');
  });

  it('is off by default', () => {
    delete process.env.SIRAGPT_RLHF_RLAIF;
    assert.equal(rlaif.isRlaifEnabled(), false);
  });
});

describe('export', () => {
  it('emits SFT only from chosen non-RLAIF rows', async () => {
    await store.recordEvent({
      userId: 'u1', runId: 'h', promptText: 'q1', responseText: 'good',
      label: 'chosen', source: 'explicit', agent: 'chat',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'b', promptText: 'q2', responseText: 'bad',
      label: 'rejected', source: 'explicit', agent: 'chat',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'ai', promptText: 'q3', responseText: 'synthetic',
      label: 'chosen', source: 'rlaif', agent: 'chat',
    });
    const sft = await exporter.exportData({ userId: 'u1', format: 'sft', scrubPii: false });
    assert.equal(sft.count, 1);
    assert.match(sft.ndjson, /good/);
    assert.doesNotMatch(sft.ndjson, /synthetic/);
  });

  it('emits DPO pairs from same-prompt chosen/rejected', async () => {
    const prompt = 'same question';
    await store.recordEvent({
      userId: 'u1', runId: 'w', promptText: prompt, responseText: 'win',
      label: 'chosen', source: 'pairwise',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'l', promptText: prompt, responseText: 'lose',
      label: 'rejected', source: 'pairwise',
    });
    const dpo = await exporter.exportData({ userId: 'u1', format: 'dpo', scrubPii: false });
    assert.equal(dpo.count, 1);
    const row = JSON.parse(dpo.ndjson.trim());
    assert.match(row.preferred_output[0].content, /win/);
    assert.match(row.non_preferred_output[0].content, /lose/);
  });

  it('scrubs PII in exports by default', async () => {
    await store.recordEvent({
      userId: 'u1', runId: 'p', promptText: 'mail me at ada@example.com',
      responseText: 'sure, ada@example.com', label: 'chosen', source: 'explicit',
    });
    const sft = await exporter.exportData({ userId: 'u1', format: 'sft' });
    assert.doesNotMatch(sft.ndjson, /ada@example.com/);
    assert.match(sft.ndjson, /<EMAIL>/);
  });
});

describe('ledger dual-write', () => {
  it('copies thumbs into the durable store', async () => {
    await ledger.record({
      userId: 'u1', runId: 'm9', request: 'hola', response: 'hola!', helpful: true,
    });
    const dumped = store.dump('u1');
    assert.ok(dumped.length >= 1);
    assert.equal(dumped[0].label, 'chosen');
    assert.equal(dumped[0].promptText, 'hola');
  });

  it('forwards chatId onto preference events', async () => {
    await ledger.record({
      userId: 'u1', runId: 'm10', chatId: 'chat-9',
      request: 'q', response: 'a', helpful: true,
    });
    assert.equal(store.dump('u1')[0].chatId, 'chat-9');
  });
});

describe('hydrateRecent', () => {
  it('returns [] when Prisma is not attached', async () => {
    assert.deepEqual(await store.hydrateRecent(), []);
  });

  it('loads newest durable rows into memory (fail-open on query error)', async () => {
    const rows = [
      {
        id: 'e2', userId: 'u2', chatId: 'c2', messageId: 'm2', runId: 'm2',
        source: 'explicit', label: 'rejected', promptText: 'q2', responseText: 'b',
        promptHash: 'h2', promptEmbedding: null, responseEmbedding: null,
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'e1', userId: 'u1', chatId: 'c1', messageId: 'm1', runId: 'm1',
        source: 'explicit', label: 'chosen', promptText: 'q', responseText: 'a',
        promptHash: 'h', promptEmbedding: null, responseEmbedding: null,
        createdAt: new Date('2026-01-02'),
      },
    ];
    store.attachPrisma({
      preferenceEvent: {
        findMany: async () => rows,
      },
    });
    try {
      const events = await store.hydrateRecent({ limit: 10 });
      assert.equal(events.length, 2);
      assert.equal(store.stats('u1').chosen, 1);
      assert.equal(store.stats('u2').rejected, 1);
    } finally {
      store.attachPrisma(null);
    }
  });

  it('hydrateRecentIntoLedger uses ingestLocal (no second Prisma write)', async () => {
    const rlhf = require('../src/services/rlhf');
    let creates = 0;
    store.attachPrisma({
      preferenceEvent: {
        findMany: async () => ([{
          id: 'e1', userId: 'u1', runId: 'm1', messageId: 'm1', chatId: 'c1',
          source: 'explicit', label: 'chosen', promptText: 'hola',
          responseText: 'hola!', promptHash: 'x', createdAt: new Date(),
        }]),
        create: async () => { creates += 1; },
        upsert: async () => { creates += 1; },
      },
    });
    try {
      const n = await rlhf.hydrateRecentIntoLedger(ledger, { limit: 5 });
      assert.equal(n, 1);
      assert.equal(ledger.stats('u1').helpful, 1);
      assert.equal(creates, 0);
    } finally {
      store.attachPrisma(null);
    }
  });
});

describe('policy flags', () => {
  it('best-of-N stays OFF unless SIRAGPT_RLHF_BEST_OF_N is explicitly on', () => {
    const orig = process.env.SIRAGPT_RLHF_BEST_OF_N;
    try {
      delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      assert.equal(policy.isBestOfNEnabled(), false);
      process.env.SIRAGPT_RLHF_BEST_OF_N = '0';
      assert.equal(policy.isBestOfNEnabled(), false);
      process.env.SIRAGPT_RLHF_BEST_OF_N = '1';
      assert.equal(policy.isBestOfNEnabled(), true);
    } finally {
      if (orig == null) delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      else process.env.SIRAGPT_RLHF_BEST_OF_N = orig;
    }
  });
});

describe('source contracts', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  it('chat thumbs pass chatId and record routing success on liked', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/chats.js'), 'utf8');
    assert.match(src, /chatId:\s*message\.chatId/);
    assert.match(src, /recordOutcome/);
    assert.match(src, /outcome:\s*['"]success['"]/);
  });

  it('boot attaches Prisma then hydrates the ledger without blocking listen', () => {
    const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    assert.match(src, /attachPrisma\(prisma\)/);
    assert.match(src, /hydrateRecentIntoLedger/);
    assert.match(src, /loadLatestActive/);
    assert.match(src, /setImmediate/);
  });
});
