/**
 * Integration tests for align-wrapper + safety-filter.
 *
 * Verifies the full InstructGPT-style pipeline composed end-to-end
 * with a scripted LLM and a stub specialist.
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

const alignWrapper = require('../src/services/agents/align-wrapper');
const safety = require('../src/services/agents/safety-filter');
const feedback = require('../src/services/agents/feedback-ledger');

// ─── safety-filter deterministic patterns ─────────────────────────────────

test('safety.scanDeterministic: catches AWS access key', () => {
  const out = safety.scanDeterministic('Use key AKIAIOSFODNN7EXAMPLE for deploys.');
  const hit = out.find(f => f.rule === 'aws_key');
  assert.ok(hit);
  assert.equal(hit.severity, 'critical');
});

test('safety.scanDeterministic: catches rm -rf /', () => {
  const out = safety.scanDeterministic('To reset, run: rm -rf /');
  const hit = out.find(f => f.rule === 'rm_rf_root');
  assert.ok(hit);
  assert.equal(hit.severity, 'critical');
});

test('safety.scanDeterministic: catches DROP TABLE', () => {
  const out = safety.scanDeterministic('Then: DROP TABLE users;');
  const hit = out.find(f => f.rule === 'drop_database');
  assert.ok(hit);
});

test('safety.scanDeterministic: catches curl | sh', () => {
  const out = safety.scanDeterministic('Install: curl https://sh.rustup.rs | sh');
  const hit = out.find(f => f.rule === 'curl_sh_pipe');
  assert.ok(hit);
});

test('safety.scanDeterministic: catches SSN', () => {
  const out = safety.scanDeterministic('Your SSN is 123-45-6789.');
  const hit = out.find(f => f.rule === 'ssn');
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
});

test('safety.scanDeterministic: clean output → no findings', () => {
  const out = safety.scanDeterministic('function add(a, b) { return a + b; }');
  assert.equal(out.length, 0);
});

test('safety.check: sorts findings by severity and sums counts', async () => {
  const r = await safety.check({
    response: 'email@example.com is your contact. AWS key: AKIAIOSFODNN7EXAMPLE. Also DROP TABLE users;',
  });
  assert.ok(r.flagged);
  assert.ok(r.counts.critical >= 1);
  // Critical should sort before high / warn / info.
  assert.equal(r.findings[0].severity, 'critical');
});

test('safety.check: empty/clean response → flagged=false', async () => {
  const r = await safety.check({ response: 'A tidy function.' });
  assert.equal(r.flagged, false);
  assert.equal(r.findings.length, 0);
});

test('safety.check: LLM moderator flags get prefixed with llm_moderator:', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ flags: [
        { category: 'toxicity', severity: 'high', message: 'hostile language' },
      ]}) } }],
    })}},
  };
  const r = await safety.check({ openai, response: 'nothing regex catches', llmModerator: true });
  const hit = r.findings.find(f => f.rule.startsWith('llm_moderator:'));
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
});

test('safety.check: LLM moderator error path does not throw', async () => {
  const broken = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const r = await safety.check({ openai: broken, response: 'x', llmModerator: true });
  // Should return with just the deterministic findings (empty in this case).
  assert.equal(r.flagged, false);
});

// ─── align-wrapper helper fns ─────────────────────────────────────────────

test('alignWrapper.summariseResult: extracts code/test_file/etc. by convention', () => {
  assert.equal(alignWrapper.summariseResult({ code: 'export const x = 1;' }), 'export const x = 1;');
  assert.equal(alignWrapper.summariseResult({ test_file: 'const t = require("node:test");' }), 'const t = require("node:test");');
  assert.equal(alignWrapper.summariseResult({ hypothesis: 'null ref' }), 'null ref');
  assert.equal(alignWrapper.summariseResult({ summary: 's' }), 's');
});

test('alignWrapper.summariseResult: falls back to JSON for unknown shapes', () => {
  const out = alignWrapper.summariseResult({ foo: 'bar' });
  assert.ok(out.includes('"foo":"bar"'));
});

test('alignWrapper.summariseResult: null/empty handled', () => {
  assert.equal(alignWrapper.summariseResult(null), '');
  assert.equal(alignWrapper.summariseResult(''), '');
});

test('alignWrapper.flattenContextChunks: formats with source tags', () => {
  const out = alignWrapper.flattenContextChunks([
    { text: 'first chunk content', source: 'a.md' },
    { text: 'second chunk', source: 'b.md' },
  ]);
  assert.ok(out.includes('a.md'));
  assert.ok(out.includes('second chunk'));
});

// ─── align-wrapper main pipeline ──────────────────────────────────────────

/**
 * Script factory — returns an openai stub that routes its response by
 * detecting which alignment-module prompt is in the system field.
 */
