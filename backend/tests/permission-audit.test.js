'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const pm = require('../src/services/agent-harness/permission-manager');

beforeEach(() => {
  pm.resetForTests();
  pm.setPermissionAuditor(null); // default OFF — keeps unit tests DB-free
});

function openPending(opts = {}) {
  let permissionId;
  const promise = pm.requestPermission({
    chatId: 'c1',
    userId: 'u1',
    toolName: 'web_fetch',
    humanDescription: 'Fetch a URL',
    onRequest: (card) => { permissionId = card.permissionId; },
    ...opts,
  });
  return { promise, getId: () => permissionId };
}

test('auditor is invoked on a user allow, with decision + tool + user', async () => {
  const seen = [];
  pm.setPermissionAuditor((entry, outcome) => seen.push({ entry, outcome }));
  const { promise, getId } = openPending();
  const r = pm.resolvePermission({ permissionId: getId(), decision: 'allow', userId: 'u1' });
  assert.equal(r.ok, true);
  await promise;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome.decision, 'allow');
  assert.equal(seen[0].entry.toolName, 'web_fetch');
  assert.equal(seen[0].entry.userId, 'u1');
  assert.equal(seen[0].entry.chatId, 'c1');
});

test('auditor sees a deny', async () => {
  const seen = [];
  pm.setPermissionAuditor((_e, o) => seen.push(o));
  const { promise, getId } = openPending();
  pm.resolvePermission({ permissionId: getId(), decision: 'deny', userId: 'u1' });
  await promise;
  assert.equal(seen[0].decision, 'deny');
});

test('auditor sees always_allow_in_chat as allow with chat scope', async () => {
  const seen = [];
  pm.setPermissionAuditor((_e, o) => seen.push(o));
  const { promise, getId } = openPending();
  pm.resolvePermission({ permissionId: getId(), decision: 'always_allow_in_chat', userId: 'u1' });
  await promise;
  assert.equal(seen[0].decision, 'allow');
  assert.equal(seen[0].scope, 'chat');
});

test('timeout decision is audited (system deny / reason timeout)', async () => {
  const seen = [];
  pm.setPermissionAuditor((_e, o) => seen.push(o));
  const { promise } = openPending({ ttlMs: 20 });
  const out = await promise; // resolves via the TTL timer
  assert.equal(out.decision, 'deny');
  assert.equal(out.reason, 'timeout');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'timeout');
});

test('no auditor by default → resolution still works (flow unaffected)', async () => {
  const { promise, getId } = openPending();
  pm.resolvePermission({ permissionId: getId(), decision: 'allow', userId: 'u1' });
  const out = await promise;
  assert.equal(out.decision, 'allow');
});

test('a throwing auditor never breaks resolution (fail-open)', async () => {
  pm.setPermissionAuditor(() => { throw new Error('boom'); });
  const { promise, getId } = openPending();
  pm.resolvePermission({ permissionId: getId(), decision: 'allow', userId: 'u1' });
  const out = await promise;
  assert.equal(out.decision, 'allow');
});

test('setPermissionAuditor(null) disables auditing', async () => {
  const seen = [];
  pm.setPermissionAuditor((_e, o) => seen.push(o));
  pm.setPermissionAuditor(null);
  const { promise, getId } = openPending();
  pm.resolvePermission({ permissionId: getId(), decision: 'allow', userId: 'u1' });
  await promise;
  assert.equal(seen.length, 0);
});
