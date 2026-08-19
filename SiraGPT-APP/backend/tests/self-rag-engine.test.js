/**
 * Tests for the full Self-RAG engine (Algorithm 1).
 *
 * We stub the LLM with a scripted client and the retriever with a
 * deterministic async fn. Each test asserts one invariant of the
 * paper: gate decisions, per-passage parallelism, weighted ranking,
 * hard-constraint filtering, citation tracking, or loop termination.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const sre = require('../src/services/rag/self-rag-engine');

function scripted(seq) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      const content = seq[Math.min(i++, seq.length - 1)];
      return { choices: [{ message: { content } }] };
    }}},
  };
}

// ─── critiqueScore (Eq. 3-4 approximation) ───────────────────────────────

test('critiqueScore: fully-supported relevant high-utility maxes out', () => {
  const s = sre.critiqueScore({
    isRel: 'relevant',
    isSup: 'fully_supported',
    isUse: 5,
  }, { wRel: 1, wSup: 1, wUse: 1 });
  assert.equal(s, 3);  // 1 + 1 + 1
});

test('critiqueScore: no_support zeroes the isSup term', () => {
  const withFull = sre.critiqueScore({ isRel: 'relevant', isSup: 'fully_supported', isUse: 3 });
  const withNone = sre.critiqueScore({ isRel: 'relevant', isSup: 'no_support', isUse: 3 });
  assert.ok(withFull > withNone);
});

test('critiqueScore: weights shift ranking', () => {
  const candA = { isRel: 'relevant', isSup: 'partially_supported', isUse: 5 };
  const candB = { isRel: 'relevant', isSup: 'fully_supported', isUse: 2 };
  // Default weights: wRel=1, wSup=1, wUse=0.5 → A=1+0.5+0.5=2.0 vs B=1+1+0.125=2.125. B wins.
  assert.ok(sre.critiqueScore(candB) > sre.critiqueScore(candA));
  // Crank wUse → A should overtake B.
  const sA = sre.critiqueScore(candA, { wRel: 1, wSup: 1, wUse: 5 });
  const sB = sre.critiqueScore(candB, { wRel: 1, wSup: 1, wUse: 5 });
  assert.ok(sA > sB);
});

// ─── rankCandidates: beam + hard constraints ─────────────────────────────

test('rankCandidates: picks the highest S(Critique) candidate', () => {
  const cands = [
    { source: 'a', segment: 'Cand A — partially.', isRel: 'relevant', isSup: 'partially_supported', isUse: 4 },
    { source: 'b', segment: 'Cand B — full.',      isRel: 'relevant', isSup: 'fully_supported',    isUse: 3 },
  ];
  const { best, ranked } = sre.rankCandidates(cands);
  assert.equal(best.source, 'b');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].candidate.source, 'b');
});

test('rankCandidates: hardConstraints drops no_support', () => {
  const cands = [
    { source: 'a', segment: 'A', isRel: 'relevant', isSup: 'no_support',    isUse: 5 },
    { source: 'b', segment: 'B', isRel: 'relevant', isSup: 'fully_supported', isUse: 1 },
  ];
  const { best, filtered } = sre.rankCandidates(cands, { hardConstraints: true });
  assert.equal(best.source, 'b');
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].reason, /no_support/);
});

test('rankCandidates: drops irrelevant under hardConstraints', () => {
  const cands = [
    { source: 'a', segment: 'A', isRel: 'irrelevant', isSup: 'no_support', isUse: 5 },
    { source: 'b', segment: 'B', isRel: 'relevant',   isSup: 'partially_supported', isUse: 3 },
  ];
  const { best, filtered } = sre.rankCandidates(cands, { hardConstraints: true });
  assert.equal(best.source, 'b');
  assert.equal(filtered.length, 1);
});

test('rankCandidates: empty segment always filtered', () => {
  const { best, filtered } = sre.rankCandidates([
    { source: 'a', segment: '', isRel: 'relevant', isSup: 'fully_supported', isUse: 5 },
  ]);
  assert.equal(best, null);
  assert.equal(filtered[0].reason, 'empty segment');
});

test('rankCandidates: everything filtered → best=null', () => {
  const { best } = sre.rankCandidates([
    { source: 'a', segment: '', isRel: 'relevant', isSup: 'fully_supported', isUse: 5 },
  ], { hardConstraints: true });
  assert.equal(best, null);
});

// ─── infer: gate=no path ─────────────────────────────────────────────────

test('infer: retrieve=no → no retriever call, single no-retrieve segment', async () => {
  const openai = scripted([
    // Retrieve gate
    JSON.stringify({ retrieve: 'no', reason: 'general knowledge' }),
    // Segment (done=true → loop exits)
    JSON.stringify({ segment: '2 + 2 equals 4.', isUse: 5, done: true, reason: 'trivial arithmetic' }),
  ]);
  let retrieveCalled = false;
  const retrieve = async () => { retrieveCalled = true; return []; };
  const r = await sre.infer({ openai, input: 'What is 2+2?', retrieve, maxSegments: 3 });
  assert.equal(retrieveCalled, false);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].retrieveDecision, 'no');
  assert.equal(r.segments[0].source, null);
  assert.match(r.answer, /equals 4/);
  assert.equal(r.terminatedBy, 'done');
});

// ─── infer: gate=yes path with ranking ───────────────────────────────────

test('infer: retrieve=yes → per-passage candidates, best by weighted score', async () => {
  const openai = scripted([
    // Gate: yes
    JSON.stringify({ retrieve: 'yes', reason: 'specific fact' }),
    // 2 passage candidates in parallel (order follows Promise.all — map order)
    JSON.stringify({
      isRel: 'relevant', segment: 'The Eiffel Tower was completed in 1889.',
      isSup: 'fully_supported', isUse: 5, reason: 'direct quote',
    }),
    JSON.stringify({
      isRel: 'relevant', segment: 'The Eiffel Tower is in Paris.',
      isSup: 'partially_supported', isUse: 3, reason: 'tangential',
    }),
    // Gate for next step: pretend done
    JSON.stringify({ retrieve: 'no', reason: 'enough' }),
    JSON.stringify({ segment: '', isUse: 1, done: true, reason: '' }),
  ]);
  const retrieve = async () => [
    { source: 'p1', text: 'Passage 1 — completed 1889.' },
    { source: 'p2', text: 'Passage 2 — Paris landmark.' },
  ];
  const r = await sre.infer({
    openai, input: 'When was the Eiffel Tower built?',
    retrieve, k: 2, maxSegments: 2,
  });
  const s0 = r.segments[0];
  assert.equal(s0.retrieveDecision, 'yes');
  assert.equal(s0.source, 'p1');           // higher-score candidate wins
  assert.equal(s0.isSup, 'fully_supported');
  assert.equal(s0.alternatives.length, 1); // p2 listed as alternative
  assert.equal(s0.alternatives[0].source, 'p2');
});

test('infer: retrieveMode=always skips the gate LLM call', async () => {
  const openai = scripted([
    // One candidate (single passage)
    JSON.stringify({
      isRel: 'relevant', segment: 'Forced segment.',
      isSup: 'fully_supported', isUse: 5, reason: '',
    }),
    // Completion no-retrieve
    JSON.stringify({ segment: '', isUse: 1, done: true }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const retrieve = async () => [{ source: 'p', text: 'x' }];
  const r = await sre.infer({
    openai, input: 'q', retrieve, k: 1, retrieveMode: 'always', maxSegments: 1,
  });
  assert.equal(r.segments[0].retrieveDecision, 'yes');
  assert.match(r.segments[0].retrieveReason, /forced/);
});

test('infer: retrieveMode=never → no retrieval calls', async () => {
  const openai = scripted([
    JSON.stringify({ segment: 'No-retrieve answer.', isUse: 5, done: true }),
  ]);
  let called = false;
  const retrieve = async () => { called = true; return []; };
  const r = await sre.infer({
    openai, input: 'q', retrieve, retrieveMode: 'never', maxSegments: 2,
  });
  assert.equal(called, false);
  assert.equal(r.segments[0].retrieveDecision, 'no');
});

// ─── infer: hard constraints + fallback ──────────────────────────────────

test('infer: hardConstraints drops no_support candidate → picks supported', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', reason: '' }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Wrong claim.',
      isSup: 'no_support', isUse: 5, reason: '',
    }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Correct fact.',
      isSup: 'fully_supported', isUse: 3, reason: '',
    }),
    JSON.stringify({ retrieve: 'no', reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const retrieve = async () => [
    { source: 'bad', text: 'b' },
    { source: 'good', text: 'g' },
  ];
  const r = await sre.infer({
    openai, input: 'q', retrieve, k: 2,
    hardConstraints: true, maxSegments: 2,
  });
  assert.equal(r.segments[0].source, 'good');
  assert.equal(r.segments[0].filteredCount, 1);
});

test('infer: all candidates filtered → empty segment + termination', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', reason: '' }),
    JSON.stringify({
      isRel: 'irrelevant', segment: 'junk',
      isSup: 'no_support', isUse: 1, reason: '',
    }),
  ]);
  const retrieve = async () => [{ source: 'p', text: 'x' }];
  const r = await sre.infer({
    openai, input: 'q', retrieve, k: 1,
    hardConstraints: true, maxSegments: 2,
  });
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].text, '');
  assert.equal(r.terminatedBy, 'done');
});

// ─── infer: empty retrieval falls back to no-retrieve ─────────────────────

test('infer: retrieve=yes but no hits → no-retrieve fallback', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', reason: '' }),
    JSON.stringify({ segment: 'I lack sources; making a guess.', isUse: 3, done: true }),
  ]);
  const retrieve = async () => [];
  const r = await sre.infer({ openai, input: 'q', retrieve, maxSegments: 2 });
  assert.equal(r.segments[0].retrieveDecision, 'yes-empty');
  assert.match(r.segments[0].retrieveReason, /no hits/);
});

// ─── infer: max-segments cap ─────────────────────────────────────────────

test('infer: respects maxSegments cap when model never signals done', async () => {
  // Each loop: gate → no; then no-retrieve segment (done=false).
  const openai = {
    chat: { completions: { create: async (args) => {
      const sys = args.messages[0].content;
      if (sys.includes('Retrieve')) {
        return { choices: [{ message: { content: JSON.stringify({ retrieve: 'no', reason: '' }) } }] };
      }
      return { choices: [{ message: { content: JSON.stringify({ segment: 'Sentence.', isUse: 3, done: false }) } }] };
    }}},
  };
  const r = await sre.infer({
    openai, input: 'q', retrieve: async () => [], maxSegments: 3,
  });
  assert.equal(r.segments.length, 3);
  assert.equal(r.terminatedBy, 'max-segments');
});

// ─── Citations propagate ─────────────────────────────────────────────────

test('infer: citations preserved per segment', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', reason: '' }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Claim from source1.',
      isSup: 'fully_supported', isUse: 5, reason: '',
    }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Claim from source2.',
      isSup: 'partially_supported', isUse: 3, reason: '',
    }),
    JSON.stringify({ retrieve: 'no', reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const retrieve = async () => [
    { source: 'paper-1', text: 'T1' },
    { source: 'paper-2', text: 'T2' },
  ];
  const r = await sre.infer({ openai, input: 'q', retrieve, k: 2, maxSegments: 2 });
  assert.equal(r.segments[0].source, 'paper-1');  // winning passage
  // Alternatives track the losers' sources
  assert.equal(r.segments[0].alternatives[0].source, 'paper-2');
});

// ─── Missing dependencies rejected ───────────────────────────────────────

test('infer: null openai rejected', async () => {
  await assert.rejects(
    sre.infer({ openai: null, input: 'q', retrieve: async () => [] }),
    /openai required/,
  );
});

test('infer: missing retrieve fn rejected', async () => {
  await assert.rejects(
    sre.infer({ openai: scripted([]), input: 'q' }),
    /retrieve\(fn\) required/,
  );
});

// ─── Adaptive retrieval threshold (paper §3.3) ───────────────────────────

test('predictRetrieve: threshold flips decision based on confidence', async () => {
  const openai = scripted([JSON.stringify({
    retrieve: 'no', confidence: 0.85, reason: 'borderline',
  })]);
  // Model said "no" with high confidence. Threshold 0.5 should flip
  // it to "yes" because confidence ≥ threshold.
  const r = await sre.predictRetrieve({
    openai, model: 'm',
    input: 'q', partial: '', context: [],
    retrieveThreshold: 0.5,
  });
  assert.equal(r.retrieve, 'yes');
  assert.equal(r.confidence, 0.85);
});

test('predictRetrieve: threshold below confidence keeps "no"', async () => {
  const openai = scripted([JSON.stringify({
    retrieve: 'yes', confidence: 0.3, reason: '',
  })]);
  const r = await sre.predictRetrieve({
    openai, model: 'm',
    input: 'q', partial: '', context: [],
    retrieveThreshold: 0.8,
  });
  assert.equal(r.retrieve, 'no');
});

test('predictRetrieve: "continue" not altered by threshold', async () => {
  const openai = scripted([JSON.stringify({
    retrieve: 'continue', confidence: 0.1, reason: '',
  })]);
  const r = await sre.predictRetrieve({
    openai, model: 'm',
    input: 'q', partial: '', context: [{ text: 'p' }],
    retrieveThreshold: 0.5,
  });
  assert.equal(r.retrieve, 'continue');
});

// ─── Tree-decoding beam search ───────────────────────────────────────────

test('inferBeam: beamSize=1 matches greedy behaviour', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'no', confidence: 0.1, reason: '' }),
    JSON.stringify({ segment: 'Only answer.', isUse: 5, done: true }),
  ]);
  const r = await sre.inferBeam({
    openai, input: 'q', retrieve: async () => [],
    beamSize: 1, maxSegments: 2,
  });
  assert.equal(r.segments.length, 1);
  assert.equal(r.answer, 'Only answer.');
  assert.equal(r.beamSize, 1);
});

test('inferBeam: beamSize=2 keeps two survivors from step 1', async () => {
  const openai = scripted([
    // Step 1 gate: yes
    JSON.stringify({ retrieve: 'yes', confidence: 0.9, reason: '' }),
    // Step 1: two per-passage candidates (different scores)
    JSON.stringify({
      isRel: 'relevant', segment: 'Claim A.',
      isSup: 'fully_supported', isUse: 5, reason: '',
    }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Claim B.',
      isSup: 'partially_supported', isUse: 4, reason: '',
    }),
    // Step 2 gate A + B (each beam)
    JSON.stringify({ retrieve: 'no', confidence: 0.1, reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
    JSON.stringify({ retrieve: 'no', confidence: 0.1, reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const r = await sre.inferBeam({
    openai, input: 'q',
    retrieve: async () => [
      { source: 'a', text: 'TA' },
      { source: 'b', text: 'TB' },
    ],
    k: 2, beamSize: 2, maxSegments: 2,
  });
  // A has higher cumulative score, so it's the winner; B surfaces in
  // alternatives for audit.
  assert.equal(r.answer, 'Claim A.');
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.alternatives[0].answer, 'Claim B.');
});

test('inferBeam: beamSize > K still works (caps to candidates)', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', confidence: 0.9, reason: '' }),
    JSON.stringify({
      isRel: 'relevant', segment: 'Only candidate.',
      isSup: 'fully_supported', isUse: 5, reason: '',
    }),
    JSON.stringify({ retrieve: 'no', confidence: 0.1, reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const r = await sre.inferBeam({
    openai, input: 'q',
    retrieve: async () => [{ source: 'a', text: 'TA' }],
    k: 1, beamSize: 5, maxSegments: 2,
  });
  assert.equal(r.answer, 'Only candidate.');
  assert.equal(r.alternatives.length, 0);   // only 1 survivor possible
});

test('inferBeam: terminatedBy=done when winning beam finishes', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'no', confidence: 0.1, reason: '' }),
    JSON.stringify({ segment: 'Done.', isUse: 5, done: true }),
  ]);
  const r = await sre.inferBeam({
    openai, input: 'q', retrieve: async () => [],
    beamSize: 2, maxSegments: 3,
  });
  assert.equal(r.terminatedBy, 'done');
});

// ─── Paper weight behaviour (wSup boost) ─────────────────────────────────

test('infer: wSup↑ prefers fully-supported even at lower isUse', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: 'yes', reason: '' }),
    // Candidate A: fully supported, utility 2
    JSON.stringify({
      isRel: 'relevant', segment: 'Solid A.',
      isSup: 'fully_supported', isUse: 2, reason: '',
    }),
    // Candidate B: partially supported, utility 5
    JSON.stringify({
      isRel: 'relevant', segment: 'Flashy B.',
      isSup: 'partially_supported', isUse: 5, reason: '',
    }),
    JSON.stringify({ retrieve: 'no', reason: '' }),
    JSON.stringify({ segment: '', isUse: 1, done: true }),
  ]);
  const retrieve = async () => [
    { source: 'a', text: 'A text' },
    { source: 'b', text: 'B text' },
  ];
  const r = await sre.infer({
    openai, input: 'q', retrieve, k: 2, maxSegments: 2,
    weights: { wRel: 1, wSup: 5, wUse: 0.1 },
  });
  assert.equal(r.segments[0].source, 'a', 'wSup↑ → fully-supported A wins');
});
