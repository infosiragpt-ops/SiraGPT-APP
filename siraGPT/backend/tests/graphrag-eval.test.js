/**
 * Tests for GraphRAG evaluation pieces (Edge et al. 2024 §2.4, §2.3):
 *   - eval-criteria: scoreSingle / compareAB / runABSet
 *   - adaptive-benchmark: personas + persona-labeled queries
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

const evalCriteria = require('../src/services/agents/graphrag/eval-criteria');
const adaptiveBench = require('../src/services/agents/graphrag/adaptive-benchmark');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    })}},
  };
}

// ─── eval-criteria: single score ─────────────────────────────────────────

test('eval-criteria: 4 criteria enum', () => {
  assert.deepEqual(evalCriteria.CRITERIA, ['comprehensiveness', 'diversity', 'empowerment', 'directness']);
});

test('eval-criteria.scoreSingle: parses 1-10 scores per criterion', async () => {
  const openai = scripted([JSON.stringify({
    comprehensiveness: 8, diversity: 6, empowerment: 9, directness: 7,
    reasoning: 'solid overall',
  })]);
  const r = await evalCriteria.scoreSingle({
    openai, question: 'What are the themes?', answer: 'T1, T2, T3...',
  });
  assert.equal(r.comprehensiveness, 8);
  assert.equal(r.diversity, 6);
  assert.equal(r.empowerment, 9);
  assert.equal(r.directness, 7);
  // overall = mean
  assert.equal(r.overall, (8 + 6 + 9 + 7) / 4);
});

test('eval-criteria.scoreSingle: clamps out-of-bounds scores', async () => {
  const openai = scripted([JSON.stringify({
    comprehensiveness: 99, diversity: -5, empowerment: 5, directness: 7,
  })]);
  const r = await evalCriteria.scoreSingle({ openai, question: 'q', answer: 'a' });
  assert.equal(r.comprehensiveness, 10);
  assert.equal(r.diversity, 1);
});

test('eval-criteria.scoreSingle: null LLM → neutral fallback', async () => {
  const r = await evalCriteria.scoreSingle({ openai: null, question: 'q', answer: 'a' });
  for (const c of evalCriteria.CRITERIA) assert.equal(r[c], 5);
});

test('eval-criteria.scoreSingle: LLM error → neutral fallback', async () => {
  const openai = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const r = await evalCriteria.scoreSingle({ openai, question: 'q', answer: 'a' });
  assert.equal(r.overall, 5);
  assert.ok(r.reasoning.includes('error'));
});

// ─── eval-criteria: A/B compare ──────────────────────────────────────────

test('eval-criteria.compareAB: picks winner per criterion + overall', async () => {
  const openai = scripted([JSON.stringify({
    comprehensiveness: { winner: 'B', reasoning: 'b covers more' },
    diversity:         { winner: 'A', reasoning: 'a varied' },
    empowerment:       { winner: 'B', reasoning: 'b grounded' },
    directness:        { winner: 'tie', reasoning: 'both direct' },
    overall:           { winner: 'B', reasoning: 'B wins 2/3 decisive' },
  })]);
  const r = await evalCriteria.compareAB({
    openai, question: 'q', answerA: 'a', answerB: 'b',
  });
  assert.equal(r.per_criterion.comprehensiveness, 'B');
  assert.equal(r.per_criterion.diversity, 'A');
  assert.equal(r.per_criterion.directness, 'tie');
  assert.equal(r.overall, 'B');
  assert.equal(r.wins.A, 1);
  assert.equal(r.wins.B, 2);
  assert.equal(r.wins.ties, 1);
});

test('eval-criteria.compareAB: invalid winner values clamp to tie', async () => {
  const openai = scripted([JSON.stringify({
    comprehensiveness: { winner: 'maybe' },
    diversity:         { winner: 'A' },
    empowerment:       { winner: 'C' },
    directness:        { winner: 'B' },
  })]);
  const r = await evalCriteria.compareAB({ openai, question: 'q', answerA: 'a', answerB: 'b' });
  assert.equal(r.per_criterion.comprehensiveness, 'tie');
  assert.equal(r.per_criterion.empowerment, 'tie');
});

test('eval-criteria.compareAB: null LLM → all ties', async () => {
  const r = await evalCriteria.compareAB({
    openai: null, question: 'q', answerA: 'a', answerB: 'b',
  });
  assert.equal(r.wins.ties, 4);
  assert.equal(r.overall, 'tie');
});

test('eval-criteria.compareAB: missing overall infers from per-criterion tally', async () => {
  const openai = scripted([JSON.stringify({
    comprehensiveness: { winner: 'A' },
    diversity:         { winner: 'A' },
    empowerment:       { winner: 'A' },
    directness:        { winner: 'B' },
    // No overall key.
  })]);
  const r = await evalCriteria.compareAB({ openai, question: 'q', answerA: 'a', answerB: 'b' });
  // A wins 3/4 → inferred overall should be A.
  assert.equal(r.overall, 'A');
});

// ─── eval-criteria: batch A/B ───────────────────────────────────────────

test('eval-criteria.runABSet: aggregates winrates per criterion', async () => {
  // 2 examples, both favor B on comprehensiveness, split otherwise.
  const responses = [
    JSON.stringify({
      comprehensiveness: { winner: 'B' },
      diversity: { winner: 'A' },
      empowerment: { winner: 'tie' },
      directness: { winner: 'B' },
      overall: { winner: 'B' },
    }),
    JSON.stringify({
      comprehensiveness: { winner: 'B' },
      diversity: { winner: 'B' },
      empowerment: { winner: 'A' },
      directness: { winner: 'tie' },
      overall: { winner: 'B' },
    }),
  ];
  const openai = scripted(responses);
  const r = await evalCriteria.runABSet({
    openai,
    examples: [
      { id: '1', question: 'q1', answerA: 'a1', answerB: 'b1' },
      { id: '2', question: 'q2', answerA: 'a2', answerB: 'b2' },
    ],
  });
  assert.equal(r.n, 2);
  // B won both comprehensiveness → A_winrate 0, B_winrate 1
  assert.equal(r.per_criterion_winrates.comprehensiveness.B_wins, 2);
  assert.equal(r.per_criterion_winrates.comprehensiveness.A_winrate, 0);
  assert.equal(r.per_criterion_winrates.comprehensiveness.B_winrate, 1);
  // overall B won both
  assert.equal(r.overall_winrates.B_wins, 2);
});

test('eval-criteria.runABSet: empty examples returns empty shape', async () => {
  const r = await evalCriteria.runABSet({ openai: scripted([]), examples: [] });
  assert.equal(r.n, 0);
  assert.deepEqual(r.verdicts, []);
});

// ─── adaptive-benchmark: personas ────────────────────────────────────────

test('adaptive-benchmark.generatePersonas: parses diverse personas', async () => {
  const openai = scripted([JSON.stringify({
    personas: [
      { role: 'PM', goal: 'track product themes', background: 'SaaS' },
      { role: 'Engineer', goal: 'find perf patterns', background: 'infra' },
      { role: 'Support', goal: 'see common issues', background: 'customer-facing' },
    ],
  })]);
  const r = await adaptiveBench.generatePersonas({
    openai, corpusDescription: 'support ticket logs', n: 3,
  });
  assert.equal(r.length, 3);
  assert.ok(r.every(p => p.role && p.goal));
});

test('adaptive-benchmark.generatePersonas: clamps to n limit', async () => {
  const openai = scripted([JSON.stringify({
    personas: Array.from({ length: 10 }, (_, i) => ({ role: `R${i}`, goal: `G${i}` })),
  })]);
  const r = await adaptiveBench.generatePersonas({
    openai, corpusDescription: 'd', n: 3,
  });
  assert.equal(r.length, 3);
});

test('adaptive-benchmark.generatePersonas: null LLM returns []', async () => {
  const r = await adaptiveBench.generatePersonas({
    openai: null, corpusDescription: 'd',
  });
  assert.deepEqual(r, []);
});

test('adaptive-benchmark.generatePersonas: filters personas missing required fields', async () => {
  const openai = scripted([JSON.stringify({
    personas: [
      { role: 'OK', goal: 'ok goal' },
      { role: 'missing goal' },          // dropped
      { goal: 'missing role' },          // dropped
      null,                                // dropped
    ],
  })]);
  const r = await adaptiveBench.generatePersonas({ openai, corpusDescription: 'd' });
  assert.equal(r.length, 1);
});

// ─── adaptive-benchmark: queries ─────────────────────────────────────────

test('adaptive-benchmark.generateQueriesForPersona: parses question list', async () => {
  const openai = scripted([JSON.stringify({
    questions: [
      'What themes recur in user complaints?',
      'Which feature requests are trending?',
      'What gaps exist in our onboarding flow?',
    ],
  })]);
  const r = await adaptiveBench.generateQueriesForPersona({
    openai, corpusDescription: 'c',
    persona: { role: 'PM', goal: 'track issues' }, m: 3,
  });
  assert.equal(r.length, 3);
  assert.ok(r.every(q => typeof q === 'string' && q.length > 0));
});

test('adaptive-benchmark.generateQueriesForPersona: no persona → []', async () => {
  const r = await adaptiveBench.generateQueriesForPersona({
    openai: scripted([]), corpusDescription: 'c', persona: {},
  });
  assert.deepEqual(r, []);
});

// ─── adaptive-benchmark: full pipeline ──────────────────────────────────

test('adaptive-benchmark.generate: end-to-end persona + queries', async () => {
  const openai = scripted([
    // personas call
    JSON.stringify({ personas: [
      { role: 'PM', goal: 'themes', background: 'b' },
      { role: 'Eng', goal: 'patterns', background: 'b' },
    ]}),
    // queries for PM
    JSON.stringify({ questions: ['q1', 'q2'] }),
    // queries for Eng
    JSON.stringify({ questions: ['q3', 'q4', 'q5'] }),
  ]);
  const r = await adaptiveBench.generate({
    openai,
    corpusDescription: 'ticket logs',
    nPersonas: 2,
    queriesPerPersona: 3,
  });
  assert.equal(r.n_personas, 2);
  assert.equal(r.n_queries, 5); // 2 + 3
  assert.ok(r.queries.every(q => typeof q.persona_idx === 'number' && q.question));
  // queries labeled with persona index
  assert.equal(r.queries[0].role, 'PM');
  assert.equal(r.queries[2].role, 'Eng');
});

test('adaptive-benchmark.generate: no personas → zero queries', async () => {
  const openai = scripted([JSON.stringify({ personas: [] })]);
  const r = await adaptiveBench.generate({
    openai, corpusDescription: 'd',
  });
  assert.equal(r.n_personas, 0);
  assert.equal(r.n_queries, 0);
});

test('adaptive-benchmark.generate: defaults apply', async () => {
  // Assertions about defaults without stubbing responses for the full
  // call chain — just verify the exported constants match expectation.
  assert.equal(adaptiveBench.DEFAULT_N_PERSONAS, 5);
  assert.equal(adaptiveBench.DEFAULT_QUERIES_PER_PERSONA, 3);
});
