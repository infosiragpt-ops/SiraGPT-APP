'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_STORE = path.join(os.tmpdir(), `siragpt-research-run-test-${process.pid}-${Date.now()}`);
process.env.RESEARCH_RUN_STORE_DIR = TEST_STORE;
process.env.RESEARCH_RUN_RETENTION_MS = '60000'; // 60s for faster pruning tests

const store = require('../src/services/research-run-store');
const { createRunId, loadRun, saveRun, appendEvent, pruneOldRuns, STORE_DIR } = store;

test.after(() => {
  try { fs.rmSync(TEST_STORE, { recursive: true, force: true }); } catch (_) {}
});

test('exports the documented surface', () => {
  assert.equal(typeof createRunId, 'function');
  assert.equal(typeof loadRun, 'function');
  assert.equal(typeof saveRun, 'function');
  assert.equal(typeof appendEvent, 'function');
  assert.equal(typeof pruneOldRuns, 'function');
  assert.equal(typeof STORE_DIR, 'string');
  assert.equal(STORE_DIR, TEST_STORE);
});

test('createRunId returns an opaque UUID identity', () => {
  const id = createRunId('quantum mechanics');
  assert.match(id, /^rr_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('separate turns always get distinct identities, including identical queries', () => {
  const a = createRunId('one');
  const b = createRunId('one');
  assert.notEqual(a, b);
});

test('loadRun returns null when the file does not exist', () => {
  assert.equal(loadRun('rr_does_not_exist'), null);
});

test('saveRun + loadRun round-trip preserves the run shape and stamps updatedAt', () => {
  const runId = 'rr_test_' + crypto.randomBytes(4).toString('hex');
  const run = { id: runId, query: 'photosynthesis', stage: 'planning', events: [] };
  saveRun(run);
  const loaded = loadRun(runId);
  assert.ok(loaded);
  assert.equal(loaded.id, runId);
  assert.equal(loaded.query, 'photosynthesis');
  assert.equal(loaded.stage, 'planning');
  assert.equal(typeof loaded.updatedAt, 'number');
});

test('saveRun returns null when the run has no id', () => {
  assert.equal(saveRun({ query: 'no id' }), null);
  assert.equal(saveRun(null), null);
  assert.equal(saveRun(undefined), null);
});

test('appendEvent creates a new run when one does not yet exist', () => {
  const runId = 'rr_new_' + crypto.randomBytes(4).toString('hex');
  appendEvent(runId, { phase: 'search', label: 'started' });
  const loaded = loadRun(runId);
  assert.ok(loaded);
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].phase, 'search');
  assert.equal(loaded.events[0].label, 'started');
  assert.equal(typeof loaded.events[0].ts, 'number');
  assert.equal(typeof loaded.createdAt, 'number');
});

test('appendEvent appends to an existing run preserving prior events', () => {
  const runId = 'rr_append_' + crypto.randomBytes(4).toString('hex');
  appendEvent(runId, { phase: 'search', label: 'started' });
  appendEvent(runId, { phase: 'browse', label: 'page-1' });
  appendEvent(runId, { phase: 'synth', label: 'done' });
  const loaded = loadRun(runId);
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.events[0].label, 'started');
  assert.equal(loaded.events[2].label, 'done');
});

test('appendEvent normalises corrupted events arrays (non-array becomes [])', () => {
  const runId = 'rr_corrupt_' + crypto.randomBytes(4).toString('hex');
  // Manually write a corrupted run with events: not-an-array
  const file = path.join(STORE_DIR, `${runId}.json`);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: runId, events: 'not-an-array' }));
  appendEvent(runId, { phase: 'recovered' });
  const loaded = loadRun(runId);
  assert.ok(Array.isArray(loaded.events));
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].phase, 'recovered');
});

test('saveRun writes atomically via .tmp + rename (no stale .tmp files linger)', () => {
  const runId = 'rr_atomic_' + crypto.randomBytes(4).toString('hex');
  saveRun({ id: runId, query: 'check atomic' });
  const tmpLinger = fs.readdirSync(STORE_DIR).some((f) => f.includes('.tmp'));
  assert.equal(tmpLinger, false, 'no .tmp files must linger after a successful save');
});

test('loadRun returns null when the file is malformed JSON', () => {
  const runId = 'rr_malformed_' + crypto.randomBytes(4).toString('hex');
  const file = path.join(STORE_DIR, `${runId}.json`);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(file, '{not-json');
  assert.equal(loadRun(runId), null);
});

test('pruneOldRuns deletes files older than RETENTION_MS, leaves fresh ones', () => {
  const old = 'rr_old_' + crypto.randomBytes(4).toString('hex');
  const fresh = 'rr_fresh_' + crypto.randomBytes(4).toString('hex');
  saveRun({ id: old, query: 'stale' });
  saveRun({ id: fresh, query: 'recent' });
  store.requestCancel(old);

  // Backdate the old file by 5 minutes
  const oldFile = path.join(STORE_DIR, `${old}.json`);
  const past = (Date.now() - 5 * 60 * 1000) / 1000;
  fs.utimesSync(oldFile, past, past);

  const pruned = pruneOldRuns();
  assert.ok(pruned >= 1, 'must prune at least the backdated run');
  assert.equal(loadRun(old), null, 'stale run must be gone');
  assert.equal(store.isCancelled(old), false, 'expired cancellation marker must be gone');
  assert.ok(loadRun(fresh), 'fresh run must remain');
});

test('crafted run identifiers are rejected instead of being aliased to another run', () => {
  const dirty = '../../escape/' + crypto.randomBytes(2).toString('hex');
  assert.throws(() => appendEvent(dirty, { phase: 'attempt' }), { status: 400 });
  const allWithinRoot = fs.readdirSync(STORE_DIR).every((f) =>
    path.resolve(path.join(STORE_DIR, f)).startsWith(path.resolve(STORE_DIR))
  );
  assert.equal(allWithinRoot, true, 'no files may escape STORE_DIR via crafted run id');
});

test('exclusive claim cannot overwrite an existing run, and heartbeat cannot erase cancellation', () => {
  const id = createRunId();
  assert.equal(store.claimRun({ id, userId: 'owner' }), true);
  assert.equal(store.claimRun({ id, userId: 'different' }), false);
  assert.equal(loadRun(id).userId, 'owner');
  store.requestCancel(id);
  saveRun({ ...loadRun(id), heartbeatAt: Date.now() });
  assert.equal(store.isCancelled(id), true);
});
