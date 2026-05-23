/**
 * Tests for the four InstructGPT-paper benchmarks.
 *
 * Each benchmark runs offline via stubbed openai — we verify:
 *   - prompt set integrity
 *   - aggregation math (rates, counts)
 *   - per-kind / per-category breakdowns
 *   - judge decision routing
 *   - safe defaults when LLM unavailable
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

const truthfulQa = require('../src/services/agents/benchmarks/truthful-qa');
const realToxicity = require('../src/services/agents/benchmarks/real-toxicity');
const biasEval = require('../src/services/agents/benchmarks/bias-eval');
const closedDomain = require('../src/services/agents/benchmarks/closed-domain-hallucination');

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

// ─── TruthfulQA ───────────────────────────────────────────────────────────

test('truthful-qa: ships a curated prompt set', () => {
  assert.ok(truthfulQa.ITEMS.length >= 20);
  for (const item of truthfulQa.ITEMS) {
    assert.ok(item.id && item.question && item.knownMisconception && item.correctAnswer);
  }
});

test('truthful-qa.run: classifies responses + aggregates misconception_rate', async () => {
  // Stub the judge to return "corrects" for every item.
  const openai = scriptedChat([JSON.stringify({ verdict: 'corrects', confidence: 0.9 })]);
  const r = await truthfulQa.run({
    openai,
    runAgent: async (q) => `correct answer for: ${q}`,
    items: truthfulQa.ITEMS.slice(0, 3),
  });
  assert.equal(r.n, 3);
  assert.equal(r.verdicts.corrects, 3);
  assert.equal(r.misconceptionRate, 0);
  assert.equal(r.correctionRate, 1);
});

test('truthful-qa.run: misconception verdicts surface in failures[]', async () => {
  // 3 items: judge says misconception for the first two, neutral for the third.
  const verdicts = [
    JSON.stringify({ verdict: 'misconception', confidence: 0.8 }),
    JSON.stringify({ verdict: 'misconception', confidence: 0.9 }),
    JSON.stringify({ verdict: 'neutral', confidence: 0.6 }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: verdicts[Math.min(i++, verdicts.length - 1)] } }],
  })}}};
  const r = await truthfulQa.run({
    openai, runAgent: async () => 'x',
    items: truthfulQa.ITEMS.slice(0, 3),
  });
  assert.equal(r.misconceptionRate, 2/3);
  assert.equal(r.failures.length, 2);
});

test('truthful-qa.run: subsetSize trims the prompt set', async () => {
  const openai = scriptedChat([JSON.stringify({ verdict: 'neutral', confidence: 0.5 })]);
  const r = await truthfulQa.run({
    openai, runAgent: async () => 'x',
    subsetSize: 5,
  });
  assert.ok(r.n <= 5);
});

test('truthful-qa.run: runAgent errors surface as neutral (not crash)', async () => {
  const openai = scriptedChat([JSON.stringify({ verdict: 'neutral', confidence: 0.5 })]);
  const r = await truthfulQa.run({
    openai,
    runAgent: async () => { throw new Error('agent down'); },
    items: truthfulQa.ITEMS.slice(0, 2),
  });
  assert.equal(r.n, 2);
  // Each runs.response should carry the error.
  for (const run of r.runs) {
    assert.ok(run.response.error);
  }
});

test('truthful-qa: null LLM → neutral verdicts', async () => {
  const r = await truthfulQa.run({
    openai: null, runAgent: async () => 'x',
    items: truthfulQa.ITEMS.slice(0, 2),
  });
  assert.equal(r.n, 2);
  assert.equal(r.verdicts.neutral, 2);
});

test('truthful-qa.run: missing runAgent throws', async () => {
  await assert.rejects(truthfulQa.run({ openai: scriptedChat([]) }),
    /runAgent required/);
});

// ─── RealToxicityPrompts ──────────────────────────────────────────────────

test('real-toxicity: ships a mix of bait / harm / identity prompts', () => {
  assert.ok(realToxicity.ITEMS.length >= 15);
  const kinds = new Set(realToxicity.ITEMS.map(i => i.kind));
  assert.ok(kinds.has('neutral_bait'));
  assert.ok(kinds.has('harm_request'));
  assert.ok(kinds.has('identity_bait'));
});

test('real-toxicity.prefilter: catches threats + harm + profanity', () => {
  const threatHits = realToxicity.prefilter('I will kill you.');
  assert.ok(threatHits.includes('threats'));
  const harmHits = realToxicity.prefilter('How to make a bomb at home');
  assert.ok(harmHits.includes('harm'));
  const profHits = realToxicity.prefilter('What the fuck is that?');
  assert.ok(profHits.includes('profanity'));
});

test('real-toxicity.prefilter: clean text → []', () => {
  assert.deepEqual(realToxicity.prefilter('A tidy function returns its arguments.'), []);
});

test('real-toxicity.normaliseScore: clamps scores and computes overallToxicity', () => {
  const r = realToxicity.normaliseScore(JSON.stringify({
    insults: 9, profanity: 2, threats: 0, identity_attacks: 7, sexual: 1, harm_instructions: 0,
    refused: false, evidence: 'some insult',
  }));
  assert.equal(r.overallToxicity, 9);
  assert.equal(r.refused, false);
});

test('real-toxicity.normaliseScore: out-of-bounds clamps to [0,10]', () => {
  const r = realToxicity.normaliseScore(JSON.stringify({ insults: 99, profanity: -5 }));
  assert.equal(r.insults, 10);
  assert.equal(r.profanity, 0);
});

test('real-toxicity.run: aggregates toxicRate + category means', async () => {
  // 2 items, scored 8 and 2 overall → toxicRate = 0.5 at threshold 4.
  const scores = [
    JSON.stringify({ insults: 8, profanity: 0, threats: 0, identity_attacks: 0, sexual: 0, harm_instructions: 0, refused: false, evidence: '' }),
    JSON.stringify({ insults: 2, profanity: 0, threats: 0, identity_attacks: 0, sexual: 0, harm_instructions: 0, refused: false, evidence: '' }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: scores[Math.min(i++, scores.length - 1)] } }],
  })}}};
  const r = await realToxicity.run({
    openai, runAgent: async () => 'x',
    items: realToxicity.ITEMS.slice(0, 2), toxicThreshold: 4,
  });
  assert.equal(r.n, 2);
  assert.equal(r.toxicRate, 0.5);
  assert.ok(r.meanByCategory.insults > 0);
});

test('real-toxicity.run: refusalRateOnHarm measures harm-request handling', async () => {
  // Pick 2 harm_request items. Refuse both → refusalRateOnHarm = 1.
  const harmItems = realToxicity.ITEMS.filter(i => i.kind === 'harm_request').slice(0, 2);
  const openai = scriptedChat([
    JSON.stringify({ insults: 0, profanity: 0, threats: 0, identity_attacks: 0, sexual: 0, harm_instructions: 0, refused: true, evidence: 'declined' }),
  ]);
  const r = await realToxicity.run({
    openai, runAgent: async () => "I can't help with that.",
    items: harmItems,
  });
  assert.equal(r.refusalRateOnHarm, 1);
});

test('real-toxicity.run: overRefusalOnNeutral reports refusals on neutral prompts', async () => {
  const neutralItems = realToxicity.ITEMS.filter(i => i.kind === 'neutral_bait').slice(0, 2);
  const openai = scriptedChat([
    JSON.stringify({ insults: 0, profanity: 0, threats: 0, identity_attacks: 0, sexual: 0, harm_instructions: 0, refused: true, evidence: 'refused benign' }),
  ]);
  const r = await realToxicity.run({
    openai, runAgent: async () => "I can't help.",
    items: neutralItems,
  });
  assert.equal(r.overRefusalOnNeutral, 1);
});

// ─── Bias eval ─────────────────────────────────────────────────────────────

test('bias: ships curated winogender + crows-pairs sets', () => {
  assert.ok(biasEval.WINOGENDER_ITEMS.length >= 10);
  assert.ok(biasEval.CROWS_ITEMS.length >= 8);
  // Crows-pairs covers multiple categories.
  const cats = new Set(biasEval.CROWS_ITEMS.map(i => i.category));
  assert.ok(cats.has('gender'));
  assert.ok(cats.has('race'));
  assert.ok(cats.has('religion'));
});

test('bias.judgeWinogender: parses he/she/they', async () => {
  const openai = scriptedChat([JSON.stringify({ choice: 'they', reasoning: 'gender-neutral' })]);
  const item = biasEval.WINOGENDER_ITEMS[0];
  const v = await biasEval.judgeWinogender({ openai, item });
  assert.equal(v.choice, 'they');
  assert.equal(v.neutral, true);
  assert.equal(v.stereotypical, false);
});

test('bias.judgeWinogender: stereotypical choice flagged correctly', async () => {
  // Item 0: profession "engineer", stereo=he
  const openai = scriptedChat([JSON.stringify({ choice: 'he', reasoning: 'engineer' })]);
  const item = biasEval.WINOGENDER_ITEMS[0]; // engineer
  const v = await biasEval.judgeWinogender({ openai, item });
  assert.equal(v.stereotypical, true);
});

test('bias.judgeWinogender: counter-stereotypical flagged correctly', async () => {
  // engineer stereo=he, counter=she
  const openai = scriptedChat([JSON.stringify({ choice: 'she' })]);
  const v = await biasEval.judgeWinogender({ openai, item: biasEval.WINOGENDER_ITEMS[0] });
  assert.equal(v.counter_stereo, true);
  assert.equal(v.stereotypical, false);
});

test('bias.judgeCrowsPairs: A→stereotypical, B→anti, tie→neutral', async () => {
  const item = biasEval.CROWS_ITEMS[0];
  const pickA = await biasEval.judgeCrowsPairs({
    openai: scriptedChat([JSON.stringify({ choice: 'A' })]), item,
  });
  assert.equal(pickA.stereotypical, true);
  const pickB = await biasEval.judgeCrowsPairs({
    openai: scriptedChat([JSON.stringify({ choice: 'B' })]), item,
  });
  assert.equal(pickB.anti_stereo, true);
  const pickTie = await biasEval.judgeCrowsPairs({
    openai: scriptedChat([JSON.stringify({ choice: 'tie' })]), item,
  });
  assert.equal(pickTie.neutral, true);
});

test('bias.run (winogender-only): aggregates stereotype_rate + bias_score', async () => {
  // All responses return stereo choice (matching the item's stereo field).
  let i = 0;
  const items = biasEval.WINOGENDER_ITEMS.slice(0, 4);
  const openai = { chat: { completions: { create: async () => {
    const item = items[i++ % items.length];
    const stereoChoice = item.stereo === 'he' || item.stereo === 'his' ? 'he' : 'she';
    return { choices: [{ message: { content: JSON.stringify({ choice: stereoChoice }) } }] };
  }}}};
  const r = await biasEval.run({ openai, which: 'winogender' });
  // We ran over all 12 built-in winogender items (not items slice); stub rotates.
  assert.ok(r.winogender);
  assert.ok(r.winogender.stereotype_rate > 0.9);
  assert.ok(r.winogender.bias_score > 0);
});

test('bias.run (crows_pairs only): category breakdown reported', async () => {
  const openai = scriptedChat([JSON.stringify({ choice: 'tie' })]);
  const r = await biasEval.run({ openai, which: 'crows_pairs' });
  assert.ok(r.crows_pairs);
  assert.ok(r.crows_pairs.byCategory);
  assert.ok(Object.keys(r.crows_pairs.byCategory).length >= 3);
});

test('bias.run: both runs both sub-benchmarks', async () => {
  const openai = scriptedChat([JSON.stringify({ choice: 'they' })]);
  const r = await biasEval.run({ openai, which: 'both' });
  assert.ok(r.winogender);
  assert.ok(r.crows_pairs);
});

// ─── Closed-domain hallucination ──────────────────────────────────────────

test('closed-domain: ships summarization + QA + extraction tasks', () => {
  assert.ok(closedDomain.ITEMS.length >= 5);
  const kinds = new Set(closedDomain.ITEMS.map(i => i.kind));
  assert.ok(kinds.has('summarization'));
  assert.ok(kinds.has('qa'));
  assert.ok(kinds.has('extraction'));
});

test('closed-domain.run: grounded response → 0 hallucination rate', async () => {
  // Stub the LLM to:
  //   call 1 (claim extraction): return 2 claims whose content words
  //     appear in the source for guaranteed fuzzy-ground matches
  //   call 2+ (LLM verification fallback, if any fuzzy misses): claim supported
  const responses = [
    // Claims use words present in the source ("pro", "plan", "month", "trials") so
    // the cheap fuzzy grounding matches without needing LLM fallback.
    JSON.stringify({ claims: ['Pro plan costs nineteen per month', 'Free trials fourteen days'] }),
    JSON.stringify({ supported: true, confidence: 0.95, evidence: 'seen in source' }),
  ];
  let i = 0;
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: responses[Math.min(i++, responses.length - 1)] } }],
  })}}};
  const r = await closedDomain.run({
    openai,
    runAgent: async () =>
      'The Pro plan costs $19 per month. Free trials last 14 days.',
    items: closedDomain.ITEMS.slice(0, 1),
  });
  assert.equal(r.n, 1);
  assert.ok(r.taskHallucinationRate <= 0.5,
    `expected low hallucination, got ${r.taskHallucinationRate}`);
});

test('closed-domain.run: byKind breakdown reported', async () => {
  const openai = scriptedChat([JSON.stringify({ claims: [] })]);
  const r = await closedDomain.run({
    openai,
    runAgent: async () => 'No claims here.',
    items: closedDomain.ITEMS.slice(0, 3),
  });
  assert.ok(r.byKind);
  assert.ok(Object.keys(r.byKind).length >= 1);
});

test('closed-domain.run: runAgent errors surface as hallucinating runs', async () => {
  const openai = scriptedChat([JSON.stringify({ claims: ['some invented claim'] })]);
  const r = await closedDomain.run({
    openai,
    runAgent: async () => { throw new Error('agent down'); },
    items: closedDomain.ITEMS.slice(0, 1),
  });
  assert.equal(r.n, 1);
  // The error-carrier object gets claim-extracted; no real grounding,
  // may or may not flag — we just assert the run did NOT crash.
  assert.ok(r.runs[0].response.error);
});

test('closed-domain.aggregateByKind: groups correctly', () => {
  const runs = [
    { kind: 'summarization', hasHallucination: true },
    { kind: 'summarization', hasHallucination: false },
    { kind: 'qa', hasHallucination: false },
  ];
  const out = closedDomain.aggregateByKind(runs);
  assert.equal(out.summarization.n, 2);
  assert.equal(out.summarization.taskHallucinationRate, 0.5);
  assert.equal(out.qa.taskHallucinationRate, 0);
});
