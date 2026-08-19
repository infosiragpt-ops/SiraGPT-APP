'use strict';

// execInRun — the real Shell backend. Exercises the ownership / not-found /
// empty / oversize gates and a genuine command run in a temp dir (stdout,
// exit code, non-zero exit, output cap). Uses the test-only run seeder so no
// dev server is spawned.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hr = require('../src/services/code/host-runner');

let dir;
beforeEach(() => {
  hr._resetRunsForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-test-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('execInRun: unknown run → 404', async () => {
  const r = await hr.execInRun('nope', 'u1', 'ls');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('execInRun: another user\'s run → 403 (never executes)', async () => {
  hr._seedRunForTest({ runId: 'r1', userId: 'owner', dir });
  const r = await hr.execInRun('r1', 'attacker', 'ls');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('execInRun: empty command → 400', async () => {
  hr._seedRunForTest({ runId: 'r2', userId: 'u1', dir });
  const r = await hr.execInRun('r2', 'u1', '   ');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('execInRun: oversize command → 400 (never executes)', async () => {
  hr._seedRunForTest({ runId: 'r3', userId: 'u1', dir });
  const r = await hr.execInRun('r3', 'u1', 'x'.repeat(5000));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('execInRun: runs a real command in the run dir (stdout + exit 0)', async () => {
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
  hr._seedRunForTest({ runId: 'r4', userId: 'u1', dir });
  const r = await hr.execInRun('r4', 'u1', 'ls');
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /hello\.txt/);
});

test('execInRun: cwd is the run dir (pwd matches)', async () => {
  hr._seedRunForTest({ runId: 'r5', userId: 'u1', dir });
  const r = await hr.execInRun('r5', 'u1', 'pwd');
  assert.equal(r.ok, true);
  // realpath: macOS /tmp is a symlink to /private/tmp, so compare basenames.
  assert.equal(path.basename(r.output.trim()), path.basename(dir));
});

test('execInRun: non-zero exit is reported (ok:false, exitCode set)', async () => {
  hr._seedRunForTest({ runId: 'r6', userId: 'u1', dir });
  const r = await hr.execInRun('r6', 'u1', 'exit 3');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});

test('execInRun: output is capped + flagged truncated', async () => {
  hr._seedRunForTest({ runId: 'r7', userId: 'u1', dir });
  // Emit ~1MB; the cap is 200KB by default.
  const r = await hr.execInRun('r7', 'u1', 'yes ABCDEFGHIJ | head -c 1000000');
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 200_100, `output ${r.output.length} should be capped`);
});

test('execInRun: hard timeout kills a long command', async () => {
  hr._seedRunForTest({ runId: 'r8', userId: 'u1', dir });
  const r = await hr.execInRun('r8', 'u1', 'sleep 5', { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});
