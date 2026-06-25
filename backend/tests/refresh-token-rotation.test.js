'use strict';

// Unit tests for the refresh-token rotation family store — the replay-attack
// prevention layer (a reused/stale token version revokes the whole family).
// STORE_DIR + the TTL are read at module load, so the env is set BEFORE require.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rotation-'));
process.env.REFRESH_TOKEN_STORE_DIR = STORE_DIR;
process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = '1';

const rot = require('../src/services/auth/refresh-token-rotation');

after(() => { try { fs.rmSync(STORE_DIR, { recursive: true, force: true }); } catch { /* noop */ } });

test('enabled() reflects the SIRAGPT_REFRESH_TOKEN_ROTATION flag', () => {
  const prev = process.env.SIRAGPT_REFRESH_TOKEN_ROTATION;
  try {
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = '1';
    assert.equal(rot.enabled(), true);
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = '0';
    assert.equal(rot.enabled(), false);
    delete process.env.SIRAGPT_REFRESH_TOKEN_ROTATION;
    assert.equal(rot.enabled(), false);
  } finally {
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = prev;
  }
});

test('createFamily persists a loadable family at version 1', () => {
  const fam = rot.createFamily('user-123');
  assert.match(fam.familyId, /^rf_[0-9a-f]{24}$/);
  assert.equal(fam.userId, 'user-123');
  assert.equal(fam.version, 1);
  assert.equal(fam.revoked, false);
  const loaded = rot.loadFamily(fam.familyId);
  assert.equal(loaded.familyId, fam.familyId);
  assert.equal(loaded.version, 1);
});

test('rotateFamily increments the version; unknown/revoked → invalid_family', () => {
  const fam = rot.createFamily('u');
  const r1 = rot.rotateFamily(fam.familyId);
  assert.equal(r1.ok, true);
  assert.equal(r1.family.version, 2);
  assert.equal(rot.loadFamily(fam.familyId).version, 2);
  assert.deepEqual(rot.rotateFamily('rf_does_not_exist'), { ok: false, reason: 'invalid_family' });
  rot.revokeFamily(fam.familyId);
  assert.deepEqual(rot.rotateFamily(fam.familyId), { ok: false, reason: 'invalid_family' });
});

test('revokeFamily marks the family revoked; unknown → false', () => {
  const fam = rot.createFamily('u');
  assert.equal(rot.revokeFamily(fam.familyId), true);
  assert.equal(rot.loadFamily(fam.familyId).revoked, true);
  assert.equal(rot.revokeFamily('rf_nope'), false);
});

test('loadFamily expires + unlinks a family past the TTL', () => {
  const fam = rot.createFamily('u');
  const file = path.join(STORE_DIR, `${fam.familyId}.json`);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  row.updatedAt = Date.now() - (40 * 24 * 60 * 60 * 1000); // 40d > 30d default TTL
  row.createdAt = row.updatedAt;
  fs.writeFileSync(file, JSON.stringify(row));
  assert.equal(rot.loadFamily(fam.familyId), null, 'expired family returns null');
  assert.equal(fs.existsSync(file), false, 'expired family file is unlinked');
});

test('validateRefresh detects token reuse (stale version) and revokes the family', () => {
  const issued = rot.issueRefreshPayload('user-x');
  assert.ok(issued && issued.familyId);
  assert.equal(issued.version, 1);
  // First use with the current version → ok + rotates to v2.
  const first = rot.validateRefresh(issued.familyId, 1);
  assert.equal(first.ok, true);
  assert.equal(first.family.version, 2);
  // Replaying the OLD version (1) → reuse detected + the family is revoked.
  const replay = rot.validateRefresh(issued.familyId, 1);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'reuse_detected');
  assert.equal(rot.loadFamily(issued.familyId).revoked, true);
});

test('validateRefresh is a legacy pass-through when rotation is disabled', () => {
  const prev = process.env.SIRAGPT_REFRESH_TOKEN_ROTATION;
  try {
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = '0';
    assert.deepEqual(rot.validateRefresh('whatever', 5), { ok: true, legacy: true });
  } finally {
    process.env.SIRAGPT_REFRESH_TOKEN_ROTATION = prev;
  }
});