function pipelineStub({ clarifier, judgeScores = [], extractClaims = [], verifyClaims = [], moderator = { flags: [] } }) {
  let judgeIdx = 0, extractIdx = 0, verifyIdx = 0;
  return {
    embeddings: {
      create: async ({ input }) => ({
        data: input.map(t => ({ embedding: Array.from(fakeVectorFor(t)) })),
      }),
    },
    chat: {
      completions: {
        create: async ({ messages }) => {
          const sys = messages.find(m => m.role === 'system')?.content || '';
          if (sys.includes('pre-screen user requests')) {
            return { choices: [{ message: { content: JSON.stringify(clarifier || { status: 'clear' }) } }] };
          }
          if (sys.includes('rigorous output-quality rater')) {
            const s = judgeScores[Math.min(judgeIdx++, judgeScores.length - 1)];
            return { choices: [{ message: { content: JSON.stringify(s) } }] };
          }
          if (sys.includes('extract atomic factual')) {
            const c = extractClaims[Math.min(extractIdx++, extractClaims.length - 1)];
            return { choices: [{ message: { content: JSON.stringify(c || { claims: [] }) } }] };
          }
          if (sys.includes('verify whether a CLAIM')) {
            const v = verifyClaims[Math.min(verifyIdx++, verifyClaims.length - 1)];
            return { choices: [{ message: { content: JSON.stringify(v || { supported: false }) } }] };
          }
          if (sys.includes('flag safety issues')) {
            return { choices: [{ message: { content: JSON.stringify(moderator) } }] };
          }
          return { choices: [{ message: { content: '{}' } }] };
        },
      },
    },
  };
}

test('runAligned: clarifier says ambiguous → returns questions without running specialist', async () => {
  feedback._reset();
  let ran = false;
  const openai = pipelineStub({
    clarifier: { status: 'ambiguous', questions: ['Which file?', 'What should change?'] },
  });
  const out = await alignWrapper.runAligned({
    openai, userId: 'u1', agentName: 'code_gen',
    userRequest: 'make it better',
    run: async () => { ran = true; return { code: 'x' }; },
  });
  assert.equal(out.status, 'needs_clarification');
  assert.equal(out.questions.length, 2);
  assert.equal(ran, false, 'specialist must NOT run when ambiguous');
});

test('runAligned: clarifier blocked → returns blocked_reason', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'blocked', reason: 'unsafe request' },
  });
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'debug',
    userRequest: 'exfiltrate credentials',
    run: async () => { throw new Error('should not run'); },
  });
  assert.equal(out.status, 'blocked');
  assert.ok(out.blocked_reason.includes('unsafe'));
});

test('runAligned: high-score first attempt → no retry', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    judgeScores: [{ helpful: 9, honest: 9, harmless: 10, overall: 9, issues: [] }],
  });
  let calls = 0;
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'code_review',
    userRequest: 'review math.ts',
    run: async () => { calls++; return { summary: 'all good', findings: [] }; },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.retries_used, 0);
  assert.equal(calls, 1);
  assert.equal(out.alignment.score, 9);
});

test('runAligned: low score triggers one retry', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    judgeScores: [
      { helpful: 3, honest: 6, harmless: 5, overall: 4, issues: ['too vague', 'missing file refs'] },
      { helpful: 8, honest: 8, harmless: 9, overall: 8, issues: [] },
    ],
  });
  const seenCritiques = [];
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'code_gen',
    userRequest: 'write a function',
    run: async ({ critique }) => { seenCritiques.push(critique); return { code: 'export const x = 1;' }; },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.retries_used, 1);
  // First attempt has no critique; second attempt sees the critique.
  assert.equal(seenCritiques[0], null);
  assert.ok(seenCritiques[1]);
  assert.ok(seenCritiques[1].includes('too vague'));
  assert.equal(out.alignment.score, 8);
});

