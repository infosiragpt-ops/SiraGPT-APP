'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Force the store root into a per-process temp dir BEFORE the module
// is required so STORE_ROOT (captured at module load time) lands in
// our sandbox and we never touch the real uploads/cowork-store path.
const TEST_STORE_ROOT = path.join(os.tmpdir(), `siragpt-cowork-test-${process.pid}-${Date.now()}`);
process.env.SIRAGPT_COWORK_STORE_DIR = TEST_STORE_ROOT;

const persistence = require('../src/services/cowork-disk-persistence');
const {
  STORE_ROOT,
  loadMemoryEntries,
  saveMemoryEntries,
  loadSessions,
  saveSessions,
} = persistence;

function userId() {
  return 'u-' + crypto.randomBytes(6).toString('hex');
}

test.after(() => {
  // Best-effort cleanup of the temp store
  try { fs.rmSync(TEST_STORE_ROOT, { recursive: true, force: true }); } catch (_) {}
});

test('exports the documented surface', () => {
  assert.equal(typeof STORE_ROOT, 'string');
  assert.equal(STORE_ROOT, TEST_STORE_ROOT, 'STORE_ROOT must honour SIRAGPT_COWORK_STORE_DIR');
  assert.equal(typeof loadMemoryEntries, 'function');
  assert.equal(typeof saveMemoryEntries, 'function');
  assert.equal(typeof loadSessions, 'function');
  assert.equal(typeof saveSessions, 'function');
});

test('loadMemoryEntries returns [] when no file exists for the user', () => {
  const id = userId();
  assert.deepEqual(loadMemoryEntries(id), []);
});

test('saveMemoryEntries + loadMemoryEntries round-trip preserves entries', () => {
  const id = userId();
  const entries = [
    { id: 'm1', content: 'fact-a', strength: 0.5 },
    { id: 'm2', content: 'fact-b', strength: 0.9 },
  ];
  saveMemoryEntries(id, entries);
  assert.deepEqual(loadMemoryEntries(id), entries);
});

test('saveMemoryEntries normalises non-array input to []', () => {
  const id = userId();
  saveMemoryEntries(id, null);
  assert.deepEqual(loadMemoryEntries(id), []);
  saveMemoryEntries(id, 'not-an-array');
  assert.deepEqual(loadMemoryEntries(id), []);
});

test('loadSessions returns [] when no file exists', () => {
  const id = userId();
  assert.deepEqual(loadSessions(id), []);
});

test('saveSessions + loadSessions round-trip preserves session data', () => {
  const id = userId();
  const sessions = [
    { id: 's1', createdAt: Date.now(), title: 'first chat' },
    { id: 's2', createdAt: Date.now() + 1, title: 'second' },
  ];
  saveSessions(id, sessions);
  assert.deepEqual(loadSessions(id), sessions);
});

test('files are written atomically via a .tmp + rename pipeline', () => {
  // A direct way to observe this: after save, the .tmp file must NOT exist.
  // (If the rename failed, .tmp would linger and the real file would be
  // missing or stale.)
  const id = userId();
  saveMemoryEntries(id, [{ id: 'a' }]);
  const userFile = fs.readdirSync(path.join(STORE_ROOT, 'memory')).find((n) => n.startsWith(`${id}.`));
  // Either the final `<id>.json` exists OR a stale `.tmp` lingers — we
  // require the former for a clean rename.
  assert.match(userFile || '', /\.json$/, 'final file must end with .json');
  const tmpStillThere = fs.readdirSync(path.join(STORE_ROOT, 'memory')).some((n) => n.includes('.tmp'));
  assert.equal(tmpStillThere, false, 'no .tmp files must linger after a successful save');
});

test('user IDs with path separators / shell metachars are sanitised before hitting disk', () => {
  const dirtyId = 'user@evil.com/../escape';
  saveMemoryEntries(dirtyId, [{ id: 'm' }]);
  // Implementation strips everything except [a-zA-Z0-9._-] so path
  // separators are gone (the surviving "." chars are harmless inside a
  // filename — path.join doesn't reinterpret them as parent-dir refs
  // unless they form a standalone segment, which they can't here).
  const files = fs.readdirSync(path.join(STORE_ROOT, 'memory'));
  for (const f of files) {
    assert.equal(f.includes('@'), false, 'no @ allowed in filename');
    assert.equal(f.includes('/'), false, 'no / allowed in filename');
  }
  // The dirty id should be normalised into a single filename inside our
  // sandboxed memory/ subdir — never above STORE_ROOT.
  const allWithinRoot = files.every((f) => path.resolve(path.join(STORE_ROOT, 'memory', f)).startsWith(path.resolve(STORE_ROOT)));
  assert.equal(allWithinRoot, true, 'all written files must live inside STORE_ROOT');
});

test('empty / null userId falls back to "anonymous" filename', () => {
  saveMemoryEntries('', [{ id: 'anon-a' }]);
  saveMemoryEntries(null, [{ id: 'anon-b' }]);
  // Both should land in the same anonymous.json file (last write wins)
  const files = fs.readdirSync(path.join(STORE_ROOT, 'memory'));
  assert.ok(files.includes('anonymous.json'), 'expected anonymous.json fallback file');
});

test('loadJson swallows JSON parse errors and returns the fallback', () => {
  const id = userId();
  // Manually write a malformed JSON file at the path the module would use.
  const sanitised = String(id).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  const filePath = path.join(STORE_ROOT, 'memory', `${sanitised}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not-json');
  // loadMemoryEntries should return [] (the fallback for entries)
  assert.deepEqual(loadMemoryEntries(id), []);
});
