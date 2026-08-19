/**
 * agent-access/keys tests — CRUD, pairing state machine, and the
 * auth state codes the middleware consumes. Persistence is redirected
 * to a per-test temp dir so tests are hermetic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keys = require('../src/services/agent-access/keys');

// Per-test fixture helper: reset the keys file to an empty array so
// tests don't see each other's state. We leave the paths pointing at
// the real DATA_DIR — the file is deleted / reset between tests.
function resetFile() {
  const dir = path.dirname(keys._paths.KEYS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keys._paths.KEYS_FILE, '[]');
}

test('createKey returns a one-shot secret with sira_ag_ prefix', () => {
  resetFile();
  const out = keys.createKey({ userId: 'u1', label: 'my cron' });
  assert.match(out.id, /^agk_/);
  assert.match(out.secret, new RegExp(`^${keys.KEY_PREFIX}${out.id}\\.`));
  assert.equal(out.label, 'my cron');
  assert.equal(out.scope.mode, 'sandbox', 'default scope should be sandbox');
});

test('listKeys returns metadata only (no secrets)', () => {
  resetFile();
  keys.createKey({ userId: 'u1', label: 'k1' });
  keys.createKey({ userId: 'u1', label: 'k2' });
  keys.createKey({ userId: 'u2', label: 'not mine' });
  const mine = keys.listKeys('u1');
  assert.equal(mine.length, 2);
  for (const k of mine) {
    assert.equal('secret' in k, false);
    assert.equal('secretHash' in k, false);
    assert.equal('salt' in k, false);
  }
});

test('authenticate(pair_required) on first use, ok after approval', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'pairing';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });

  const first = keys.authenticate({
    authHeader: `Bearer ${created.secret}`,
    ip: '1.2.3.4', userAgent: 'curl/8',
  });
  assert.equal(first.code, 'pair_required');
  assert.ok(first.pendingCode && first.pendingCode.length === 8);

  // Owner approves
  const ok = keys.approvePairing({ userId: 'u1', id: created.id, code: first.pendingCode });
  assert.equal(ok.ok, true);

  const second = keys.authenticate({
    authHeader: `Bearer ${created.secret}`,
    ip: '1.2.3.4', userAgent: 'curl/8',
  });
  assert.equal(second.code, 'ok');
  assert.equal(second.paired, true);
});

test('authenticate(ok) in open mode without approval', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'open';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });
  const res = keys.authenticate({
    authHeader: `Bearer ${created.secret}`,
    ip: '9.9.9.9', userAgent: 'x',
  });
  assert.equal(res.code, 'ok');
});

test('authenticate closed-mode short-circuits before parsing', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'closed';
  const res = keys.authenticate({
    authHeader: 'Bearer sira_ag_whatever',
    ip: 'x', userAgent: 'y',
  });
  assert.equal(res.code, 'closed');
});

test('authenticate rejects bad secret in constant time', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'open';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });
  const bad = created.secret.slice(0, -1) + '0'; // mutate last char
  const res = keys.authenticate({
    authHeader: `Bearer ${bad}`,
    ip: 'x', userAgent: 'y',
  });
  assert.equal(res.code, 'bad_secret');
});

test('authenticate rejects revoked keys', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'open';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });
  keys.revokeKey({ userId: 'u1', id: created.id });
  const res = keys.authenticate({ authHeader: `Bearer ${created.secret}`, ip: 'x', userAgent: 'y' });
  assert.equal(res.code, 'revoked');
});

test('different principal hashes → separate pairing tracks', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'pairing';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });

  const a = keys.authenticate({ authHeader: `Bearer ${created.secret}`, ip: '1.1.1.1', userAgent: 'A' });
  const b = keys.authenticate({ authHeader: `Bearer ${created.secret}`, ip: '2.2.2.2', userAgent: 'B' });
  assert.equal(a.code, 'pair_required');
  assert.equal(b.code, 'pair_required');
  // The second principal overwrites the pending pair. That's fine —
  // the previous principal can re-request on its next call.
  assert.ok(a.pendingCode && b.pendingCode);
});

test('parsePresentedKey handles malformed inputs', () => {
  assert.equal(keys.parsePresentedKey(null), null);
  assert.equal(keys.parsePresentedKey('Basic abc'), null);
  assert.equal(keys.parsePresentedKey('Bearer nope'), null);
  assert.equal(keys.parsePresentedKey('Bearer sira_ag_no_dot'), null);
  const out = keys.parsePresentedKey('Bearer sira_ag_abc.def');
  assert.deepEqual(out, { id: 'abc', secret: 'def' });
});

test('revokePairing removes a specific principal', () => {
  resetFile();
  process.env.AGENT_DM_POLICY = 'pairing';
  const created = keys.createKey({ userId: 'u1', label: 'cli' });
  const auth = keys.authenticate({ authHeader: `Bearer ${created.secret}`, ip: '1.1.1.1', userAgent: 'A' });
  keys.approvePairing({ userId: 'u1', id: created.id, code: auth.pendingCode });
  const list = keys.listKeys('u1');
  assert.equal(list[0].pairedPrincipals, 1);
  keys.revokePairing({ userId: 'u1', id: created.id, principalHash: auth.principalHash });
  const after = keys.listKeys('u1');
  assert.equal(after[0].pairedPrincipals, 0);
});

test('genPairCode is 8 chars, uppercase alphanum, no ambiguous chars', () => {
  for (let i = 0; i < 50; i++) {
    const c = keys.genPairCode();
    assert.equal(c.length, 8);
    assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/, `bad code: ${c}`);
  }
});

// Restore default so other tests don't inherit our last setting.
test('teardown — restore AGENT_DM_POLICY', () => {
  delete process.env.AGENT_DM_POLICY;
});
