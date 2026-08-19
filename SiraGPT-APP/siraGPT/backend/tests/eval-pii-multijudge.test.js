/**
 * Unit tests for eval-harness, pii-scrubber, multi-judge.
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

const evalHarness = require('../src/services/agents/eval-harness');
const piiScrubber = require('../src/services/agents/pii-scrubber');
const multiJudge = require('../src/services/agents/multi-judge');
const preferenceExport = require('../src/services/agents/preference-export');
const feedback = require('../src/services/agents/feedback-ledger');

// ─── eval-harness: stats helpers ──────────────────────────────────────────

test('eval-harness.mean: empty → 0', () => {
  assert.equal(evalHarness.mean([]), 0);
});

test('eval-harness.mean: typical case', () => {
  assert.equal(evalHarness.mean([1, 2, 3, 4]), 2.5);
});

test('eval-harness.stddev: < 2 items → 0', () => {
  assert.equal(evalHarness.stddev([5]), 0);
  assert.equal(evalHarness.stddev([]), 0);
});

test('eval-harness.twoProportionZ: zero total returns safe defaults', () => {
  const r = evalHarness.twoProportionZ(0, 0, 0);
  assert.equal(r.z, 0);
  assert.equal(r.winRateA, 0);
});

test('eval-harness.twoProportionZ: big swing on many trials → large z', () => {
  // A wins 10/100, B wins 90/100 — huge effect, z should be very negative
  // (B - A / SE), p-value tiny.
  const r = evalHarness.twoProportionZ(10, 90, 100);
  assert.ok(r.z > 5);
  assert.ok(r.pApprox < 0.001);
});

// ─── eval-harness: runEval with stub agent ────────────────────────────────

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

test('eval-harness.runEval: scores each prompt, aggregates mean + passRate', async () => {
  // Stub judge: every response scores 8/10 overall → pass.
  const openai = scriptedChat([
    JSON.stringify({ helpful: 8, honest: 8, harmless: 8, overall: 8, issues: [] }),
  ]);
  const r = await evalHarness.runEval({
    openai,
    runAgent: async (prompt) => `response to: ${prompt}`,
    prompts: [
      { id: 'p1', prompt: 'q1' },
      { id: 'p2', prompt: 'q2' },
    ],
    passThreshold: 6,
  });
  assert.equal(r.n, 2);
  assert.equal(r.passRate, 1);
  assert.equal(r.meanOverall, 8);
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs.every(x => x.pass));
});

test('eval-harness.runEval: passThreshold filters pass/fail', async () => {
  const openai = scriptedChat([
    JSON.stringify({ helpful: 3, honest: 4, harmless: 5, overall: 4, issues: ['too short'] }),
  ]);
  const r = await evalHarness.runEval({
    openai,
    runAgent: async () => 'weak response',
    prompts: [{ id: 'p1', prompt: 'q' }],
    passThreshold: 6,
  });
  assert.equal(r.passRate, 0);
  assert.equal(r.runs[0].pass, false);
});

test('eval-harness.runEval: aggregates failure modes from issues arrays', async () => {
  // Each prompt's judge returns issues — they should collect into
  // failureModes histogram.
  let i = 0;
  const responses = [
    JSON.stringify({ helpful: 4, honest: 4, harmless: 5, overall: 4, issues: ['hedged too much', 'missing detail'] }),
    JSON.stringify({ helpful: 5, honest: 5, harmless: 5, overall: 5, issues: ['hedged too much'] }),
  ];
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: responses[Math.min(i++, responses.length - 1)] } }],
  })}}};
  const r = await evalHarness.runEval({
    openai, runAgent: async () => 'x',
    prompts: [{ id: 'a', prompt: 'q1' }, { id: 'b', prompt: 'q2' }],
  });
  assert.ok(r.failureModes['hedged too much'] >= 1);
});

test('eval-harness.runEval: agent default set used when prompts omitted', async () => {
  const openai = scriptedChat([JSON.stringify({ helpful: 7, honest: 7, harmless: 7, overall: 7, issues: [] })]);
  const r = await evalHarness.runEval({
    openai, runAgent: async () => 'ok',
    agent: 'code_review',
  });
  // Built-in code_review set has 3 prompts.
  assert.ok(r.n >= 2);
});

test('eval-harness.runEval: agent errors become low-scored runs', async () => {
  const openai = scriptedChat([JSON.stringify({ helpful: 1, honest: 1, harmless: 5, overall: 2, issues: ['broken'] })]);
  const r = await evalHarness.runEval({
    openai,
    runAgent: async () => { throw new Error('agent blew up'); },
    prompts: [{ id: 'x', prompt: 'q' }],
  });
  assert.equal(r.n, 1);
  assert.equal(r.runs[0].pass, false);
});

// ─── eval-harness: A/B mode ───────────────────────────────────────────────

test('eval-harness.runAB: judge picks B → B wins', async () => {
  const openai = scriptedChat([JSON.stringify({ preferred: 'B', reasoning: 'B is better' })]);
  const r = await evalHarness.runAB({
    openai,
    runA: async () => 'A response',
    runB: async () => 'B response',
    prompts: [{ id: 'p1', prompt: 'q' }],
    labelA: 'baseline', labelB: 'challenger',
  });
  assert.equal(r.challenger.wins, 1);
  assert.equal(r.baseline.wins, 0);
});

test('eval-harness.runAB: tie counted as half-credit each', async () => {
  const openai = scriptedChat([JSON.stringify({ preferred: 'tie', reasoning: 'equivalent' })]);
  const r = await evalHarness.runAB({
    openai,
    runA: async () => 'a',
    runB: async () => 'b',
    prompts: [{ id: 'p', prompt: 'q' }],
    labelA: 'baseline', labelB: 'challenger',
  });
  assert.equal(r.ties, 1);
  assert.equal(r.baseline.winRate, 0.5);
  assert.equal(r.challenger.winRate, 0.5);
});

test('eval-harness.runAB: agent errors on one side surface in verdicts', async () => {
  const openai = scriptedChat([JSON.stringify({ preferred: 'A', reasoning: 'B was empty' })]);
  const r = await evalHarness.runAB({
    openai,
    runA: async () => 'ok',
    runB: async () => { throw new Error('boom'); },
    prompts: [{ id: 'p', prompt: 'q' }],
    labelA: 'baseline', labelB: 'challenger',
  });
  assert.equal(r.verdicts[0].respB.error, 'boom');
});

test('eval-harness.defaultPromptsFor: falls back to general when unknown', () => {
  const set = evalHarness.defaultPromptsFor('nonexistent_agent');
  assert.ok(Array.isArray(set));
  assert.ok(set.length > 0);
});

// ─── pii-scrubber ─────────────────────────────────────────────────────────

test('pii.scrub: redacts emails', () => {
  const r = piiScrubber.scrub('Contact alice@example.com for details.');
  assert.ok(r.scrubbed.includes('<EMAIL>'));
  assert.ok(!r.scrubbed.includes('alice@example.com'));
  assert.ok(r.hits.find(h => h.id === 'email'));
});

test('pii.scrub: redacts SSN', () => {
  const r = piiScrubber.scrub('SSN 123-45-6789 on file.');
  assert.ok(r.scrubbed.includes('<SSN>'));
  assert.ok(r.hits.find(h => h.id === 'ssn'));
});

test('pii.scrub: redacts credit card', () => {
  const r = piiScrubber.scrub('Card: 4111 1111 1111 1111');
  assert.ok(r.scrubbed.includes('<CREDIT_CARD>'));
});

test('pii.scrub: redacts phone numbers', () => {
  const r = piiScrubber.scrub('Call 555-123-4567 anytime.');
  assert.ok(r.scrubbed.includes('<PHONE>'));
});

test('pii.scrub: redacts IPv4', () => {
  const r = piiScrubber.scrub('Server is at 192.168.1.100');
  assert.ok(r.scrubbed.includes('<IP>'));
});

test('pii.scrub: redacts AWS keys, OpenAI keys, GitHub PATs, JWTs', () => {
  // The JWT pattern requires ≥10 chars in each of the three base64 segments
  // (matching real-world JWT lengths), so our mock needs to be beefy.
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const text = `Keys: AKIAIOSFODNN7EXAMPLE sk-abcdefghijklmnopqrstuvwx ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAAA ${jwt}`;
  const r = piiScrubber.scrub(text);
  assert.ok(r.scrubbed.includes('<AWS_KEY>'));
  assert.ok(r.scrubbed.includes('<OPENAI_KEY>'));
  assert.ok(r.scrubbed.includes('<GITHUB_TOKEN>'));
  assert.ok(r.scrubbed.includes('<JWT>'));
});

test('pii.scrub: redacts PEM private keys across lines', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  const r = piiScrubber.scrub(`Here's the key:\n${pem}\nDone.`);
  assert.ok(r.scrubbed.includes('<PRIVATE_KEY>'));
  assert.ok(!r.scrubbed.includes('MIIEp'));
});

test('pii.scrub: aggressive mode catches UUIDs and long hex', () => {
  const text = 'UUID 123e4567-e89b-12d3-a456-426614174000 hash 0123456789abcdef0123456789abcdef';
  const normal = piiScrubber.scrub(text);
  assert.ok(!normal.scrubbed.includes('<UUID>'));
  const aggressive = piiScrubber.scrub(text, { aggressive: true });
  assert.ok(aggressive.scrubbed.includes('<UUID>'));
  assert.ok(aggressive.scrubbed.includes('<HEX_ID>'));
});

test('pii.scrub: empty / non-string input returns empty hits', () => {
  assert.deepEqual(piiScrubber.scrub('').hits, []);
  assert.deepEqual(piiScrubber.scrub(null).hits, []);
});

test('pii.scrub: clean text unchanged', () => {
  const r = piiScrubber.scrub('function add(a, b) { return a + b; }');
  assert.equal(r.scrubbed, 'function add(a, b) { return a + b; }');
  assert.equal(r.hits.length, 0);
});

test('pii.scrubRecord: walks nested objects + arrays', () => {
  const r = piiScrubber.scrubRecord({
    user: 'admin',
    emails: ['a@b.com', 'c@d.com'],
    nested: { ssn: '123-45-6789', note: 'clean' },
  });
  const s = JSON.stringify(r.scrubbed);
  assert.ok(s.includes('<EMAIL>'));
  assert.ok(s.includes('<SSN>'));
  assert.ok(s.includes('clean'));
  assert.ok(r.hits.some(h => h.id === 'email'));
});

test('pii.scrubRecord: aggregates hit counts across fields', () => {
  const r = piiScrubber.scrubRecord({
    a: 'a@b.com',
    b: 'c@d.com',
    c: 'e@f.com',
  });
  const emailHit = r.hits.find(h => h.id === 'email');
  assert.equal(emailHit.count, 3);
});

// ─── preference-export with scrubbing ────────────────────────────────────

test('preference-export.exportSFT: scrubs PII by default', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'r', agent: 'debug',
    request: 'error from alice@example.com — stack shows ip 10.0.0.1',
    response: 'the bug is in user.js; contact bob@example.com',
    helpful: true, embedder,
  });
  const out = preferenceExport.exportSFT({ userId: 'u' });
  assert.equal(out.count, 1);
  const parsed = JSON.parse(out.lines[0]);
  const all = JSON.stringify(parsed);
  assert.ok(all.includes('<EMAIL>'));
  assert.ok(all.includes('<IP>'));
  assert.ok(!all.includes('alice@example'));
  assert.ok(out.piiHits.find(h => h.id === 'email'));
});

test('preference-export.exportSFT: scrubPii=false preserves originals', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'r', agent: 'debug',
    request: 'error from alice@example.com',
    response: 'ok',
    helpful: true, embedder,
  });
  const out = preferenceExport.exportSFT({ userId: 'u', scrubPii: false });
  const all = JSON.stringify(JSON.parse(out.lines[0]));
  assert.ok(all.includes('alice@example.com'));
});

test('preference-export.exportData: dpo format also scrubs', async () => {
  feedback._reset();
  const embedder = (t) => Promise.resolve(t.map(fakeVectorFor));
  await feedback.record({
    userId: 'u', runId: 'win', agent: 'code_gen',
    request: 'build function for alice@example.com',
    response: 'ok code', helpful: true, embedder,
  });
  await feedback.record({
    userId: 'u', runId: 'lose', agent: 'code_gen',
    request: 'build function for alice@example.com please',
    response: 'bad code with 192.168.1.1', helpful: false, embedder,
  });
  const out = preferenceExport.exportData({ userId: 'u', format: 'dpo' });
  assert.equal(out.format, 'dpo');
  assert.equal(out.count, 1);
  assert.ok(out.ndjson.includes('<EMAIL>'));
  assert.ok(out.ndjson.includes('<IP>'));
});

// ─── multi-judge ──────────────────────────────────────────────────────────

test('multi-judge.median: basic cases', () => {
  assert.equal(multiJudge.median([1]), 1);
  assert.equal(multiJudge.median([1, 2, 3]), 2);
  assert.equal(multiJudge.median([1, 2, 3, 4]), 2.5);
});

test('multi-judge.quantile: single element is q3', () => {
  assert.equal(multiJudge.quantile([5], 0.75), 5);
});

test('multi-judge.stddev: 2+ elements', () => {
  const s = multiJudge.stddev([1, 2, 3, 4, 5]);
  assert.ok(s > 1.5 && s < 1.6);
});

test('multi-judge.scoreMulti: null openai → single fallback score', async () => {
  const r = await multiJudge.scoreMulti({ openai: null, userRequest: 'q', response: 'r' });
  assert.equal(r.n, 1);
  assert.equal(r.disagreement, 'low');
});

test('multi-judge.scoreMulti: n=3 all agreeing → low disagreement', async () => {
  // All three judges return 8/10 → IQR = 0 → low.
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({
        helpful: 8, honest: 8, harmless: 8, overall: 8, issues: ['one issue'],
      }) } }],
    })}},
  };
  const r = await multiJudge.scoreMulti({
    openai, userRequest: 'q', response: 'r', n: 3,
  });
  assert.equal(r.n, 3);
  assert.equal(r.median, 8);
  assert.equal(r.iqr, 0);
  assert.equal(r.disagreement, 'low');
});

test('multi-judge.scoreMulti: wide spread → high disagreement', async () => {
  // Three judges score 2, 6, 9 — IQR 7 → high.
  let i = 0;
  const scores = [2, 6, 9];
  const openai = {
    chat: { completions: { create: async () => {
      const s = scores[i++ % scores.length];
      return { choices: [{ message: { content: JSON.stringify({
        helpful: s, honest: s, harmless: s, overall: s, issues: [],
      }) } }] };
    }}},
  };
  const r = await multiJudge.scoreMulti({ openai, userRequest: 'q', response: 'r', n: 3 });
  assert.equal(r.disagreement, 'high');
});

test('multi-judge.scoreMulti: dedupes issues across rounds', async () => {
  let i = 0;
  const scores = [
    { helpful: 7, honest: 7, harmless: 7, overall: 7, issues: ['hedged', 'vague'] },
    { helpful: 6, honest: 7, harmless: 7, overall: 7, issues: ['hedged', 'missing example'] },
  ];
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify(scores[i++ % scores.length]) } }],
    })}},
  };
  const r = await multiJudge.scoreMulti({ openai, userRequest: 'q', response: 'r', n: 2 });
  // 'hedged' appears in both rounds but should appear only once in the union.
  const hedgeCount = r.issues.filter(s => s.toLowerCase().includes('hedged')).length;
  assert.equal(hedgeCount, 1);
  assert.equal(r.issues.length, 3); // hedged, vague, missing example
});

test('multi-judge.scoreMulti: n clamps to MAX_N', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ helpful: 7, honest: 7, harmless: 7, overall: 7, issues: [] }) } }],
    })}},
  };
  const r = await multiJudge.scoreMulti({ openai, userRequest: 'q', response: 'r', n: 20 });
  assert.ok(r.n <= multiJudge.MAX_N);
});

test('multi-judge.callJudgeWithPersona: prepends persona to system prompt', async () => {
  let seenSystem = '';
  const openai = {
    chat: { completions: { create: async ({ messages }) => {
      seenSystem = messages[0].content;
      return { choices: [{ message: { content: JSON.stringify({
        helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [],
      }) } }] };
    }}},
  };
  await multiJudge.callJudgeWithPersona({
    openai, userRequest: 'q', response: 'r',
    persona: 'You are a STRICT rater.',
    temperature: 0,
  });
  assert.ok(seenSystem.includes('STRICT rater'));
  assert.ok(seenSystem.includes('rigorous output-quality rater')); // original rubric preserved
});
