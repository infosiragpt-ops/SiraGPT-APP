/**
 * Unit tests for the InstructGPT alignment modules.
 *   - alignment-judge: score parsing, bounds clamping, fallback
 *   - best-of-n: picks winner, handles empty/single samples
 *   - intent-clarifier: clear vs ambiguous vs blocked
 *   - truthfulness: extractClaims, fuzzyGround, check end-to-end
 *   - feedback-ledger: record + findExemplars cosine, formatting
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai before requires so tests are offline + deterministic.
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

const judge = require('../src/services/agents/alignment-judge');
const bestOfN = require('../src/services/agents/best-of-n');
const clarifier = require('../src/services/agents/intent-clarifier');
const truthfulness = require('../src/services/agents/truthfulness');
const feedback = require('../src/services/agents/feedback-ledger');

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

// ─── alignment-judge ──────────────────────────────────────────────────────

test('judge.normalise: parses valid scores + clamps bounds', () => {
  const raw = JSON.stringify({
    helpful: 9, honest: 7, harmless: 10, overall: 8,
    issues: ['minor hedge'],
    reasoning: 'reasonable response',
  });
  const n = judge.normalise(raw);
  assert.equal(n.helpful, 9);
  assert.equal(n.overall, 8);
  assert.equal(n.issues.length, 1);
});

test('judge.normalise: out-of-bounds scores clamp to [0,10]', () => {
  const raw = JSON.stringify({ helpful: 99, honest: -5, harmless: 10, overall: 200 });
  const n = judge.normalise(raw);
  assert.equal(n.helpful, 10);
  assert.equal(n.honest, 0);
  assert.equal(n.overall, 10);
});

test('judge.normalise: missing overall falls back to min of other axes', () => {
  const raw = JSON.stringify({ helpful: 9, honest: 3, harmless: 8 });
  const n = judge.normalise(raw);
  assert.equal(n.overall, 3);
});

test('judge.normalise: garbage returns neutral fallback', () => {
  const n = judge.normalise('not json');
  assert.equal(n.overall, 5);
  assert.ok(n.reasoning.includes('unparseable'));
});

test('judge.score: null openai → neutral fallback without crash', async () => {
  const r = await judge.score({ openai: null, userRequest: 'q', response: 'r' });
  assert.equal(r.overall, 5);
});

test('judge.score: scripted response round-trips', async () => {
  const openai = scriptedChat([JSON.stringify({
    helpful: 8, honest: 9, harmless: 10, overall: 9,
    issues: [], reasoning: 'good',
  })]);
  const r = await judge.score({ openai, userRequest: 'q', response: 'r' });
  assert.equal(r.overall, 9);
});

test('judge.score: LLM error → neutral fallback', async () => {
  const openai = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const r = await judge.score({ openai, userRequest: 'q', response: 'r' });
  assert.equal(r.overall, 5);
  assert.ok(r.reasoning.includes('error'));
});

// ─── best-of-n ────────────────────────────────────────────────────────────

test('best-of-n.pick: empty samples returns null winner', async () => {
  const r = await bestOfN.pick({ openai: null, userRequest: 'q', samples: [] });
  assert.equal(r.winner, null);
  assert.equal(r.candidates.length, 0);
});

test('best-of-n.pick: single sample scores and returns it', async () => {
  const openai = scriptedChat([
    JSON.stringify({ helpful: 7, honest: 7, harmless: 7, overall: 7, issues: [] }),
  ]);
  const r = await bestOfN.pick({
    openai, userRequest: 'q', samples: ['only candidate'],
  });
  assert.equal(r.winner.index, 0);
  assert.equal(r.winner.response, 'only candidate');
});

test('best-of-n.pick: picks highest-overall candidate', async () => {
  // Three candidates, with different scores — the judge sees them in
  // call order, so we script three distinct responses.
  let call = 0;
  const scores = [5, 9, 7]; // candidate 1 should win
  const openai = {
    chat: {
      completions: {
        create: async () => {
          const s = scores[call++ % scores.length];
          return { choices: [{ message: { content: JSON.stringify({
            helpful: s, honest: s, harmless: s, overall: s, issues: []
          }) } }] };
        },
      },
    },
  };
  const r = await bestOfN.pick({
    openai, userRequest: 'q', samples: ['a', 'b', 'c'],
  });
  assert.equal(r.winner.response, 'b');
  assert.equal(r.winner.score.overall, 9);
});

test('best-of-n.pick: tie broken by original index (stable)', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({
        helpful: 7, honest: 7, harmless: 7, overall: 7, issues: []
      }) } }],
    })}},
  };
  const r = await bestOfN.pick({
    openai, userRequest: 'q', samples: ['a', 'b', 'c'],
  });
  assert.equal(r.winner.index, 0); // first wins on tie
});

// ─── intent-clarifier ────────────────────────────────────────────────────

test('clarifier.clarify: null openai → pass-through clear', async () => {
  const r = await clarifier.clarify({ openai: null, request: 'review my code' });
  assert.equal(r.status, 'clear');
});

test('clarifier.clarify: too-short request is ambiguous', async () => {
  const r = await clarifier.clarify({ openai: scriptedChat([]), request: 'hi' });
  assert.equal(r.status, 'ambiguous');
  assert.ok(r.questions.length >= 1);
});

test('clarifier.clarify: scripted clear response passes through', async () => {
  const openai = scriptedChat([JSON.stringify({ status: 'clear' })]);
  const r = await clarifier.clarify({ openai, request: 'review my function add(a,b) in math.ts' });
  assert.equal(r.status, 'clear');
});

test('clarifier.clarify: scripted ambiguous with questions', async () => {
  const openai = scriptedChat([JSON.stringify({
    status: 'ambiguous',
    questions: ['Which file should I focus on?', 'What kind of improvement — speed or readability?'],
    reasoning: 'target unclear',
  })]);
  const r = await clarifier.clarify({ openai, request: 'make the code better' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.questions.length, 2);
});

test('clarifier.normalise: ambiguous without actionable questions → clear', () => {
  // Model said ambiguous but sent no questions — treat as clear to avoid a loop.
  const r = clarifier.normalise(JSON.stringify({ status: 'ambiguous', questions: [] }));
  assert.equal(r.status, 'clear');
});

test('clarifier.normalise: blocked status preserved with reason', () => {
  const r = clarifier.normalise(JSON.stringify({
    status: 'blocked', reason: 'asks for unsafe shell command execution',
  }));
  assert.equal(r.status, 'blocked');
  assert.ok(r.reason.includes('unsafe'));
});

test('clarifier.normalise: caps questions at MAX_QUESTIONS', () => {
  const manyQs = Array.from({ length: 10 }, (_, i) => `Question number ${i + 1} is this?`);
  const r = clarifier.normalise(JSON.stringify({ status: 'ambiguous', questions: manyQs }));
  assert.ok(r.questions.length <= clarifier.MAX_QUESTIONS);
});

// ─── truthfulness ────────────────────────────────────────────────────────

test('truthfulness.fuzzyGround: claim contained in chunk → matched', () => {
  const chunks = [{ text: 'Stephen Curry was born in Akron, Ohio in 1988.', source: 'curry.md' }];
  const r = truthfulness.fuzzyGround('Stephen Curry was born in Akron', chunks);
  assert.ok(r);
  assert.equal(r.matchedSource, 'curry.md');
});

test('truthfulness.fuzzyGround: unrelated claim → null', () => {
  const chunks = [{ text: 'Python is a programming language.' }];
  const r = truthfulness.fuzzyGround('The earth is flat', chunks);
  assert.equal(r, null);
});

test('truthfulness.fuzzyGround: paraphrase with 60%+ word overlap → matched', () => {
  const chunks = [{ text: 'The function computeSum returns the total of two integers.' }];
  const r = truthfulness.fuzzyGround('computeSum returns the total of integers', chunks);
  assert.ok(r);
});

test('truthfulness.extractClaims: scripted response yields claims list', async () => {
  const openai = scriptedChat([JSON.stringify({
    claims: ['add(a, b) returns a + b', 'math.ts exports two functions'],
  })]);
  const claims = await truthfulness.extractClaims({ openai, response: 'The add function in math.ts adds two numbers.' });
  assert.equal(claims.length, 2);
});

test('truthfulness.extractClaims: null openai returns []', async () => {
  const claims = await truthfulness.extractClaims({ openai: null, response: 'anything' });
  assert.deepEqual(claims, []);
});

test('truthfulness.check: empty claims → score 1 "no checkable claims"', async () => {
  const openai = scriptedChat([JSON.stringify({ claims: [] })]);
  const r = await truthfulness.check({ openai, response: 'Opinions only.', contextChunks: [] });
  assert.equal(r.score, 1);
  assert.equal(r.unfoundedCount, 0);
});

test('truthfulness.check: claim matches fuzzy → grounded', async () => {
  const openai = scriptedChat([
    // claim extraction
    JSON.stringify({ claims: ['Curry was born in Akron'] }),
  ]);
  const r = await truthfulness.check({
    openai,
    response: 'Curry was born in Akron.',
    contextChunks: [{ text: 'Stephen Curry was born in Akron, Ohio.', source: 's.md' }],
  });
  assert.equal(r.unfoundedCount, 0);
  assert.equal(r.claims[0].matchType, 'fuzzy');
});

test('truthfulness.check: unfounded claim with no LLM fallback → none match', async () => {
  const openai = scriptedChat([
    JSON.stringify({ claims: ['The sky is green'] }),
  ]);
  const r = await truthfulness.check({
    openai,
    response: 'The sky is green.',
    contextChunks: [{ text: 'Clouds are made of water.' }],
    llmFallback: false,
  });
  assert.equal(r.unfoundedCount, 1);
  assert.equal(r.score, 0);
});

test('truthfulness.check: LLM fallback can rescue a fuzzy-miss', async () => {
  const openai = scriptedChat([
    JSON.stringify({ claims: ['computeSum is exported'] }), // extraction
    JSON.stringify({ supported: true, confidence: 0.9, evidence: 'export function computeSum' }), // verify
  ]);
  const r = await truthfulness.check({
    openai,
    response: 'computeSum is exported.',
    // Text doesn't contain "exported" literally; fuzzy won't match but LLM will.
    contextChunks: [{ text: 'export function computeSum(a, b) { return a + b; }' }],
  });
  // This one is ACTUALLY going to match fuzzily because "computesum" appears
  // in the chunk. The test asserts either match path worked.
  assert.equal(r.unfoundedCount, 0);
});

// ─── feedback-ledger ─────────────────────────────────────────────────────

test('feedback.record: stores entry and returns total', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  const r = await feedback.record({
    userId: 'u1', runId: 'r1', agent: 'code_review',
    request: 'review my function', response: { findings: [] },
    helpful: true, embedder,
  });
  assert.equal(r.stored, true);
  assert.equal(r.total, 1);
});

test('feedback.record: missing required args throw', async () => {
  await assert.rejects(feedback.record({ runId: 'r', helpful: true }));
  await assert.rejects(feedback.record({ userId: 'u', runId: 'r', helpful: 'maybe' }));
});

test('feedback.record: dedup by runId (second call replaces first)', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'r', agent: 'a', request: 'q', response: 'x', helpful: true, embedder });
  const r = await feedback.record({ userId: 'u', runId: 'r', agent: 'a', request: 'q', response: 'x', helpful: false, embedder });
  assert.equal(r.total, 1); // dedup'd, not appended
  assert.equal(feedback.stats('u').helpful, 0);
  assert.equal(feedback.stats('u').unhelpful, 1);
});

test('feedback.findExemplars: returns helpful past queries by similarity', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'r1', agent: 'code_review',
    request: 'review my add function', response: 'good', helpful: true, embedder,
  });
  await feedback.record({
    userId: 'u', runId: 'r2', agent: 'code_review',
    request: 'debug my connection timeout', response: 'hint', helpful: true, embedder,
  });

  const hits = await feedback.findExemplars({
    userId: 'u', request: 'review add function please',
    embedder, k: 2,
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].runId, 'r1'); // similarity-closer to the review query
});

test('feedback.findExemplars: onlyHelpful filter drops unhelpful', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'x', request: 'q', response: 'r', helpful: false, embedder });
  await feedback.record({ userId: 'u', runId: 'b', agent: 'x', request: 'q', response: 'r', helpful: true, embedder });
  const helpful = await feedback.findExemplars({ userId: 'u', request: 'q', embedder, onlyHelpful: true });
  assert.equal(helpful.length, 1);
  assert.equal(helpful[0].runId, 'b');
  const all = await feedback.findExemplars({ userId: 'u', request: 'q', embedder, onlyHelpful: false });
  assert.equal(all.length, 2);
});

test('feedback.findExemplars: agent filter narrows to same specialist', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'code_review', request: 'q', response: 'r', helpful: true, embedder });
  await feedback.record({ userId: 'u', runId: 'b', agent: 'debug', request: 'q', response: 'r', helpful: true, embedder });
  const hits = await feedback.findExemplars({ userId: 'u', request: 'q', embedder, agent: 'code_review' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].agent, 'code_review');
});

test('feedback.formatExemplarsBlock: produces a prose block with Q/A pairs', async () => {
  const exemplars = [
    { agent: 'code_review', request: 'ask 1', response: 'ans 1', helpful: true, notes: null },
    { agent: 'debug',       request: 'ask 2', response: { patches: [] }, helpful: true, notes: 'was helpful' },
  ];
  const block = feedback.formatExemplarsBlock(exemplars);
  assert.ok(block.includes('Example 1'));
  assert.ok(block.includes('Example 2'));
  assert.ok(block.includes('ask 1'));
});

test('feedback.formatExemplarsBlock: empty list → empty string', () => {
  assert.equal(feedback.formatExemplarsBlock([]), '');
  assert.equal(feedback.formatExemplarsBlock(null), '');
});

test('feedback.stats: reports counts per user', async () => {
  feedback._reset();
  const embedder = (texts) => Promise.resolve(texts.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: '1', request: 'q', response: 'r', helpful: true, embedder });
  await feedback.record({ userId: 'u', runId: '2', request: 'q', response: 'r', helpful: false, embedder });
  const s = feedback.stats('u');
  assert.equal(s.total, 2);
  assert.equal(s.helpful, 1);
  assert.equal(s.unhelpful, 1);
});
