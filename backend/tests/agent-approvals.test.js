'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createApprovalService,
  createMemoryStore,
  DEFAULT_APPROVAL_TTL_MS,
} = require('../src/services/agent-approvals');

/** Deterministic service with a controllable clock. */
function makeService(opts = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms) => { t += ms; }, now: () => t };
  const service = createApprovalService({ now: clock.now, ...opts });
  return { service, clock };
}

function makeRequest(service, overrides = {}) {
  return service.request({
    userId: 'u1',
    chatId: 'chat-1',
    tool: 'web_fetch',
    argsSummary: 'GET https://example.com',
    humanDescription: 'Fetch a URL',
    ...overrides,
  });
}

test('full cycle: pending → allow', () => {
  const { service } = makeService();
  const req = makeRequest(service);
  assert.equal(req.ok, true);
  assert.equal(req.status, 'pending');
  assert.ok(req.id.startsWith('appr_'));
  assert.equal(req.expiresAt, 1_000_000 + DEFAULT_APPROVAL_TTL_MS);

  const before = service.get(req.id);
  assert.equal(before.ok, true);
  assert.equal(before.approval.status, 'pending');
  assert.equal(before.approval.tool, 'web_fetch');

  const resolved = service.resolve({ id: req.id, userId: 'u1', decision: 'allow' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'allowed');
  assert.equal(resolved.decision, 'allow');
  assert.equal(resolved.alreadyResolved, false);

  const after = service.get(req.id);
  assert.equal(after.approval.status, 'allowed');
  assert.equal(service.listPending({ userId: 'u1' }).approvals.length, 0);
});

test('deny resolves to denied', () => {
  const { service } = makeService();
  const req = makeRequest(service);
  const resolved = service.resolve({ id: req.id, userId: 'u1', decision: 'deny' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'denied');
  assert.equal(resolved.decision, 'deny');
  assert.equal(service.get(req.id).approval.status, 'denied');
});

test('resolve is idempotent: the second resolution returns the first', () => {
  const { service } = makeService();
  const req = makeRequest(service);
  const first = service.resolve({ id: req.id, userId: 'u1', decision: 'allow' });
  // Retry with the OPPOSITE decision: the original outcome must win.
  const second = service.resolve({ id: req.id, userId: 'u1', decision: 'deny' });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'allowed');
  assert.equal(second.decision, 'allow');
  assert.equal(second.alreadyResolved, true);
  assert.equal(second.resolvedAt, first.resolvedAt);
  assert.equal(service.get(req.id).approval.status, 'allowed');
});

test('a different user gets forbidden (even after resolution)', () => {
  const { service } = makeService();
  const req = makeRequest(service);
  assert.deepEqual(
    service.resolve({ id: req.id, userId: 'intruder', decision: 'allow' }),
    { ok: false, error: 'forbidden' },
  );
  // Still pending for the owner.
  assert.equal(service.get(req.id).approval.status, 'pending');
  service.resolve({ id: req.id, userId: 'u1', decision: 'allow' });
  // Resolved outcome is not disclosed to another user either.
  assert.deepEqual(
    service.resolve({ id: req.id, userId: 'intruder', decision: 'deny' }),
    { ok: false, error: 'forbidden' },
  );
});

test('TTL expiry with a fake clock: sweepExpired marks and counts', () => {
  const { service, clock } = makeService();
  const shortLived = makeRequest(service, { ttlMs: 5_000 });
  const longLived = makeRequest(service, { ttlMs: 60_000 });

  clock.advance(4_999);
  assert.deepEqual(service.sweepExpired(), { ok: true, expired: 0 });

  clock.advance(1); // exactly at expiresAt → expired
  assert.deepEqual(service.sweepExpired(), { ok: true, expired: 1 });
  assert.equal(service.get(shortLived.id).approval.status, 'expired');
  assert.equal(service.get(longLived.id).approval.status, 'pending');

  // Expired approvals can no longer be resolved, and sweeping again is a no-op.
  assert.deepEqual(
    service.resolve({ id: shortLived.id, userId: 'u1', decision: 'allow' }),
    { ok: false, error: 'expired' },
  );
  assert.deepEqual(service.sweepExpired(), { ok: true, expired: 0 });
});

test('resolve on a stale pending record expires it even before a sweep', () => {
  const { service, clock } = makeService();
  const req = makeRequest(service, { ttlMs: 5_000 });
  clock.advance(10_000);
  assert.deepEqual(
    service.resolve({ id: req.id, userId: 'u1', decision: 'allow' }),
    { ok: false, error: 'expired' },
  );
  assert.equal(service.get(req.id).approval.status, 'expired');
});

test('listPending: only the caller\'s pending items, oldest first', () => {
  const { service, clock } = makeService();
  const a = makeRequest(service, { tool: 'tool_a' });
  clock.advance(1_000);
  const b = makeRequest(service, { tool: 'tool_b' });
  clock.advance(1_000);
  makeRequest(service, { userId: 'u2', tool: 'tool_other_user' });
  const c = makeRequest(service, { tool: 'tool_c', ttlMs: 1_500 });

  const initial = service.listPending({ userId: 'u1' });
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.approvals.map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(initial.approvals.map((x) => x.tool), ['tool_a', 'tool_b', 'tool_c']);

  // Resolved and expired entries drop out of the inbox.
  service.resolve({ id: b.id, userId: 'u1', decision: 'deny' });
  clock.advance(2_000); // c passes its short TTL
  const later = service.listPending({ userId: 'u1' });
  assert.deepEqual(later.approvals.map((x) => x.id), [a.id]);
});

test('onResolved fires exactly once per approval', () => {
  const { service } = makeService();
  const req = makeRequest(service);
  const events = [];
  service.onResolved((event) => events.push(event));

  service.resolve({ id: req.id, userId: 'u1', decision: 'allow' });
  service.resolve({ id: req.id, userId: 'u1', decision: 'allow' }); // idempotent retry
  service.resolve({ id: req.id, userId: 'u1', decision: 'deny' }); // opposite retry

  assert.equal(events.length, 1);
  assert.equal(events[0].id, req.id);
  assert.equal(events[0].decision, 'allow');
  assert.equal(events[0].status, 'allowed');
  assert.equal(events[0].chatId, 'chat-1');
  assert.equal(events[0].tool, 'web_fetch');
});

test('onResolved: unsubscribe works and listener crashes never break resolve', () => {
  const { service } = makeService();
  const first = makeRequest(service);
  const second = makeRequest(service);
  let calls = 0;
  const unsubscribe = service.onResolved(() => { calls += 1; });
  service.onResolved(() => { throw new Error('listener boom'); });

  const r1 = service.resolve({ id: first.id, userId: 'u1', decision: 'allow' });
  assert.equal(r1.ok, true);
  assert.equal(calls, 1);

  unsubscribe();
  const r2 = service.resolve({ id: second.id, userId: 'u1', decision: 'deny' });
  assert.equal(r2.ok, true);
  assert.equal(calls, 1); // no longer subscribed
});

test('weird input never throws: typed errors instead', () => {
  const { service } = makeService();
  assert.equal(service.request().ok, false);
  assert.equal(service.request({ userId: 'u1' }).ok, false);
  assert.deepEqual(
    service.request({ userId: '', chatId: 'c', tool: 't' }),
    { ok: false, error: 'invalid_user' },
  );
  assert.deepEqual(service.resolve(), { ok: false, error: 'not_found' });
  assert.deepEqual(
    service.resolve({ id: 'appr_missing', userId: 'u1', decision: 'allow' }),
    { ok: false, error: 'not_found' },
  );
  const req = makeRequest(service);
  assert.deepEqual(
    service.resolve({ id: req.id, userId: 'u1', decision: 'maybe' }),
    { ok: false, error: 'invalid_decision' },
  );
  assert.deepEqual(service.get(), { ok: false, error: 'not_found' });
  assert.deepEqual(service.listPending(), { ok: false, error: 'invalid_user' });
  assert.equal(typeof service.onResolved(null), 'function'); // no-op unsubscribe
});

test('a broken injected store yields store_error, never a throw', () => {
  const boom = () => { throw new Error('db down'); };
  const broken = { insert: boom, get: boom, update: boom, list: boom };
  const service = createApprovalService({ store: broken });
  assert.deepEqual(makeRequest(service), { ok: false, error: 'store_error' });
  assert.deepEqual(
    service.resolve({ id: 'appr_x', userId: 'u1', decision: 'allow' }),
    { ok: false, error: 'store_error' },
  );
  assert.deepEqual(service.get('appr_x'), { ok: false, error: 'store_error' });
  assert.deepEqual(service.listPending({ userId: 'u1' }), { ok: false, error: 'store_error' });
  assert.deepEqual(service.sweepExpired(), { ok: false, error: 'store_error' });
});

test('createMemoryStore returns copies, not live references', () => {
  const store = createMemoryStore();
  store.insert({ id: 'a1', status: 'pending' });
  const copy = store.get('a1');
  copy.status = 'tampered';
  assert.equal(store.get('a1').status, 'pending');
  assert.equal(store.update('missing', {}), null);
  assert.equal(store.list().length, 1);
});
