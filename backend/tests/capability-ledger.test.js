'use strict';

// The capability ledger writes AuditLog rows (no schema change) for gaps,
// sandbox installs and host_bash executions, never throws, writes nothing
// under NODE_ENV=test without an injected client, and lists/summarises
// events for the admin route.
// Pin the test env before the module is loaded: the ledger must never reach
// the real database from this process.
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ledger = require('../src/services/capability-ledger');

function fakePrisma(rows = [], stored = []) {
  return {
    auditLog: {
      create: async ({ data }) => { rows.push(data); return { id: `r${rows.length}`, ...data }; },
      findMany: async (query) => { stored.push(query); return stored.rows || []; },
    },
  };
}

test('gap, install and host rows carry compact, clipped metadata and tags', async () => {
  const rows = [];
  const prisma = fakePrisma(rows);
  await ledger.recordCapabilityGap({ prisma, userId: 'u1', chatId: 'c1', kind: 'python_package', name: 'cv2', package: 'opencv-python-headless', allowed: true, tool: 'execute_python' });
  await ledger.recordCapabilityInstall({ prisma, userId: 'u1', chatId: 'c1', requested: ['opencv-python-headless'], installed: [{ name: 'opencv-python-headless', version: '4.12.0.88' }, { name: 'numpy', version: '2.1' }], bytes: 123456, durationMs: 4200, driver: 'docker', code: 'ok' });
  await ledger.recordCapabilityInstall({ prisma, userId: 'u1', chatId: 'c1', requested: ['torch'], installed: [], code: 'not_allowed' });
  await ledger.recordHostCommand({ prisma, userId: 'u1', chatId: 'c1', command: `npm install lodash ${'x'.repeat(500)}`, workingDir: '/w', exitCode: 0, ok: true, install: true, packages: ['lodash'] });
  assert.deepEqual(rows.map((r) => r.action), ['agent.capability_gap', 'agent.capability_install', 'agent.capability_install', 'agent.host_bash']);
  assert.deepEqual(rows.map((r) => [r.actorId, r.resourceType, r.resourceId]), Array(4).fill(['u1', 'chat', 'c1']));
  assert.deepEqual(rows[0].metadata, { kind: 'python_package', name: 'cv2', package: 'opencv-python-headless', allowed: true, tool: 'execute_python', source: 'agent-runner', tags: ['capability', 'gap', 'python_package'] });
  assert.equal(rows[1].metadata.installed.length, 2);
  assert.deepEqual(rows[1].metadata.tags, ['capability', 'install', 'ok']);
  assert.deepEqual(rows[2].metadata.tags, ['capability', 'install', 'failed']);
  assert.equal(rows[2].metadata.ok, false);
  assert.ok(rows[3].metadata.command.length <= 302, 'command text is clipped');
  assert.deepEqual(rows[3].metadata.tags, ['host_bash', 'capability', 'install']);
  assert.equal(await ledger.recordCapabilityGap({ prisma, kind: 'binary', name: '' }), null, 'a nameless gap is ignored');
});

test('never throws, and under NODE_ENV=test writes nothing without an injected client', async () => {
  const broken = { auditLog: { create: async () => { throw new Error('db down'); } } };
  assert.equal(await ledger.recordHostCommand({ prisma: broken, command: 'ls' }), null);
  assert.equal(await ledger.recordCapabilityGap({ kind: 'binary', name: 'ffmpeg' }), null);
  assert.equal(await ledger.recordCapabilityInstall({ requested: ['numpy'] }), null);
  assert.deepEqual(await ledger.listCapabilityEvents(null), []);
  assert.deepEqual(await ledger.listCapabilityEvents({}), []);
});

test('listCapabilityEvents filters by action/user/since with a bounded take, and summarizeGaps ranks what to allowlist next', async () => {
  const queries = [];
  const stored = [];
  stored.rows = [
    { id: 'a', action: 'agent.capability_gap', actorId: 'u1', resourceId: 'c1', createdAt: new Date('2026-10-11T10:00:00Z'), metadata: { package: 'torch', kind: 'python_package', allowed: false } },
    { id: 'b', action: 'agent.capability_gap', actorId: 'u2', resourceId: 'c2', createdAt: new Date('2026-10-11T11:00:00Z'), metadata: { package: 'torch', kind: 'python_package', allowed: false } },
    { id: 'c', action: 'agent.capability_gap', actorId: 'u1', resourceId: 'c3', createdAt: new Date('2026-10-11T12:00:00Z'), metadata: { name: 'ocrmypdf', kind: 'binary' } },
    { id: 'd', action: 'agent.capability_install', actorId: 'u1', resourceId: 'c1', createdAt: new Date('2026-10-11T13:00:00Z'), metadata: { requested: ['numpy'], ok: true } },
  ];
  const prisma = fakePrisma([], queries);
  prisma.auditLog.findMany = async (query) => { queries.push(query); return stored.rows; };
  const events = await ledger.listCapabilityEvents(prisma, { limit: 9999, action: 'agent.capability_gap', userId: 'u1', since: new Date('2026-10-11T00:00:00Z') });
  assert.equal(queries[0].take, 500, 'take is bounded');
  assert.deepEqual(queries[0].where.action, { in: ['agent.capability_gap'] });
  assert.equal(queries[0].where.actorId, 'u1');
  assert.ok(queries[0].where.createdAt.gte instanceof Date);
  assert.deepEqual(queries[0].orderBy, { createdAt: 'desc' });
  assert.deepEqual(events[0], { id: 'a', action: 'agent.capability_gap', userId: 'u1', chatId: 'c1', createdAt: stored.rows[0].createdAt, metadata: stored.rows[0].metadata });
  await ledger.listCapabilityEvents(prisma, { action: 'not-an-action' });
  assert.deepEqual(queries[1].where.action.in.sort(), Object.values(ledger.ACTIONS).sort(), 'an unknown action falls back to all capability actions');
  assert.equal(queries[1].take, 100);
  const summary = ledger.summarizeGaps(events);
  assert.deepEqual(summary.map((s) => [s.name, s.count, s.kind]), [['torch', 2, 'python_package'], ['ocrmypdf', 1, 'binary']]);
  assert.equal(summary[0].lastAt.toISOString(), '2026-10-11T11:00:00.000Z');
});

test('the admin route lists the ledger with the live policy and host_bash records through it', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  assert.match(admin, /router\.get\('\/capabilities', async \(req, res\) => \{/);
  assert.match(admin, /ledger\.listCapabilityEvents\(prisma, \{ limit, action, userId, since \}\)/);
  assert.match(admin, /gaps: ledger\.summarizeGaps\(events\)/);
  assert.match(admin, /allowCount: policy\.allow\.size/);
  const hostBash = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'host-bash-tool.js'), 'utf8');
  assert.match(hostBash, /const \{ recordHostCommand \} = require\('\.\.\/capability-ledger'\);/);
  assert.equal((hostBash.match(/void recordHostCommand\(\{/g) || []).length, 2, 'refusals and executions are both recorded');
});
