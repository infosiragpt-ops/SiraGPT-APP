/**
 * Tests for the local sandbox + sandbox router.
 *
 * The local executor is shelled to real `python3` / `node` binaries.
 * Where the test asserts on actual output, we use the embedded `node`
 * interpreter (process.execPath) — guaranteed present in CI without
 * needing extra setup. The python branch is exercised via stub `spawn`
 * so we don't gate CI on python3 being installed.
 *
 * Router tests cover the SANDBOX_PREFERENCE branching, fallback to
 * 'sandbox_no_backend', and the backend-tag passthrough.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const local = require('../src/services/sandbox/local-sandbox');
const router = require('../src/services/sandbox/router');

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── stub spawn helper ─────────────────────────────────────────────────────
function makeFakeChild({ stdout = '', stderr = '', exitCode = 0, errorAfterMs = null, hangForeverMs = null } = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from([Buffer.from(stdout)]);
  child.stderr = Readable.from([Buffer.from(stderr)]);
  let killed = false;
  child.kill = () => { killed = true; };
  // Wait for the streams to flush, then close. If `hangForeverMs` is
  // set, we never close and rely on the test's timeout to call kill().
  setImmediate(() => {
    if (errorAfterMs !== null) {
      setTimeout(() => child.emit('error', new Error('spawn-failed')), errorAfterMs);
      return;
    }
    if (hangForeverMs !== null) {
      // Never close on our own — wait for kill() then emit close.
      const i = setInterval(() => {
        if (killed) {
          clearInterval(i);
          child.emit('close', null, 'SIGKILL');
        }
      }, 5);
      return;
    }
    setImmediate(() => child.emit('close', exitCode, null));
  });
  return child;
}

// ── local-sandbox unit tests ─────────────────────────────────────────────

test('local: rejects unknown language', async () => {
  const out = await local.executeLocal({ code: 'echo hi', language: 'cobol' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_language_not_allowed');
});

test('local: rejects empty code', async () => {
  const out = await local.executeLocal({ code: '   ', language: 'python' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_empty_code');
});

test('local: returns sandbox_disabled when LOCAL_SANDBOX_ENABLED=0', async () => {
  await withEnv({ LOCAL_SANDBOX_ENABLED: '0' }, async () => {
    const out = await local.executeLocal({ code: 'x', language: 'python' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'sandbox_disabled');
  });
});

test('local: ok path with stub spawn returns ok+stdout+exitCode', async () => {
  const out = await local.executeLocal(
    { code: 'print("hi")', language: 'python' },
    process.env,
    { spawnImpl: () => makeFakeChild({ stdout: 'hi\n', exitCode: 0 }) },
  );
  assert.equal(out.ok, true);
  assert.equal(out.stdout, 'hi\n');
  assert.equal(out.exitCode, 0);
  assert.ok(typeof out.durationMs === 'number');
});

test('local: stdout/stderr capped at maxOutputBytes with truncation flag', async () => {
  // The clampInt floor for maxOutputBytes is 1024, so we ask for 1500
  // and feed 5000 bytes — anything below the floor would silently
  // round up and confuse the assertion.
  const big = 'A'.repeat(5000);
  const out = await local.executeLocal(
    { code: 'unused', language: 'python', maxOutputBytes: 1500 },
    process.env,
    { spawnImpl: () => makeFakeChild({ stdout: big, exitCode: 0 }) },
  );
  assert.equal(out.ok, true);
  assert.equal(out.stdout.length, 1500);
  assert.equal(out.stdoutTruncated, true);
});

test('local: timeout path kills child and reports sandbox_timeout', async () => {
  const out = await local.executeLocal(
    { code: 'while True: pass', language: 'python', timeoutMs: 100 },
    process.env,
    { spawnImpl: () => makeFakeChild({ hangForeverMs: 5000 }) },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_timeout');
  assert.ok(out.durationMs >= 100);
}, { timeout: 5000 });

test('local: external AbortSignal kills child and reports sandbox_aborted', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort('caller'), 30);
  const out = await local.executeLocal(
    { code: 'while True: pass', language: 'python', timeoutMs: 5000 },
    process.env,
    { spawnImpl: () => makeFakeChild({ hangForeverMs: 5000 }), signal: ac.signal },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_aborted');
}, { timeout: 5000 });

test('local: spawn error surfaces sandbox_runtime_error', async () => {
  const out = await local.executeLocal(
    { code: 'x', language: 'python' },
    process.env,
    { spawnImpl: () => makeFakeChild({ errorAfterMs: 5 }) },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_runtime_error');
});

test('local: real node binary integration smoke (proves no quoting/injection bugs)', async () => {
  // Use the embedded node interpreter so this test does not depend on
  // python3 being installed in CI.
  const out = await local.executeLocal({
    code: "process.stdout.write('hello-from-node')",
    language: 'node',
    timeoutMs: 5000,
  });
  assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
  assert.equal(out.stdout, 'hello-from-node');
  assert.equal(out.exitCode, 0);
});

test('local: real node binary handles code with shell metacharacters safely', async () => {
  // If we accidentally went through `shell: true`, the `;` and
  // backticks would explode. With spawn(arg-array), they're literal.
  const tricky = "process.stdout.write('safe;`echo pwned`')";
  const out = await local.executeLocal({
    code: tricky,
    language: 'node',
    timeoutMs: 5000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.stdout, 'safe;`echo pwned`');
});

test('isLocalSandboxAvailable env probe is pure', () => {
  withEnv({ LOCAL_SANDBOX_ENABLED: '1' }, () => {
    assert.equal(local.isLocalSandboxAvailable(process.env, 'python'), true);
    assert.equal(local.isLocalSandboxAvailable(process.env, 'cobol'), false);
  });
  withEnv({ LOCAL_SANDBOX_ENABLED: '0' }, () => {
    assert.equal(local.isLocalSandboxAvailable(process.env, 'python'), false);
  });
});

// ── router tests ─────────────────────────────────────────────────────────

test('router: returns sandbox_no_backend when both backends disabled', async () => {
  const out = await router.executeCode(
    { code: 'x', language: 'python' },
    { LOCAL_SANDBOX_ENABLED: '0' /* and no E2B_API_KEY */ },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_no_backend');
  assert.equal(out.backend, 'none');
});