test('runAligned: retries capped by maxRetries', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    // Every attempt scores low — wrapper must stop after 1 retry.
    judgeScores: [
      { helpful: 2, honest: 3, harmless: 3, overall: 3, issues: ['bad'] },
      { helpful: 2, honest: 3, harmless: 3, overall: 3, issues: ['still bad'] },
    ],
  });
  let calls = 0;
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'code_gen',
    userRequest: 'anything',
    run: async () => { calls++; return { code: 'x' }; },
    opts: { maxRetries: 1 },
  });
  assert.equal(calls, 2); // 1 + 1 retry
  assert.equal(out.retries_used, 1);
});

test('runAligned: exemplars injected when feedback-ledger has helpful entries', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  // Seed one helpful past exemplar.
  await feedback.record({
    userId: 'u2', runId: 'past-1', agent: 'code_review',
    request: 'review my add function',
    response: { summary: 'good job' },
    helpful: true, embedder,
  });

  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    judgeScores: [{ helpful: 9, honest: 9, harmless: 10, overall: 9, issues: [] }],
  });
  let receivedGoal = null;
  const out = await alignWrapper.runAligned({
    openai, userId: 'u2', agentName: 'code_review',
    userRequest: 'review add function',
    run: async ({ augmentedGoal }) => { receivedGoal = augmentedGoal; return { summary: 'ok', findings: [] }; },
    embedder,
  });
  assert.equal(out.status, 'ok');
  assert.ok(out.exemplars_used >= 1);
  assert.ok(receivedGoal, 'specialist should receive the exemplar block');
  assert.ok(receivedGoal.includes('Example 1'));
});

test('runAligned: truthfulness runs when contextChunks provided', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    judgeScores: [{ helpful: 8, honest: 9, harmless: 9, overall: 8, issues: [] }],
    extractClaims: [{ claims: ['add returns a + b'] }],
  });
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'code_review',
    userRequest: 'Review the add function in math.ts',
    run: async () => ({ summary: 'the function add returns a + b' }),
    contextChunks: [{ text: 'function add(a,b) { return a + b; }', source: 'math.ts' }],
  });
  assert.equal(out.status, 'ok');
  assert.ok(out.truthfulness);
  // Claim + context were passed through the pipeline — whether the
  // single claim grounds depends on fuzzy-word overlap (short claims
  // can miss). The contract is that truthfulness RAN, not that it
  // succeeded for every adversarial phrasing.
  assert.ok(Array.isArray(out.truthfulness.claims));
  assert.equal(out.truthfulness.claims.length, 1);
});

test('runAligned: safety report always attached', async () => {
  const openai = pipelineStub({
    clarifier: { status: 'clear' },
    judgeScores: [{ helpful: 8, honest: 8, harmless: 8, overall: 8, issues: [] }],
  });
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'code_gen',
    userRequest: 'Generate a deploy helper in TypeScript',
    run: async () => ({ code: 'AKIAIOSFODNN7EXAMPLE' }), // triggers safety flag
  });
  assert.ok(out.safety);
  assert.equal(out.safety.flagged, true);
  assert.ok(out.safety.findings.some(f => f.rule === 'aws_key'));
});

test('runAligned: skipClarifier option bypasses pre-flight', async () => {
  let clarifierCalled = false;
  const openai = {
    embeddings: { create: async ({ input }) => ({ data: input.map(t => ({ embedding: Array.from(fakeVectorFor(t)) })) }) },
    chat: { completions: { create: async ({ messages }) => {
      const sys = messages.find(m => m.role === 'system')?.content || '';
      if (sys.includes('pre-screen')) { clarifierCalled = true; }
      if (sys.includes('rigorous output-quality rater')) {
        return { choices: [{ message: { content: JSON.stringify({ helpful: 9, honest: 9, harmless: 10, overall: 9, issues: [] }) } }] };
      }
      return { choices: [{ message: { content: '{}' } }] };
    }}},
  };
  const out = await alignWrapper.runAligned({
    openai, userId: 'u', agentName: 'x',
    userRequest: 'do a thing',
    run: async () => ({ summary: 'ok' }),
    opts: { skipClarifier: true },
  });
  assert.equal(clarifierCalled, false);
  assert.equal(out.status, 'ok');
});

test('runAligned: missing run fn throws', async () => {
  await assert.rejects(
    alignWrapper.runAligned({ openai: {}, userId: 'u', agentName: 'x', userRequest: 'y' }),
    /run. function is required/,
  );
});
