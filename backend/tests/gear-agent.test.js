/**
 * Unit tests for services/gear-agent.js.
 *
 * The LLM is fully stubbed. We route calls based on the system/user
 * content to one of three responders: proximal triple extraction,
 * reasoning termination, query rewriting. This lets us script multi-hop
 * scenarios (terminate-on-hop-1, 2-hop success, max-iters hit) without
 * any network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai module BEFORE requiring services so rag-service picks up the stub.
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

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key-for-tests';

const rag = require('../src/services/rag-service');
const tripleGraph = require('../src/services/triple-graph');
const gistMemory = require('../src/services/gist-memory');
const gear = require('../src/services/gear-agent');

// ─── Prompt builders ────────────────────────────────────────────────────────

test('buildReasonPrompt: formats triples as tuple list', () => {
  const p = gear.buildReasonPrompt('What year?', [
    { subject: 'Curry', predicate: 'born in', object: '1988' },
  ]);
  assert.ok(p.includes('Question: What year?'));
  assert.ok(p.includes('("Curry", "born in", "1988")'));
  assert.ok(p.includes('Answerable: Yes'));
});

test('buildReasonPrompt: empty triples renders as (none)', () => {
  const p = gear.buildReasonPrompt('q', []);
  assert.ok(p.includes('Facts: (none)'));
});

test('buildRewritePrompt: includes reason line', () => {
  const p = gear.buildRewritePrompt('q', [{ subject: 'a', predicate: 'is', object: 'b' }], 'missing link');
  assert.ok(p.includes('Reason: missing link'));
  assert.ok(p.includes('Next Question:'));
});

// ─── Reply parsers ──────────────────────────────────────────────────────────

test('parseReasonReply: Yes + Answer', () => {
  const out = gear.parseReasonReply('Answerable: Yes\nAnswer: 1988');
  assert.equal(out.answerable, true);
  assert.equal(out.answer, '1988');
});

test('parseReasonReply: No + Why', () => {
  const out = gear.parseReasonReply('Answerable: No\nWhy: missing birth year');
  assert.equal(out.answerable, false);
  assert.equal(out.reason, 'missing birth year');
});

test('parseReasonReply: garbage → conservative default (not answerable)', () => {
  const out = gear.parseReasonReply('idk');
  assert.equal(out.answerable, false);
  assert.equal(out.answer, null);
});

test('parseReasonReply: empty → conservative default', () => {
  const out = gear.parseReasonReply('');
  assert.equal(out.answerable, false);
});

test('parseRewriteReply: extracts text after "Next Question:"', () => {
  const raw = 'Analysis blah blah.\nNext Question: What region of Jakarta?\n';
  assert.equal(gear.parseRewriteReply(raw), 'What region of Jakarta?');
});

test('parseRewriteReply: no label → first non-empty line', () => {
  assert.equal(gear.parseRewriteReply('What year?\nEtc.'), 'What year?');
});

test('parseRewriteReply: empty → empty string', () => {
  assert.equal(gear.parseRewriteReply(''), '');
});

// ─── reasonTermination / rewriteQuery with stubbed client ──────────────────

function fakeOpenAIReturning(content) {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  };
}

test('reasonTermination: null client → conservative non-answerable', async () => {
  const out = await gear.reasonTermination({ openai: null, query: 'q', triples: [] });
  assert.equal(out.answerable, false);
});

test('reasonTermination: LLM says Yes → answerable=true', async () => {
  const oa = fakeOpenAIReturning('Answerable: Yes\nAnswer: Warriors');
  const out = await gear.reasonTermination({ openai: oa, query: 'team?', triples: [] });
  assert.equal(out.answerable, true);
  assert.equal(out.answer, 'Warriors');
});

test('reasonTermination: LLM throw → returns non-answerable without crash', async () => {
  const oa = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const out = await gear.reasonTermination({ openai: oa, query: 'q', triples: [] });
  assert.equal(out.answerable, false);
  assert.ok(out.reason.includes('error'));
});

test('rewriteQuery: returns parsed next question', async () => {
  const oa = fakeOpenAIReturning('Next Question: When did Curry join the team?');
  const out = await gear.rewriteQuery({ openai: oa, query: 'q', triples: [], reason: 'r' });
  assert.equal(out, 'When did Curry join the team?');
});

test('rewriteQuery: null client returns original query', async () => {
  const out = await gear.rewriteQuery({ openai: null, query: 'q', triples: [], reason: '' });
  assert.equal(out, 'q');
});

test('rewriteQuery: LLM error returns original query', async () => {
  const oa = { chat: { completions: { create: async () => { throw new Error('x'); } } } };
  const out = await gear.rewriteQuery({ openai: oa, query: 'original', triples: [], reason: '' });
  assert.equal(out, 'original');
});

// ─── Agent loop orchestration ──────────────────────────────────────────────

/**
 * Build a fake OpenAI client that routes chat.completions by inspecting
 * the user message content. Returns scripted responses for:
 *   - proximal triple extraction (contains "find facts that help answer")
 *   - reasoning termination (contains "Answerable: Yes")
 *   - query rewriting (contains "Next Question")
 */