test('router: routes to local when only local is enabled', async () => {
  // Use real node interpreter for a fast end-to-end signal.
  const out = await router.executeCode(
    { code: "process.stdout.write('via-router')", language: 'node', timeoutMs: 5000 },
    { LOCAL_SANDBOX_ENABLED: '1', SANDBOX_PREFERENCE: 'local' },
  );
  assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
  assert.equal(out.backend, 'local');
  assert.equal(out.stdout, 'via-router');
});

test('router: SANDBOX_PREFERENCE skips a disabled backend and tries the next', async () => {
  // Prefer e2b first, but no E2B_API_KEY is set → router falls through
  // to local.
  const out = await router.executeCode(
    { code: "process.stdout.write('local-after-e2b-skip')", language: 'node', timeoutMs: 5000 },
    {
      LOCAL_SANDBOX_ENABLED: '1',
      SANDBOX_PREFERENCE: 'e2b,local',
      // intentionally no E2B_API_KEY
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.backend, 'local');
});

test('router: describeBackends returns availability + preference', () => {
  const summary = router.describeBackends({
    LOCAL_SANDBOX_ENABLED: '1',
    SANDBOX_PREFERENCE: 'local,e2b',
  });
  assert.equal(summary.local.available, true);
  assert.equal(summary.e2b.available, false);
  assert.deepEqual(summary.preference, ['local', 'e2b']);
});

test('router: invalid SANDBOX_PREFERENCE values are dropped, defaults restored', () => {
  const summary = router.describeBackends({
    SANDBOX_PREFERENCE: 'nonsense, alsonope',
  });
  // Both invalid → fall back to default order.
  assert.deepEqual(summary.preference, ['e2b', 'local']);
});
