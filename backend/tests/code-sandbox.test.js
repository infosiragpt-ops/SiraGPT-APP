/**
 * Tests for the code sandbox — defense-in-depth boundaries.
 *
 * We test the real child_process execution here; these are slow
 * relative to pure-logic tests but they're the only way to verify
 * timeout + crash + output-cap behaviour actually holds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, runTests } = require('../src/services/agents/code-sandbox');

// ─── Python basics ───────────────────────────────────────────────────────

test('sandbox/python: successful run returns stdout', async () => {
  const r = await run({ language: 'python', source: 'print(2 + 2)' });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^4\s*$/);
  assert.equal(r.timedOut, false);
});

test('sandbox/python: non-zero exit → ok=false, stderr captured', async () => {
  const r = await run({ language: 'python', source: 'raise ValueError("boom")' });
  assert.equal(r.ok, false);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /ValueError: boom/);
});

test('sandbox/python: timeout kills hung process', async () => {
  const r = await run({
    language: 'python',
    source: 'import time\nwhile True:\n    time.sleep(0.1)\n',
    timeoutMs: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  // Duration is bounded by the timeout + a small overhead for signal
  // delivery + child cleanup. 2× gives comfortable slack on slow CI.
  assert.ok(r.durationMs < 2000, `expected <2000ms, got ${r.durationMs}`);
});

// ─── JavaScript basics ───────────────────────────────────────────────────

test('sandbox/javascript: successful run', async () => {
  const r = await run({ language: 'javascript', source: 'console.log(Math.max(1,2,3));' });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^3\s*$/);
});

test('sandbox/javascript: thrown error', async () => {
  const r = await run({ language: 'javascript', source: 'throw new Error("nope")' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /nope/);
});

// ─── Isolation + env stripping ───────────────────────────────────────────

test('sandbox: OPENAI_API_KEY is NOT exposed to the child process', async () => {
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-secret-should-not-leak-abc123';
  try {
    const r = await run({
      language: 'python',
      source: 'import os\nprint(os.environ.get("OPENAI_API_KEY", "ABSENT"))',
    });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /^ABSENT\s*$/);
    assert.ok(!r.stdout.includes('sk-secret-should-not-leak'));
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test('sandbox: temp dir is separate from the server cwd', async () => {
  // The child sees a fresh cwd that is NOT the project directory.
  const r = await run({
    language: 'python',
    source: 'import os\nprint(os.getcwd())\nprint("\\n".join(sorted(os.listdir("."))))',
  });
  assert.equal(r.ok, true);
  // Fresh dir: only main.py should be visible inside it.
  const lines = r.stdout.trim().split('\n');
  const listing = lines.slice(1);
  assert.deepEqual(listing, ['main.py']);
});

// ─── Output capping ──────────────────────────────────────────────────────

test('sandbox: stdout larger than cap is truncated', async () => {
  const r = await run({
    language: 'python',
    source: 'print("x" * 500_000)',
    maxOutputBytes: 1024,
  });
  assert.ok(r.truncated);
  assert.ok(r.stdout.length < 100_000, `expected truncation, got ${r.stdout.length} bytes`);
});

// ─── runTests harness ────────────────────────────────────────────────────

test('sandbox/runTests python: all pass', async () => {
  const source = 'def add(a, b):\n    return a + b\n';
  const testBody =
    '_check("2+3", add(2, 3) == 5)\n' +
    '_check("-1+1", add(-1, 1) == 0)\n';
  const r = await runTests({ language: 'python', source, testSource: testBody });
  assert.equal(r.ok, true);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.failures.length, 0);
});

test('sandbox/runTests python: mixed pass + fail yields failures list', async () => {
  const source = 'def add(a, b):\n    return a + b + 1\n';  // intentionally wrong
  const testBody =
    '_check("2+3", add(2, 3) == 5, detail="got " + str(add(2, 3)))\n' +
    '_check("always true", 1 == 1)\n';
  const r = await runTests({ language: 'python', source, testSource: testBody });
  assert.equal(r.ok, false);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].name, '2+3');
});

test('sandbox/runTests javascript: all pass', async () => {
  const source = 'function mul(a, b) { return a * b; }\n';
  const testBody =
    '_check("2*3", mul(2, 3) === 6);\n' +
    '_check("0*5", mul(0, 5) === 0);\n';
  const r = await runTests({ language: 'javascript', source, testSource: testBody });
  assert.equal(r.ok, true);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
});

test('sandbox/runTests: harness exception counted as a single failure', async () => {
  const source = 'def add(a, b):\n    return a + b\n';
  const testBody =
    '_check("normal", add(1, 2) == 3)\n' +
    'raise RuntimeError("harness error")\n';
  const r = await runTests({ language: 'python', source, testSource: testBody });
  assert.equal(r.ok, false);
  assert.ok(r.failed >= 1);
  assert.ok(r.failures.some(f => /harness error|RuntimeError/.test(f.detail)));
});

// ─── Language / input validation ─────────────────────────────────────────

test('sandbox: unsupported language is rejected', async () => {
  const r = await run({ language: 'ruby', source: 'puts 1' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /unsupported language/);
});

test('sandbox: empty source is rejected', async () => {
  const r = await run({ language: 'python', source: '' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /empty source/);
});