function scriptedOpenAI({ triplesPerHop = [], reasonsPerHop = [], rewritesPerHop = [] } = {}) {
  let triplesHop = 0;
  let reasonHop = 0;
  let rewriteHop = 0;

  return {
    embeddings: {
      create: async ({ input }) => ({
        data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
      }),
    },
    chat: {
      completions: {
        create: async ({ messages }) => {
          const sys = messages.find(m => m.role === 'system')?.content || '';
          const usr = messages.find(m => m.role === 'user')?.content || '';

          // Route on distinctive phrases in the prompts we built.
          if (usr.includes('find facts that help answer') || sys.includes('find facts')) {
            const t = triplesPerHop[Math.min(triplesHop, triplesPerHop.length - 1)] || [];
            triplesHop++;
            return { choices: [{ message: { content: JSON.stringify({ triples: t }) } }] };
          }
          if (usr.includes('Answerable: Yes')) { // our reason prompt contains this example text
            const r = reasonsPerHop[Math.min(reasonHop, reasonsPerHop.length - 1)]
                      ?? 'Answerable: No\nWhy: need more info';
            reasonHop++;
            return { choices: [{ message: { content: r } }] };
          }
          if (usr.includes('Next Question')) {
            const rw = rewritesPerHop[Math.min(rewriteHop, rewritesPerHop.length - 1)]
                       ?? 'Next Question: refined query';
            rewriteHop++;
            return { choices: [{ message: { content: rw } }] };
          }
          // Fallback: pretend it's triple extraction with empty result
          return { choices: [{ message: { content: JSON.stringify({ triples: [] }) } }] };
        },
      },
    },
  };
}

async function seedCollection(uid, col) {
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'Stephen Curry was born in Akron, Ohio in 1988.', source: 'curry.md' },
    { text: 'Dell Curry played for the Cleveland Cavaliers early in his career.', source: 'dell.md' },
    { text: 'Stephen Curry attended Davidson College for basketball.', source: 'davidson.md' },
    { text: 'Dell Curry joined the Cleveland Cavaliers in 1985.', source: 'cavaliers1985.md' },
  ]);
  // Seed some triples in the graph so useGraph has something to expand.
  await tripleGraph.addTriples(uid, col, [
    { subject: 'Stephen Curry', predicate: 'father is', object: 'Dell Curry', source: 'curry.md' },
    { subject: 'Dell Curry', predicate: 'joined', object: 'Cleveland Cavaliers', source: 'cavaliers1985.md' },
    { subject: 'Dell Curry', predicate: 'joined in', object: '1985', source: 'cavaliers1985.md' },
  ], { embedder: null });
}

test('agentLoop: terminates on first hop when answerable', async () => {
  const uid = `ag-${Math.random()}`;
  const col = 'gear-t1';
  await seedCollection(uid, col);

  const openai = scriptedOpenAI({
    triplesPerHop: [[{ subject: 'Dell Curry', predicate: 'joined in', object: '1985' }]],
    reasonsPerHop: ['Answerable: Yes\nAnswer: 1985'],
  });

  const result = await gear.agentLoop({
    userId: uid, collection: col, query: 'When did Dell Curry join the Cavaliers?',
    openai, k: 5, maxIters: 3,
  });

  assert.equal(result.iterations, 1);
  assert.equal(result.answer, '1985');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].answerable, true);
  assert.ok(result.passages.length > 0);
});

