/**
 * Unit tests for the specialist SE agents (code-review, test-gen,
 * debug, code-gen, static-check) and the orchestrator.
 *
 * All LLM calls are scripted. We verify:
 *   - The agent produces a normalized structured output.
 *   - Malformed LLM output is defanged (no crashes, sensible defaults).
 *   - Orchestrator intent routing picks the right enum value.
 *   - Orchestrator pipeline executes the steps in order.
 *   - parseStacktrace extracts hints from V8/Python/Go.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai BEFORE requiring services.
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

const rag = require('../src/services/rag-service');
const codeReview = require('../src/services/agents/code-review-agent');
const testGen = require('../src/services/agents/test-gen-agent');
const debugAgent = require('../src/services/agents/debug-agent');
const codeGen = require('../src/services/agents/code-gen-agent');
const staticCheck = require('../src/services/agents/static-check-agent');
const orchestrator = require('../src/services/agents/se-orchestrator');

function scriptedChat(responses) {
  let i = 0;
  return {
    embeddings: {
      create: async ({ input }) => ({
        data: input.map(t => ({ embedding: Array.from(fakeVectorFor(t)) })),
      }),
    },
    chat: {
      completions: {
        create: async () => {
          const content = responses[Math.min(i, responses.length - 1)];
          i++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

// ─── code-review-agent ─────────────────────────────────────────────────────

test('code-review: normalizeReview clamps severity enum + sorts', () => {
  const r = codeReview.normalizeReview({
    final: {
      summary: 'summary',
      findings: [
        { file: 'a.js', issue: 'low', severity: 'low', category: 'correctness' },
        { file: 'a.js', issue: 'critical', severity: 'critical', category: 'security' },
        { file: 'a.js', issue: 'bogus', severity: 'NEON_PURPLE', category: 'x' },
      ],
    },
    iterations: 2, terminatedBy: 'final',
  });
  // First by severity order
  assert.equal(r.findings[0].severity, 'critical');
  // Bogus severity clamped to 'info', bogus category to 'maintainability'
  const bogus = r.findings.find(f => f.issue === 'bogus');
  assert.equal(bogus.severity, 'info');
  assert.equal(bogus.category, 'maintainability');
});

test('code-review: missing findings → empty array, not crash', () => {
  const r = codeReview.normalizeReview({ final: null, iterations: 1, terminatedBy: 'maxIters' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.summary, '');
});

test('code-review: end-to-end with scripted LLM', async () => {
  const uid = `rv-${Math.random()}`;
  const col = 'rv-e2e';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'function f(){ return eval(x); }', source: 'danger.js' }]);

  const openai = scriptedChat([
    // turn 1: call static_checks
    JSON.stringify({ thought: 'lint first', tool: 'static_checks', args: { source: 'danger.js' } }),
    // turn 2: finalise
    JSON.stringify({
      final: {
        summary: 'one critical eval',
        findings: [{ file: 'danger.js', start_line: 1, end_line: 1, severity: 'critical',
                    category: 'security', issue: 'eval of user input', suggestion: 'parse explicitly',
                    confidence: 0.95 }],
      },
    }),
  ]);

  const r = await codeReview.review({
    openai, userId: uid, collection: col, files: ['danger.js'], maxIters: 3,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'critical');
  assert.equal(r.counts.critical, 1);
});

// ─── test-gen-agent ────────────────────────────────────────────────────────

test('test-gen: normalize produces bucket counts', () => {
  const r = testGen.normalizeTestGen({
    final: {
      target: 'mmr:mmrRerank',
      framework: 'node:test',
      test_file: "const t = require('node:test');",
      test_cases: [
        { name: 'sorts by score', scenario: 'happy_path' },
        { name: 'handles empty', scenario: 'edge_case' },
        { name: 'throws on null', scenario: 'error_path' },
      ],
      uncovered: ['async cancellation'],
    },
    iterations: 3, terminatedBy: 'final',
  }, { source: 'mmr.js', symbol: 'mmrRerank' });
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.happy_path, 1);
  assert.equal(r.counts.edge_case, 1);
  assert.equal(r.counts.error_path, 1);
  assert.equal(r.uncovered.length, 1);
});

test('test-gen: invalid scenario → happy_path default', () => {
  const r = testGen.normalizeTestGen({
    final: { test_cases: [{ name: 'x', scenario: 'wild' }] },
    iterations: 1, terminatedBy: 'final',
  }, { source: 's' });
  assert.equal(r.test_cases[0].scenario, 'happy_path');
});

// ─── debug-agent ───────────────────────────────────────────────────────────

test('debug: parseStacktrace — V8 format', () => {
  const raw = `TypeError: undefined is not a function
    at createUser (/app/src/user.js:42:13)
    at handler (/app/src/handler.js:12:9)`;
  const hints = debugAgent.parseStacktrace(raw);
  assert.ok(hints.some(h => h.file === '/app/src/user.js' && h.line === 42));
  assert.ok(hints.some(h => h.file === '/app/src/handler.js' && h.line === 12));
});

test('debug: parseStacktrace — Python format', () => {
  const raw = `Traceback (most recent call last):
  File "app/server.py", line 88, in handler
    raise ValueError("x")`;
  const hints = debugAgent.parseStacktrace(raw);
  assert.ok(hints.some(h => h.file === 'app/server.py' && h.line === 88));
});

test('debug: parseStacktrace — Go format', () => {
  const raw = `goroutine 1 [running]:
main.doStuff()
\t/app/main.go:17 +0x1f
main.main()
\t/app/main.go:9`;
  const hints = debugAgent.parseStacktrace(raw);
  assert.ok(hints.some(h => h.file === '/app/main.go' && h.line === 17));
});

test('debug: parseStacktrace — deduplicates repeats', () => {
  const raw = `at /a/b.js:10:5
at /a/b.js:10:5
at /a/c.js:20:1`;
  const hints = debugAgent.parseStacktrace(raw);
  assert.equal(hints.length, 2);
});

test('debug: normalizeDebug handles missing patches gracefully', () => {
  const r = debugAgent.normalizeDebug(
    { final: { hypothesis: 'bug in foo' }, iterations: 2, terminatedBy: 'final' },
    [],
  );
  assert.equal(r.hypothesis, 'bug in foo');
  assert.deepEqual(r.patches, []);
});

test('debug: patches without source/replacement dropped', () => {
  const r = debugAgent.normalizeDebug({
    final: {
      patches: [
        { source: 'a.js', replacement: 'x' },
        { source: 'b.js' },           // missing replacement
        { replacement: 'y' },         // missing source
      ],
    },
    iterations: 1, terminatedBy: 'final',
  }, []);
  assert.equal(r.patches.length, 1);
});

// ─── code-gen-agent ────────────────────────────────────────────────────────

test('code-gen: normalize keeps code and rationale', () => {
  const r = codeGen.normalizeCodeGen({
    final: {
      language: 'typescript',
      file_path: 'src/foo.ts',
      code: 'export const x = 1;',
      rationale: 'simplest thing that works',
      assumptions: ['TS'],
      chosen_among: [{ label: 'A', approach: 'simple', score: 0.9 }],
    },
    iterations: 4, terminatedBy: 'final',
  }, { strategy: 'single_path' });
  assert.equal(r.code, 'export const x = 1;');
  assert.equal(r.strategy, 'single_path');
  assert.equal(r.chosen_among.length, 1);
});

test('code-gen: strategy forwarded', () => {
  const r = codeGen.normalizeCodeGen({ final: {}, iterations: 1, terminatedBy: 'final' }, { strategy: 'multi_path' });
  assert.equal(r.strategy, 'multi_path');
});

// ─── static-check-agent ────────────────────────────────────────────────────

test('static-check: returns no findings when files clean', async () => {
  const uid = `sc-${Math.random()}`;
  const col = 'sc-clean';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'const x = 1;\nconst y = 2;', source: 'clean.js' }]);
  const openai = scriptedChat([]); // should not be called — zero findings
  const r = await staticCheck.check({
    openai, userId: uid, collection: col, files: ['clean.js'], maxIters: 1,
  });
  assert.equal(r.findings.length, 0);
  assert.equal(r.iterations, 0);
});

test('static-check: runs LLM audit when static findings exist', async () => {
  const uid = `sc-${Math.random()}`;
  const col = 'sc-dirty';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: '// TODO: fix later\nconst x = 1;', source: 'dirty.js' }]);
  const openai = scriptedChat([
    JSON.stringify({
      final: {
        summary: 'one TODO, confirmed',
        findings: [{ file: 'dirty.js', line: 1, rule: 'todo_fixme', severity: 'info',
                    confirmed: true, message: 'pending TODO', suggestion: 'resolve or delete' }],
      },
    }),
  ]);
  const r = await staticCheck.check({
    openai, userId: uid, collection: col, files: ['dirty.js'], maxIters: 3,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confirmed, true);
});

// ─── se-orchestrator ──────────────────────────────────────────────────────

test('orchestrator.routeIntent: routes to specialist enum', async () => {
  const openai = scriptedChat([JSON.stringify({ intent: 'debug', confidence: 0.9, reason: 'has stacktrace' })]);
  const r = await orchestrator.routeIntent({ openai, message: 'TypeError at foo.js:10' });
  assert.equal(r.intent, 'debug');
});

test('orchestrator.routeIntent: garbage response → general fallback', async () => {
  const openai = scriptedChat(['not json']);
  const r = await orchestrator.routeIntent({ openai, message: 'hello' });
  assert.equal(r.intent, 'general');
});

test('orchestrator.routeIntent: unknown intent → general', async () => {
  const openai = scriptedChat([JSON.stringify({ intent: 'telepathy', confidence: 1 })]);
  const r = await orchestrator.routeIntent({ openai, message: 'x' });
  assert.equal(r.intent, 'general');
});

test('orchestrator.pipeline: review_and_test runs review then test-gen on flagged files', async () => {
  const uid = `or-${Math.random()}`;
  const col = 'or-pipe';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [{ text: 'function f(){ return 1; }', source: 'svc.js' }]);

  // Script:
  //   code-review:
  //     1) static_checks call
  //     2) final with 1 finding on svc.js
  //   test-gen (for svc.js):
  //     1) final with 1 test
  const openai = scriptedChat([
    JSON.stringify({ tool: 'static_checks', args: { source: 'svc.js' } }),
    JSON.stringify({ final: { summary: 's', findings: [
      { file: 'svc.js', severity: 'medium', category: 'correctness', issue: 'weird return', suggestion: 'return undefined explicitly' }
    ]}}),
    JSON.stringify({ final: {
      target: 'svc.js', framework: 'node:test',
      test_file: "require('node:test')",
      test_cases: [{ name: 'returns 1', scenario: 'happy_path' }],
      uncovered: [],
    }}),
  ]);

  const r = await orchestrator.pipeline({
    openai, userId: uid, collection: col,
    recipe: 'review_and_test',
    input: { files: ['svc.js'] },
  });
  assert.equal(r.recipe, 'review_and_test');
  assert.ok(r.steps.some(s => s.name === 'code_review'));
  assert.ok(r.steps.some(s => s.name === 'test_gen'));
});

test('orchestrator.pipeline: unknown recipe throws', async () => {
  const openai = scriptedChat([]);
  await assert.rejects(
    async () => orchestrator.pipeline({
      openai, userId: 'u', collection: 'c', recipe: 'nonexistent', input: {},
    }),
    /unknown recipe/,
  );
});
