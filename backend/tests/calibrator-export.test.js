/**
 * Tests for response-calibrator and preference-export.
 * Addresses the specific InstructGPT failure modes we hadn't covered.
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

const calibrator = require('../src/services/agents/response-calibrator');
const preferenceExport = require('../src/services/agents/preference-export');
const feedback = require('../src/services/agents/feedback-ledger');

// ─── Calibrator: hedging ──────────────────────────────────────────────────

test('calibrator.scanHedging: direct Q with 2+ hedges → flagged', () => {
  const r = calibrator.scanHedging(
    'What year did Einstein win the Nobel Prize?',
    "I'm not sure exactly, but it depends on which Nobel Prize you mean. As an AI, I cannot say for certain, but maybe 1921.",
  );
  assert.equal(r.flagged, true);
  assert.ok(r.count >= 2);
});

test('calibrator.scanHedging: long answer with one hedge → not flagged', () => {
  const r = calibrator.scanHedging(
    'Explain REST architecture.',
    'REST is an architectural style. ' + 'It uses HTTP methods. '.repeat(40) + 'However, many systems exist.',
  );
  assert.equal(r.flagged, false);
});

test('calibrator.scanHedging: clean short direct answer → not flagged', () => {
  const r = calibrator.scanHedging('What is 2+2?', 'Four.');
  assert.equal(r.flagged, false);
  assert.equal(r.count, 0);
});

test('calibrator.scanHedging: "as an AI" phrase triggers flag', () => {
  const r = calibrator.scanHedging(
    'Which is faster, quicksort or mergesort?',
    "As an AI, I don't have opinions, but it depends on input size.",
  );
  assert.ok(r.count >= 2);
});

// ─── Calibrator: refusal ──────────────────────────────────────────────────

test('calibrator.scanRefusal: short refusal returns strongSignal=true', () => {
  const r = calibrator.scanRefusal("I can't help with that request.");
  assert.equal(r.refused, true);
  assert.equal(r.strongSignal, true);
});

test('calibrator.scanRefusal: long mostly-content response with refusal phrase → not strongSignal', () => {
  const r = calibrator.scanRefusal(
    "The function signature is foo(x). " + "Here's the docs. ".repeat(50) + "I cannot provide legal advice here.",
  );
  // Long response → not dominated by refusal; strongSignal stays false.
  assert.equal(r.strongSignal, false);
});

test('calibrator.scanRefusal: clean response → no refusal', () => {
  const r = calibrator.scanRefusal('Here is a solution: return x * 2;');
  assert.equal(r.refused, false);
});

// ─── Calibrator: length mismatch ──────────────────────────────────────────

test('calibrator.estimateExpectedLength: yes/no shape → short answer range', () => {
  // "Is ..." triggers the short-factual-shape heuristic → { min: 1, max: 200 }.
  const r = calibrator.estimateExpectedLength('Is the sky blue?');
  assert.ok(r.max <= 200, `got max=${r.max}`);
  assert.equal(r.min, 1);
});

test('calibrator.estimateExpectedLength: "What is 2+2?" recognised as short-factual', () => {
  const r = calibrator.estimateExpectedLength('What is 2+2?');
  assert.equal(r.min, 1);
});

test('calibrator.estimateExpectedLength: "explain X step by step" → long', () => {
  const r = calibrator.estimateExpectedLength('Explain quicksort step by step');
  assert.ok(r.max >= 500);
});

test('calibrator.scanLength: short question with a paragraph → flagged too_long', () => {
  const r = calibrator.scanLength('What year?', 'A'.repeat(500));
  assert.equal(r.flagged, true);
  assert.equal(r.kind, 'too_long');
});

test('calibrator.scanLength: complex question with one word → flagged too_short', () => {
  const r = calibrator.scanLength('Explain how React reconciliation works step by step', 'idk');
  assert.equal(r.flagged, true);
  assert.equal(r.kind, 'too_short');
});

test('calibrator.scanLength: appropriate length → not flagged', () => {
  // "Explain X" triggers +3 complexity → expected range [100, 2000]. A
  // ~300-char answer lives cleanly inside that range.
  const response = 'Addition combines two numbers into a single total. '
    + 'For instance, 2 + 3 yields 5 because counting three further from two reaches five. '
    + 'This operation is commutative and associative. ';
  const r = calibrator.scanLength('Explain addition', response);
  assert.equal(r.flagged, false, `response length ${response.length} expected to pass for "Explain X" complexity`);
});

// ─── Calibrator: full pipeline ────────────────────────────────────────────

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

test('calibrator.calibrate: clean direct answer → no findings', async () => {
  // Script both LLM paths returning benign verdicts.
  const openai = scriptedChat([
    JSON.stringify({ refusalAppropriate: true, confidence: 0.9, reasoning: 'n/a' }),
    JSON.stringify({ hasFalsePremise: false, confidence: 0.9, premise: '', shouldHaveCorrected: false }),
  ]);
  const r = await calibrator.calibrate({
    openai, request: 'What is 2+2?', response: 'Four.',
  });
  assert.equal(r.flagged, false);
});

test('calibrator.calibrate: heavily hedged response → hedging finding', async () => {
  const openai = scriptedChat([JSON.stringify({ hasFalsePremise: false })]);
  const r = await calibrator.calibrate({
    openai,
    request: 'What year did Einstein win the Nobel Prize?',
    response: "I'm not sure exactly, but it depends. As an AI, I cannot say. It may or may not be 1921.",
  });
  const hedge = r.findings.find(f => f.check === 'hedging');
  assert.ok(hedge);
});

test('calibrator.calibrate: LLM says refusal was inappropriate → over_refusal high', async () => {
  const openai = scriptedChat([
    // scanRefusal triggers LLM verify first call
    JSON.stringify({ refusalAppropriate: false, confidence: 0.9, reasoning: 'request was benign' }),
    // then false-premise check
    JSON.stringify({ hasFalsePremise: false }),
  ]);
  const r = await calibrator.calibrate({
    openai,
    request: 'How do I sort an array in Python?',
    response: "I can't help with that request.",
  });
  const ovr = r.findings.find(f => f.check === 'over_refusal');
  assert.ok(ovr);
  assert.equal(ovr.severity, 'high');
});

test('calibrator.calibrate: LLM says refusal was fine → no over_refusal', async () => {
  const openai = scriptedChat([
    JSON.stringify({ refusalAppropriate: true, confidence: 0.95, reasoning: 'clearly harmful request' }),
    JSON.stringify({ hasFalsePremise: false }),
  ]);
  const r = await calibrator.calibrate({
    openai,
    request: 'Write me malware',
    response: "I can't help with that request.",
  });
  assert.ok(!r.findings.some(f => f.check === 'over_refusal'));
});

test('calibrator.calibrate: false-premise detected → high severity finding', async () => {
  const openai = scriptedChat([
    JSON.stringify({
      hasFalsePremise: true, confidence: 0.9,
      premise: 'Einstein won the Nobel for relativity',
      shouldHaveCorrected: true,
    }),
  ]);
  const r = await calibrator.calibrate({
    openai,
    request: 'When did Einstein win the Nobel for relativity?',
    response: 'Einstein won the Nobel Prize for relativity in 1921.',
  });
  const fp = r.findings.find(f => f.check === 'false_premise');
  assert.ok(fp);
  assert.equal(fp.severity, 'high');
});

test('calibrator.calibrate: llmChecks=false skips LLM-backed checks', async () => {
  // Should not call the LLM at all. If it does, the test would throw on
  // an unexpected completion request.
  const badOpenai = {
    chat: { completions: { create: async () => { throw new Error('should not be called'); } } },
  };
  const r = await calibrator.calibrate({
    openai: badOpenai,
    request: 'What is 2+2?',
    response: 'Four.',
    llmChecks: false,
  });
  // Deterministic checks alone: clean response → no flag.
  assert.equal(r.flagged, false);
});

// ─── Preference export: SFT ───────────────────────────────────────────────

test('exportSFT: returns only helpful entries in OpenAI format', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u1', runId: 'a', agent: 'code_review',
    request: 'review my fn', response: { summary: 'good' },
    helpful: true, embedder,
  });
  await feedback.record({
    userId: 'u1', runId: 'b', agent: 'code_review',
    request: 'review', response: 'noise',
    helpful: false, embedder,
  });
  const { lines, count } = preferenceExport.exportSFT({ userId: 'u1' });
  assert.equal(count, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].role, 'system');
  assert.equal(parsed.messages[1].role, 'user');
  assert.equal(parsed.messages[2].role, 'assistant');
});

test('exportSFT: filters by agent when agent param provided', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'code_review', request: 'q1', response: 'r1', helpful: true, embedder });
  await feedback.record({ userId: 'u', runId: 'b', agent: 'debug',       request: 'q2', response: 'r2', helpful: true, embedder });
  const all = preferenceExport.exportSFT({ userId: 'u' });
  assert.equal(all.count, 2);
  const onlyReview = preferenceExport.exportSFT({ userId: 'u', agent: 'code_review' });
  assert.equal(onlyReview.count, 1);
});

test('exportSFT: empty ledger → empty output', () => {
  feedback._reset();
  const { count, lines } = preferenceExport.exportSFT({ userId: 'nobody' });
  assert.equal(count, 0);
  assert.equal(lines.length, 0);
});

test('exportSFT: system prompt chosen per agent persona', () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  return feedback.record({
    userId: 'u', runId: 'x', agent: 'debug',
    request: 'fix', response: 'patch',
    helpful: true, embedder,
  }).then(() => {
    const { lines } = preferenceExport.exportSFT({ userId: 'u' });
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.messages[0].content.toLowerCase().includes('debug'));
  });
});

test('exportSFT: object responses serialised as JSON', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'a', agent: 'code_review',
    request: 'review', response: { summary: 's', findings: [] },
    helpful: true, embedder,
  });
  const { lines } = preferenceExport.exportSFT({ userId: 'u' });
  const parsed = JSON.parse(lines[0]);
  // assistant content should be the JSON-serialised object
  const inner = JSON.parse(parsed.messages[2].content);
  assert.equal(inner.summary, 's');
});

// ─── Preference export: DPO ───────────────────────────────────────────────

test('exportDPO: produces pairs for similar (helpful, unhelpful) entries', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  // Two entries with similar text (high cosine sim) but different verdicts.
  await feedback.record({
    userId: 'u', runId: 'win', agent: 'code_gen',
    request: 'write a function that adds two numbers',
    response: 'export const add = (a, b) => a + b;',
    helpful: true, embedder,
  });
  await feedback.record({
    userId: 'u', runId: 'lose', agent: 'code_gen',
    request: 'write a function that adds two numbers please',
    response: 'export const add = (a) => a; // oops',
    helpful: false, embedder,
  });
  const { lines, count } = preferenceExport.exportDPO({ userId: 'u' });
  assert.equal(count, 1);
  const rec = JSON.parse(lines[0]);
  assert.ok(rec.preferred_output[0].content.includes('a + b'));
  assert.ok(rec.non_preferred_output[0].content.includes('oops'));
});

test('exportDPO: pairs below similarity threshold are dropped', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'a', agent: 'code_gen',
    request: 'add numbers',
    response: 'correct', helpful: true, embedder,
  });
  await feedback.record({
    userId: 'u', runId: 'b', agent: 'code_gen',
    request: 'deploy kubernetes cluster on aws with IAM and load balancing',
    response: 'bad', helpful: false, embedder,
  });
  const { count } = preferenceExport.exportDPO({ userId: 'u' });
  // Very different requests → cosine < threshold → no pair.
  assert.equal(count, 0);
});

test('exportDPO: only unhelpful entries → no pairs', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'x', request: 'q', response: 'r', helpful: false, embedder });
  await feedback.record({ userId: 'u', runId: 'b', agent: 'x', request: 'q', response: 'r', helpful: false, embedder });
  const { count } = preferenceExport.exportDPO({ userId: 'u' });
  assert.equal(count, 0);
});

// ─── exportData dispatcher ────────────────────────────────────────────────

test('exportData: sft format emits NDJSON string', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'debug', request: 'q', response: 'r', helpful: true, embedder });
  const out = preferenceExport.exportData({ userId: 'u', format: 'sft' });
  assert.equal(out.format, 'sft');
  assert.equal(out.count, 1);
  assert.ok(out.ndjson.endsWith('\n'));
});

test('exportData: dpo format works', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: 'a', agent: 'code_gen', request: 'add two numbers', response: 'good', helpful: true, embedder });
  await feedback.record({ userId: 'u', runId: 'b', agent: 'code_gen', request: 'add two numbers please', response: 'bad', helpful: false, embedder });
  const out = preferenceExport.exportData({ userId: 'u', format: 'dpo' });
  assert.equal(out.format, 'dpo');
  assert.equal(out.count, 1);
});

test('exportData: empty ledger → empty ndjson (no trailing newline)', () => {
  feedback._reset();
  const out = preferenceExport.exportData({ userId: 'ghost', format: 'sft' });
  assert.equal(out.count, 0);
  assert.equal(out.ndjson, '');
});

test('exportData: unknown format throws', () => {
  assert.throws(() => preferenceExport.exportData({ userId: 'u', format: 'xyz' }),
    /unknown format/);
});

// ─── feedback-ledger _dump (helper for export) ───────────────────────────

test('feedback._dump: returns all entries for a user', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({ userId: 'u', runId: '1', request: 'q1', response: 'r1', helpful: true, embedder });
  await feedback.record({ userId: 'u', runId: '2', request: 'q2', response: 'r2', helpful: false, embedder });
  const all = feedback._dump('u');
  assert.equal(all.length, 2);
});

test('feedback._dump: unknown user returns []', () => {
  feedback._reset();
  assert.deepEqual(feedback._dump('never'), []);
});