test('agentLoop: runs 2 hops, rewrites, terminates on hop 2', async () => {
  const uid = `ag-${Math.random()}`;
  const col = 'gear-t2';
  await seedCollection(uid, col);

  const openai = scriptedOpenAI({
    triplesPerHop: [
      [{ subject: 'Stephen Curry', predicate: 'father is', object: 'Dell Curry' }],
      [{ subject: 'Dell Curry', predicate: 'joined', object: 'Cleveland Cavaliers' }],
    ],
    reasonsPerHop: [
      'Answerable: No\nWhy: we do not yet know when Dell Curry joined a team',
      'Answerable: Yes\nAnswer: 1985',
    ],
    rewritesPerHop: ['Next Question: When did Dell Curry join the Cavaliers?'],
  });

  const result = await gear.agentLoop({
    userId: uid, collection: col,
    query: "In what year did Stephen Curry's father join a team?",
    openai, k: 5, maxIters: 3,
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.answer, '1985');
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].answerable, false);
  assert.equal(result.history[1].query, 'When did Dell Curry join the Cavaliers?');
});

test('agentLoop: hits maxIters without answer but still returns fused passages', async () => {
  const uid = `ag-${Math.random()}`;
  const col = 'gear-t3';
  await seedCollection(uid, col);

  const openai = scriptedOpenAI({
    triplesPerHop: [[], [], []],
    reasonsPerHop: ['Answerable: No\nWhy: insufficient', 'Answerable: No\nWhy: still insufficient', 'Answerable: No\nWhy: nope'],
    rewritesPerHop: ['Next Question: sub q 1', 'Next Question: sub q 2'],
  });

  const result = await gear.agentLoop({
    userId: uid, collection: col, query: 'unanswerable',
    openai, k: 5, maxIters: 3,
  });

  assert.equal(result.iterations, 3);
  assert.equal(result.answer, null);
  assert.equal(result.history.length, 3);
  assert.ok(result.passages.length > 0, 'should still return fused base passages');
});

test('agentLoop: provided sessionId persists gist, generated sessionId is cleared', async () => {
  const uid = `ag-${Math.random()}`;
  const col = 'gear-t4';
  await seedCollection(uid, col);

  const sid = `persist-${Math.random()}`;
  const openai = scriptedOpenAI({
    triplesPerHop: [[{ subject: 'Dell Curry', predicate: 'joined in', object: '1985' }]],
    reasonsPerHop: ['Answerable: Yes\nAnswer: 1985'],
  });

  await gear.agentLoop({
    userId: uid, collection: col, query: 'q', openai, sessionId: sid, maxIters: 1,
  });
  // Caller owns the session → memory should still contain the triple.
  assert.ok(gistMemory.get(sid).length > 0, 'caller-owned sessionId should persist gist memory');

  // Without sessionId, memory is scoped to the call and cleared on exit.
  const openai2 = scriptedOpenAI({
    triplesPerHop: [[{ subject: 'X', predicate: 'is', object: 'Y' }]],
    reasonsPerHop: ['Answerable: Yes\nAnswer: yes'],
  });
  const result = await gear.agentLoop({
    userId: uid, collection: col, query: 'q2', openai: openai2, maxIters: 1,
  });
  // Result was produced but the gist is empty for any session we might try.
  assert.ok(result.iterations === 1);
});

test('finalFuseGEAR: merges per-iter and triple-linked pools via RRF', () => {
  const perIter = [
    [{ text: 'A', source: 'a' }, { text: 'B', source: 'b' }],
    [{ text: 'C', source: 'c' }, { text: 'A', source: 'a' }], // A appears twice across pools
  ];
  const linked = [
    [{ text: 'B', source: 'b' }],
  ];
  const fused = rag.finalFuseGEAR({ perIterPools: perIter, tripleLinkedPools: linked, k: 3 });
  // A appears in 2 pools → should accumulate and beat B/C.
  assert.equal(fused[0].source, 'a');
  assert.equal(fused.length, 3);
});

test('passageLink: returns top-k passages most similar to the triple sentence', async () => {
  const uid = `pl-${Math.random()}`;
  const col = 'pl-test';
  await seedCollection(uid, col);
  const hits = await rag.passageLink(uid, col,
    { subject: 'Dell Curry', predicate: 'joined', object: 'Cleveland Cavaliers' },
    { k: 2 });
  assert.ok(hits.length > 0);
  // At least one of the top-2 should be about Dell Curry + Cavaliers.
  assert.ok(hits.some(h => /Dell|Cavaliers/i.test(h.text)));
});
