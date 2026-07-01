'use strict';

// Type-verification endpoint plumbing: parseTscOutput (pure) and verifyRun's
// ownership / not-found / no-tsconfig gates, using the test-only run seeder.
// The real `npx tsc` spawn is exercised in production images; it is fail-open
// (spawn error → skipped) so a missing tsc can never block the preview flow.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hr = require('../src/services/code/host-runner');

beforeEach(() => hr._resetRunsForTest());

// ── parseTscOutput ─────────────────────────────────────────────

test('parseTscOutput: parses tsc --pretty false diagnostics', () => {
  const out = [
    'src/App.tsx(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'lib/store.ts(3,10): error TS2304: Cannot find name \'Fooo\'.',
    'noise line without diagnostics',
  ].join('\n');
  const errors = hr.parseTscOutput(out);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], {
    file: 'src/App.tsx', line: 12, col: 5, code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'.",
  });
  assert.equal(errors[1].code, 'TS2304');
});

test('parseTscOutput: empty/clean output → no errors; bounded at 50', () => {
  assert.deepEqual(hr.parseTscOutput(''), []);
  assert.deepEqual(hr.parseTscOutput(null), []);
  const many = Array.from({ length: 80 }, (_, i) => `a.ts(${i + 1},1): error TS1: x`).join('\n');
  assert.equal(hr.parseTscOutput(many).length, 50);
});

// ── verifyRun gates ────────────────────────────────────────────

test('verifyRun: unknown run → 404', async () => {
  const r = await hr.verifyRun('nope', 'u1');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('verifyRun: ownership mismatch → 403', async () => {
  hr._seedRunForTest({ runId: 'r1', userId: 'owner', dir: '/tmp/none' });
  const r = await hr.verifyRun('r1', 'intruder');
  assert.equal(r.status, 403);
});

test('verifyRun: JS-only project (no tsconfig) → ok, skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-verify-'));
  hr._seedRunForTest({ runId: 'r2', userId: 'u1', dir });
  const r = await hr.verifyRun('r2', 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_tsconfig');
});
