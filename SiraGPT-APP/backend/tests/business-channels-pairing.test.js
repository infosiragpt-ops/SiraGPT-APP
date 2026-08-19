'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPairingService,
  derivePairingCode,
  generatePairingCode,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_ALPHABET,
  PENDING_TTL_MS,
  PENDING_MAX_PER_ACCOUNT,
} = require('../src/services/business-channels/pairing');

test('deterministic pairing codes are stable, scoped and use the safe alphabet', () => {
  const first = derivePairingCode({ secret: 'test-secret', scope: 'channel-a\\0sender-a\\01' });
  const repeated = derivePairingCode({ secret: 'test-secret', scope: 'channel-a\\0sender-a\\01' });
  const other = derivePairingCode({ secret: 'test-secret', scope: 'channel-a\\0sender-b\\01' });
  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.equal(first.length, PAIRING_CODE_LENGTH);
  for (const char of first) assert.ok(PAIRING_CODE_ALPHABET.includes(char));
});

test('pairing codes: length, alphabet, uniqueness against existing set', () => {
  const code = generatePairingCode();
  assert.equal(code.length, PAIRING_CODE_LENGTH);
  for (const ch of code) assert.ok(PAIRING_CODE_ALPHABET.includes(ch), `char ${ch} outside alphabet`);
  // Ambiguous glyphs are excluded by construction.
  for (const banned of ['I', 'O', '0', '1']) assert.ok(!PAIRING_CODE_ALPHABET.includes(banned));
  const seen = new Set([code]);
  for (let i = 0; i < 50; i += 1) seen.add(generatePairingCode(seen));
  assert.equal(seen.size, 51);
});

test('unknown sender under pairing policy gets ONE stable code until approved', async () => {
  const svc = createPairingService();
  const first = await svc.gateInbound({ channel: 'telegram', senderId: 'user-9' });
  assert.equal(first.status, 'pairing_required');
  assert.equal(first.created, true);

  // Repeat contact must NOT mint a new code (anti code-spam).
  const again = await svc.gateInbound({ channel: 'telegram', senderId: 'user-9' });
  assert.equal(again.code, first.code);
  assert.equal(again.created, false);

  const approved = await svc.approve({ channel: 'telegram', code: first.code.toLowerCase() });
  assert.deepEqual(approved, { ok: true, senderId: 'user-9' });
  assert.deepEqual(await svc.gateInbound({ channel: 'telegram', senderId: 'user-9' }), { status: 'allowed' });
  // Approved codes are single-use.
  assert.equal((await svc.approve({ channel: 'telegram', code: first.code })).ok, false);
});

test('allowlist policy drops unknowns without issuing codes', async () => {
  const svc = createPairingService();
  const res = await svc.gateInbound({ channel: 'slack', senderId: 'x', dmPolicy: 'allowlist' });
  assert.deepEqual(res, { status: 'dropped', reason: 'not_allowlisted' });
  assert.deepEqual(await svc.listPending({ channel: 'slack' }), []);
});

test("'open' only opens with the explicit '*' wildcard", async () => {
  const svc = createPairingService();
  const closed = await svc.gateInbound({ channel: 'discord', senderId: 'a', dmPolicy: 'open', allowFrom: [] });
  assert.equal(closed.status, 'dropped');
  const open = await svc.gateInbound({ channel: 'discord', senderId: 'a', dmPolicy: 'open', allowFrom: ['*'] });
  assert.equal(open.status, 'allowed');
});

test('pending requests expire after TTL and are capped per account', async () => {
  let t = 1_000_000;
  const svc = createPairingService({ now: () => t });
  const first = await svc.gateInbound({ channel: 'whatsapp', senderId: 's1' });
  t += PENDING_TTL_MS + 1;
  // Expired → re-contact mints a fresh code.
  const later = await svc.gateInbound({ channel: 'whatsapp', senderId: 's1' });
  assert.equal(later.created, true);
  assert.notEqual(later.code, first.code);

  for (let i = 0; i < PENDING_MAX_PER_ACCOUNT + 2; i += 1) {
    t += 1;
    await svc.gateInbound({ channel: 'whatsapp', senderId: `bulk-${i}` });
  }
  const pending = await svc.listPending({ channel: 'whatsapp' });
  assert.ok(pending.length <= PENDING_MAX_PER_ACCOUNT, `pending=${pending.length} exceeds cap`);
});

test('revoke removes an approved sender; accounts are isolated', async () => {
  const svc = createPairingService();
  const a = await svc.gateInbound({ channel: 'telegram', accountId: 'acme', senderId: 'v' });
  await svc.approve({ channel: 'telegram', accountId: 'acme', code: a.code });
  // Same sender on ANOTHER account is still unknown.
  const other = await svc.gateInbound({ channel: 'telegram', accountId: 'globex', senderId: 'v' });
  assert.equal(other.status, 'pairing_required');
  await svc.revoke({ channel: 'telegram', accountId: 'acme', senderId: 'v' });
  const back = await svc.gateInbound({ channel: 'telegram', accountId: 'acme', senderId: 'v' });
  assert.equal(back.status, 'pairing_required');
});
