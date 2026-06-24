/**
 * Tests for the code sandbox — defense-in-depth boundaries.
 *
 * We test the real child_process execution here; these are slow
 * relative to pure-logic tests but they're the only way to verify
 * timeout + crash + output-cap behaviour actually holds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('fs');
const os = require('os');
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

// ─── Fixture file path safety ────────────────────────────────────────────

test('sandbox: fixture file with .. traversal is rejected silently', async () => {
  const r = await run({
    language: 'python',
    source: 'import os\nprint(sorted(os.listdir(".")))',
    files: { '../escape.txt': 'pwned' },
  });
  assert.equal(r.ok, true);
  // ../escape.txt must NOT have been written; only main.py is visible.
  assert.match(r.stdout, /\['main\.py'\]/);
});

test('sandbox: fixture file with absolute path is rejected', async () => {
  const r = await run({
    language: 'python',
    source: 'import os\nprint(sorted(os.listdir(".")))',
    files: { '/tmp/evil.txt': 'pwned' },
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /\['main\.py'\]/);
});

test('sandbox: nested fixture file in subdir is allowed', async () => {
  const r = await run({
    language: 'python',
    source: 'open("data/note.txt").read()\nprint("ok")',
    files: { 'data/note.txt': 'hello' },
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^ok\s*$/);
});

test('sandbox/runTests: unsupported language returns full shape', async () => {
  const r = await runTests({ language: 'ruby', source: '', testSource: '' });
  assert.equal(r.ok, false);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.exitCode, null);
  assert.equal(typeof r.durationMs, 'number');
  assert.deepEqual(r.failures, []);
});

// ─── Hardened input boundary (structured errors, never escaping throws) ──

test('sandbox: run(null) resolves with structured error instead of throwing', async () => {
  const r = await run(null);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.match(r.stderr, /unsupported language/);
});

test('sandbox: run() with no args resolves with structured error', async () => {
  const r = await run();
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.equal(typeof r.stderr, 'string');
});

test('sandbox: non-string source resolves with structured error', async () => {
  const r = await run({ language: 'javascript', source: 42 });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid source.*number/);
});

test('sandbox: null source resolves with structured error', async () => {
  const r = await run({ language: 'javascript', source: null });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid source.*null/);
});

test('sandbox/runTests: null opts resolves with full structured shape', async () => {
  const r = await runTests(null);
  assert.equal(r.ok, false);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.exitCode, null);
  assert.deepEqual(r.failures, []);
});

test('sandbox/runTests: non-string testSource is rejected cleanly', async () => {
  const r = await runTests({ language: 'python', source: 'x = 1', testSource: null });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid testSource.*null/);
  assert.equal(r.passed, 0);
  assert.deepEqual(r.failures, []);
});

test('sandbox/runTests: non-string source is rejected cleanly', async () => {
  const r = await runTests({ language: 'javascript', source: { code: 'x' }, testSource: '_check("t", true);' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid source.*object/);
});

// ─── Output-cap hardening (cap must not be bypassable) ──────────────────

test('sandbox: maxOutputBytes=Infinity falls back to the default cap', async () => {
  const r = await run({
    language: 'javascript',
    source: 'for (let i = 0; i < 5000; i++) console.log("y".repeat(100));',
    maxOutputBytes: Infinity,
  });
  assert.equal(r.truncated, true, 'oversized output must still be marked truncated');
  assert.ok(r.stdout.length <= 70_000, `cap bypassed: got ${r.stdout.length} bytes`);
});

test('sandbox: maxOutputBytes=NaN does not destroy captured output', async () => {
  const r = await run({
    language: 'javascript',
    source: 'console.log("hello-sandbox");',
    maxOutputBytes: NaN,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /hello-sandbox/);
});

test('sandbox: negative maxOutputBytes falls back to default cap', async () => {
  const r = await run({
    language: 'javascript',
    source: 'console.log("neg-cap-ok");',
    maxOutputBytes: -5,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /neg-cap-ok/);
});

test('sandbox: cap holds against many small output chunks', async () => {
  // 20k separate 2-byte writes — the cap must apply to the accumulated
  // buffer, not per-chunk, so tiny chunks cannot slip past it.
  const r = await run({
    language: 'javascript',
    source: 'for (let i = 0; i < 20000; i++) process.stdout.write("ab");',
    maxOutputBytes: 2048,
  });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 2048 + 64, `expected ≤${2048 + 64} chars, got ${r.stdout.length}`);
});

test('sandbox: timeoutMs=NaN falls back to default instead of insta-kill', async () => {
  const r = await run({
    language: 'javascript',
    source: 'console.log("alive");',
    timeoutMs: NaN,
  });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /alive/);
});

test('sandbox: non-numeric memoryMb falls back to default', async () => {
  const r = await run({
    language: 'javascript',
    source: 'console.log("mem-ok");',
    memoryMb: 'lots',
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /mem-ok/);
});

// ─── Resource release on rejected/errored runs ───────────────────────────

test('sandbox: non-AbortSignal signal object is ignored, not fatal', async () => {
  // A truthy non-signal used to throw `signal.addEventListener is not a
  // function` AFTER spawning the child — leaking a live process + temp dir.
  const r = await run({
    language: 'javascript',
    source: 'console.log("sig-ok");',
    signal: { aborted: false },
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /sig-ok/);
});

test('sandbox: duck-typed pre-aborted signal still returns structured aborted result', async () => {
  const r = await run({
    language: 'javascript',
    source: 'console.log(1);',
    signal: { aborted: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.match(r.stderr, /aborted/);
});

test('sandbox: fixture-write failure resolves cleanly and releases the temp dir', async () => {
  const sandboxDirs = () =>
    fsSync.readdirSync(os.tmpdir()).filter(n => n.startsWith('siragpt-sandbox-'));
  const before = new Set(sandboxDirs());
  // 'data' is written as a FILE first, so mkdir('data/') for the second
  // fixture throws EEXIST mid-setup. That error used to escape as a
  // rejected promise and leak the temp dir.
  const r = await run({
    language: 'python',
    source: 'print("never runs")',
    files: { data: 'I am a file', 'data/nested.txt': 'needs data/ to be a dir' },
  });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /sandbox internal error/);
  for (const d of sandboxDirs()) {
    assert.ok(before.has(d), `leaked sandbox temp dir: ${d}`);
  }
});
