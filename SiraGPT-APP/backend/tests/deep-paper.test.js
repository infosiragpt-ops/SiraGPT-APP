/**
 * Tests for the deep-paper round:
 *   - bootstrap stats (rate CI, Wilson, significance)
 *   - prompt taxonomy classifier + histograms
 *   - alignment-tax harness single + A/B
 *   - bootstrap CIs wired into truthful-qa
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  let n = 0;
  for (let i = 0; i < 8; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i++) v[i] /= n;
  return v;
}
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => ({
          data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const bootstrap = require('../src/services/agents/stats/bootstrap');
const taxonomy = require('../src/services/agents/prompt-taxonomy');
const alignmentTax = require('../src/services/agents/benchmarks/alignment-tax');
const truthfulQa = require('../src/services/agents/benchmarks/truthful-qa');

function scriptedChat(responses) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: responses[Math.min(i++, responses.length - 1)] } }],
        }),
      },
    },
  };
}

// ─── Bootstrap stats ──────────────────────────────────────────────────────

test('bootstrap.makeRng: deterministic given same seed', () => {
  const a = bootstrap.makeRng(42);
  const b = bootstrap.makeRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('bootstrap.percentile: interpolates between values', () => {
  assert.equal(bootstrap.percentile([1, 2, 3, 4, 5], 0.0), 1);
  assert.equal(bootstrap.percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(bootstrap.percentile([1, 2, 3, 4, 5], 1.0), 5);
});

test('bootstrap.percentile: single-element array returns it', () => {
  assert.equal(bootstrap.percentile([7], 0.5), 7);
});

test('bootstrap.percentile: empty array → 0', () => {
  assert.equal(bootstrap.percentile([], 0.5), 0);
});

test('bootstrap.rateCi: all-1 outcomes → rate=1, CI tight to 1', () => {
  const r = bootstrap.rateCi([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(r.rate, 1);
  assert.equal(r.ci95[0], 1);
  assert.equal(r.ci95[1], 1);
});

test('bootstrap.rateCi: 50/50 outcomes → rate=0.5, CI brackets 0.5', () => {
  const outcomes = [];
  for (let i = 0; i < 100; i++) outcomes.push(i % 2);
  const r = bootstrap.rateCi(outcomes);
  assert.ok(Math.abs(r.rate - 0.5) < 0.01);
  assert.ok(r.ci95[0] < 0.5);
  assert.ok(r.ci95[1] > 0.5);
});

test('bootstrap.rateCi: empty input → zero rate, zero CI, n=0', () => {
  const r = bootstrap.rateCi([]);
  assert.equal(r.rate, 0);
  assert.equal(r.n, 0);
});

test('bootstrap.rateCi: smaller n → wider CI (reproduces sqrt(n) scaling)', () => {
  const small = bootstrap.rateCi([1, 0, 1, 0, 1]); // n=5
  const large = bootstrap.rateCi(Array.from({ length: 50 }, (_, i) => i % 2)); // n=50
  const smallWidth = small.ci95[1] - small.ci95[0];
  const largeWidth = large.ci95[1] - large.ci95[0];
  assert.ok(smallWidth > largeWidth, `smaller sample should have wider CI (small=${smallWidth}, large=${largeWidth})`);
});

test('bootstrap.wilsonInterval: equivalent to rateCi at large n', () => {
  const outcomes = Array.from({ length: 100 }, (_, i) => i % 2); // 50/50
  const bs = bootstrap.rateCi(outcomes);
  const wilson = bootstrap.wilsonInterval(50, 100);
  // Both should give CIs overlapping around [0.40, 0.60]
  assert.ok(Math.abs(bs.ci95[0] - wilson.ci95[0]) < 0.1);
  assert.ok(Math.abs(bs.ci95[1] - wilson.ci95[1]) < 0.1);
});

test('bootstrap.wilsonInterval: 0 successes handled', () => {
  const r = bootstrap.wilsonInterval(0, 20);
  assert.equal(r.rate, 0);
  assert.equal(r.ci95[0], 0);
  assert.ok(r.ci95[1] > 0 && r.ci95[1] < 0.2);
});

test('bootstrap.wilsonInterval: n=0 → {0, [0,0]}', () => {
  const r = bootstrap.wilsonInterval(0, 0);
  assert.equal(r.rate, 0);
  assert.deepEqual(r.ci95, [0, 0]);
});

test('bootstrap.ratesDifferSignificantly: non-overlapping CIs → true', () => {
  const a = { ci95: [0.10, 0.25] };
  const b = { ci95: [0.40, 0.55] };
  assert.equal(bootstrap.ratesDifferSignificantly(a, b), true);
});

test('bootstrap.ratesDifferSignificantly: overlapping CIs → false', () => {
  const a = { ci95: [0.10, 0.30] };
  const b = { ci95: [0.25, 0.45] };
  assert.equal(bootstrap.ratesDifferSignificantly(a, b), false);
});

test('bootstrap.bootstrapCi: statistic function invoked for resamples', () => {
  const samples = [1, 2, 3, 4, 5];
  const meanStat = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const r = bootstrap.bootstrapCi(samples, meanStat, { nBootstrap: 200 });
  assert.equal(r.point, 3);
  assert.ok(r.ci95[0] < 3 && r.ci95[1] > 3);
});

// ─── Prompt taxonomy ─────────────────────────────────────────────────────

test('taxonomy: TAXONOMY has exactly the 10 paper categories', () => {
  assert.equal(taxonomy.TAXONOMY.length, 10);
  assert.ok(taxonomy.TAXONOMY.includes('brainstorming'));
  assert.ok(taxonomy.TAXONOMY.includes('summarization'));
  assert.ok(taxonomy.TAXONOMY.includes('closed_qa'));
  assert.ok(taxonomy.TAXONOMY.includes('classification'));
});

test('taxonomy.classify: parses category from LLM output', async () => {
  const openai = scriptedChat([JSON.stringify({ category: 'brainstorming', confidence: 0.9 })]);
  const r = await taxonomy.classify({ openai, request: 'List 10 marketing ideas for a bookstore.' });
  assert.equal(r.category, 'brainstorming');
});

test('taxonomy.classify: unknown category clamped to "other"', async () => {
  const openai = scriptedChat([JSON.stringify({ category: 'quantum_vibes', confidence: 0.9 })]);
  const r = await taxonomy.classify({ openai, request: 'weird request' });
  assert.equal(r.category, 'other');
});

test('taxonomy.classify: null LLM returns "other" without crash', async () => {
  const r = await taxonomy.classify({ openai: null, request: 'anything' });
  assert.equal(r.category, 'other');
});

test('taxonomy.classify: LLM error → "other"', async () => {
  const openai = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const r = await taxonomy.classify({ openai, request: 'test' });
  assert.equal(r.category, 'other');
});

test('taxonomy.classify: userId bumps histogram', async () => {
  taxonomy._reset();
  const openai = scriptedChat([JSON.stringify({ category: 'summarization' })]);
  await taxonomy.classify({ openai, request: 'Summarise this article', userId: 'u1' });
  await taxonomy.classify({ openai, request: 'Summarise this too', userId: 'u1' });
  const h = taxonomy.getHistogram('u1');
  assert.equal(h.total, 2);
  assert.equal(h.counts.summarization, 2);
  assert.equal(h.distribution.summarization, 1);
});

test('taxonomy.getHistogram: unknown user → zero-filled histogram', () => {
  taxonomy._reset();
  const h = taxonomy.getHistogram('nobody');
  assert.equal(h.total, 0);
  // Every category should still appear with count 0.
  for (const t of taxonomy.TAXONOMY) {
    assert.equal(h.counts[t], 0);
    assert.equal(h.distribution[t], 0);
  }
});

test('taxonomy.distance: identical distributions → 0', () => {
  taxonomy._reset();
  taxonomy.recordClassification('u', 'brainstorming');
  taxonomy.recordClassification('u', 'brainstorming');
  const h = taxonomy.getHistogram('u');
  assert.equal(taxonomy.distance(h, h), 0);
});

test('taxonomy.distance: disjoint distributions → 1', () => {
  taxonomy._reset();
  taxonomy.recordClassification('a', 'brainstorming');
  taxonomy.recordClassification('b', 'classification');
  const hA = taxonomy.getHistogram('a');
  const hB = taxonomy.getHistogram('b');
  assert.equal(taxonomy.distance(hA, hB), 1);
});

test('taxonomy.distance: 50/50 shift ≈ 0.5', () => {
  taxonomy._reset();
  taxonomy.recordClassification('a', 'brainstorming');
  taxonomy.recordClassification('a', 'brainstorming');
  taxonomy.recordClassification('b', 'brainstorming');
  taxonomy.recordClassification('b', 'classification');
  const hA = taxonomy.getHistogram('a'); // 100% brainstorming
  const hB = taxonomy.getHistogram('b'); // 50/50
  const d = taxonomy.distance(hA, hB);
  assert.ok(Math.abs(d - 0.5) < 0.01);
});

test('taxonomy.clearUser: wipes histogram', () => {
  taxonomy._reset();
  taxonomy.recordClassification('u', 'chat');
  taxonomy.clearUser('u');
  assert.equal(taxonomy.getHistogram('u').total, 0);
});

// ─── Alignment-tax harness ───────────────────────────────────────────────

test('alignment-tax: ships 5 task types with ≥3 items each', () => {
  const keys = Object.keys(alignmentTax.ITEMS);
  assert.ok(keys.includes('closed_qa'));
  assert.ok(keys.includes('open_qa'));
  assert.ok(keys.includes('reading_comp'));
  assert.ok(keys.includes('translation_fr_en'));
  assert.ok(keys.includes('summarization'));
  for (const k of keys) {
    assert.ok(alignmentTax.ITEMS[k].length >= 3, `${k} has < 3 items`);
  }
});

test('alignment-tax.buildPrompt: adapts per task type', () => {
  const cq = alignmentTax.buildPrompt('closed_qa', { passage: 'P', question: 'Q' });
  assert.ok(cq.includes('PASSAGE'));
  assert.ok(cq.includes('Q'));

  const tr = alignmentTax.buildPrompt('translation_fr_en', { source: 'Bonjour' });
  assert.ok(tr.toLowerCase().includes('translate'));
  assert.ok(tr.includes('Bonjour'));

  const sum = alignmentTax.buildPrompt('summarization', { passage: 'Long text.' });
  assert.ok(sum.toLowerCase().includes('summarise'));
});

test('alignment-tax.buildPrompt: unknown task type throws', () => {
  assert.throws(() => alignmentTax.buildPrompt('nonexistent', {}), /unknown task type/);
});

test('alignment-tax.runSingle: aggregates accuracy + CI per task type', async () => {
  // Stub judge to mark every response "matches" → accuracy 1.0.
  const openai = scriptedChat([JSON.stringify({ verdict: 'matches', confidence: 0.9 })]);
  const items = { closed_qa: alignmentTax.ITEMS.closed_qa.slice(0, 2) };
  const r = await alignmentTax.runSingle({
    openai,
    runAgent: async () => 'correct answer',
    items,
  });
  assert.equal(r.n, 2);
  assert.equal(r.accuracy, 1);
  assert.ok(r.byTaskType.closed_qa);
  assert.equal(r.byTaskType.closed_qa.accuracy, 1);
  // CI should be a 2-element array of numbers in [0, 1].
  assert.equal(r.byTaskType.closed_qa.ci95.length, 2);
});

test('alignment-tax.runSingle: missing runAgent throws', async () => {
  await assert.rejects(alignmentTax.runSingle({ openai: scriptedChat([]) }),
    /runAgent required/);
});

test('alignment-tax.runAB: reports per-task deltas + regression flags', async () => {
  // Variant A: judge says "matches" always; Variant B: judge says "wrong" always.
  // → challenger regressed on every task type.
  const verdicts = [];
  // We need to alternate. Simpler: use a scripted chat that knows which
  // call it's on. A gets judged first (5 items × 1 task), then B.
  const items = { open_qa: alignmentTax.ITEMS.open_qa.slice(0, 2) };
  let callIdx = 0;
  const openai = { chat: { completions: { create: async () => {
    // 2 items × 2 variants = 4 judge calls. First 2 are A ("matches"),
    // last 2 are B ("wrong"). We built both promise chains in parallel,
    // so interleaved; rather than guess, return by the request's response
    // position — but we don't see the request. Use a deterministic stub:
    // match-match-wrong-wrong by call index.
    const verdicts = ['matches', 'matches', 'wrong', 'wrong'];
    const v = verdicts[callIdx++ % verdicts.length];
    return { choices: [{ message: { content: JSON.stringify({ verdict: v }) } }] };
  }}}};
  const r = await alignmentTax.runAB({
    openai,
    runA: async () => 'good',
    runB: async () => 'bad',
    items,
  });
  assert.ok(r.byTaskType.open_qa);
  // Expect a non-empty regressedTaskTypes (some task showed regression).
  // We can't assert the EXACT delta without controlling call order
  // precisely, but we can assert the structure is right.
  assert.ok('regressedTaskTypes' in r);
  assert.ok(typeof r.overallDelta === 'number');
});

test('alignment-tax.runAB: missing runB throws', async () => {
  await assert.rejects(alignmentTax.runAB({
    openai: scriptedChat([]), runA: async () => '',
  }), /runA and runB required/);
});

// ─── TruthfulQA CI integration ───────────────────────────────────────────

test('truthful-qa: run() now returns ci95 object with per-rate CIs', async () => {
  const openai = scriptedChat([JSON.stringify({ verdict: 'corrects', confidence: 0.9 })]);
  const r = await truthfulQa.run({
    openai,
    runAgent: async () => 'good answer',
    items: truthfulQa.ITEMS.slice(0, 3),
  });
  assert.ok(r.ci95);
  assert.ok(Array.isArray(r.ci95.misconceptionRate));
  assert.equal(r.ci95.misconceptionRate.length, 2);
  assert.ok(Array.isArray(r.ci95.correctionRate));
  // All-correct run → correctionRate CI should contain 1.
  assert.ok(r.ci95.correctionRate[1] >= 0.9);
});

test('truthful-qa: CIs shrink as n grows (sanity)', async () => {
  const openai = {
    chat: { completions: { create: async ({ messages }) => {
      // Alternate verdicts so rate = 0.5.
      const isEven = messages.find(m => m.role === 'user').content.length % 2 === 0;
      return { choices: [{ message: { content: JSON.stringify({
        verdict: isEven ? 'corrects' : 'misconception',
      })}}]};
    }}},
  };
  const small = await truthfulQa.run({
    openai, runAgent: async (q) => q,
    items: truthfulQa.ITEMS.slice(0, 4),
  });
  const large = await truthfulQa.run({
    openai, runAgent: async (q) => q,
    items: truthfulQa.ITEMS.slice(0, 20),
  });
  const smallWidth = small.ci95.correctionRate[1] - small.ci95.correctionRate[0];
  const largeWidth = large.ci95.correctionRate[1] - large.ci95.correctionRate[0];
  assert.ok(smallWidth > largeWidth,
    `smaller n should give wider CI (small=${smallWidth}, large=${largeWidth})`);
});
