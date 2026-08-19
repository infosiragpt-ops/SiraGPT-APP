/**
 * Real-LLM smoke tests — opt-in.
 *
 * Runs a single round-trip through each specialist against the real
 * OpenAI API. SKIPPED unless OPENAI_LIVE_TESTS=1 is set in the env,
 * so CI stays fast and free.
 *
 * What we verify when LIVE:
 *   - The prompt format is accepted (no 400s from response_format)
 *   - The specialist returns a result with the expected shape
 *   - No obvious drift (e.g. the model wrote prose instead of JSON)
 *
 * We deliberately keep prompts tiny and maxIters low so a full suite
 * run costs < $0.05 on gpt-4o-mini. If you're running this, bring a
 * funded API key.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const LIVE = process.env.OPENAI_LIVE_TESTS === '1';
const hasKey = !!process.env.OPENAI_API_KEY && !/^fake|test/i.test(process.env.OPENAI_API_KEY);

// Guard: if not opted in, emit ONE passing placeholder so test runners
// don't report "no tests". If opted in without a key, fail loud.
if (!LIVE) {
  test('e2e-live: skipped (set OPENAI_LIVE_TESTS=1 to run)', () => {
    assert.ok(true);
  });
} else if (!hasKey) {
  test('e2e-live: OPENAI_LIVE_TESTS=1 but no real OPENAI_API_KEY — failing', () => {
    assert.fail('Set a real OPENAI_API_KEY to run live tests.');
  });
} else {
  // Only load the services when we're going live — otherwise the fake
  // openai stub from other tests may have cached a polluted module.
  delete require.cache[require.resolve('openai')];
  const rag = require('../src/services/rag-service');
  const codeReview = require('../src/services/agents/code-review-agent');
  const testGen = require('../src/services/agents/test-gen-agent');
  const debugAgent = require('../src/services/agents/debug-agent');
  const codeGen = require('../src/services/agents/code-gen-agent');
  const staticCheck = require('../src/services/agents/static-check-agent');
  const maintenance = require('../src/services/agents/maintenance-agent');
  const orchestrator = require('../src/services/agents/se-orchestrator');

  const openai = rag.getOpenAI();
  if (!openai) throw new Error('getOpenAI() returned null despite a real key');

  const uid = `live-${Date.now()}`;
  const col = 'live-smoke';

  // Seed a tiny codebase so the agents have something to read.
  const SRC = `// math.ts
/**
 * Return x + y. Does NOT handle BigInt.
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

  test('e2e-live: seed a tiny code collection', async () => {
    await rag.clear(uid, col);
    const r = await rag.ingestCode(uid, col, [{
      filename: 'math.ts', content: SRC, language: 'typescript',
    }]);
    assert.ok(r.chunksAdded >= 1);
  });

  test('e2e-live: code-review returns structured findings', async () => {
    const r = await codeReview.review({
      openai, userId: uid, collection: col,
      files: ['math.ts'], maxIters: 4,
    });
    assert.ok(r);
    assert.ok(Array.isArray(r.findings));
    assert.ok(r.iterations >= 1);
  });

  test('e2e-live: test-gen produces a test file string', async () => {
    const r = await testGen.generate({
      openai, userId: uid, collection: col,
      source: 'math.ts', symbol: 'add', language: 'typescript', maxIters: 5,
    });
    assert.ok(r);
    assert.ok(typeof r.test_file === 'string');
    assert.ok(Array.isArray(r.test_cases));
  });

  test('e2e-live: debug with a mock stacktrace returns hypothesis', async () => {
    const r = await debugAgent.debug({
      openai, userId: uid, collection: col,
      error: `TypeError: add is not a function\n  at test (/app/math.test.ts:3:10)`,
      maxIters: 5,
    });
    assert.ok(r);
    assert.ok(typeof r.hypothesis === 'string');
  });

  test('e2e-live: code-gen produces a code string', async () => {
    const r = await codeGen.generate({
      openai, userId: uid, collection: col,
      spec: 'A pure function multiply(a, b) that multiplies two numbers.',
      language: 'typescript', maxIters: 5,
    });
    assert.ok(r);
    assert.ok(typeof r.code === 'string');
    assert.ok(r.code.length > 0);
  });

  test('e2e-live: static-check runs end-to-end', async () => {
    const r = await staticCheck.check({
      openai, userId: uid, collection: col,
      files: ['math.ts'], maxIters: 3,
    });
    assert.ok(r);
    assert.ok(Array.isArray(r.findings));
  });

  test('e2e-live: maintenance with a prose ticket returns status', async () => {
    const r = await maintenance.resolve({
      openai, userId: uid, collection: col,
      ticket: 'add() seems to return the wrong value when both inputs are negative',
      maxIters: 6,
    });
    assert.ok(r);
    assert.ok(['resolved', 'likely_fix', 'not_localised', 'out_of_scope'].includes(r.status));
  });

  test('e2e-live: orchestrator.routeIntent classifies a clear message', async () => {
    const r = await orchestrator.routeIntent({
      openai, message: 'Please generate unit tests for the add function in math.ts',
    });
    assert.ok(['test_gen', 'general'].includes(r.intent),
      `expected test_gen or general, got ${r.intent}`);
  });
}
