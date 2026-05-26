/**
 * audit-log — fire-and-forget audit writer (cycle 14). Verifies the
 * resilience contract (never throws), the req-context inference rules
 * (ip / ua / requestId), and the schema mapping (actorType / resource
 * fallback / metadata merge).
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { writeAuditLog } = require('../src/utils/audit-log');

function makePrisma(captureRef) {
  return {
    auditLog: {
      create: async ({ data }) => {
        captureRef.data = data;
        return { id: 'row-1', ...data };
      },
    },
  };
}

describe('writeAuditLog — resilience', () => {
  test('returns null when prisma has no auditLog model (silent no-op)', async () => {
    const r = await writeAuditLog(null, { action: 'login' });
    assert.equal(r, null);
    const r2 = await writeAuditLog({}, { action: 'login' });
    assert.equal(r2, null);
  });

  test('returns null on invalid entries without throwing', async () => {
    const capture = {};
    const r = await writeAuditLog(makePrisma(capture), null);
    assert.equal(r, null);
    const r2 = await writeAuditLog(makePrisma(capture), { /* no action */ });
    assert.equal(r2, null);
    assert.equal(capture.data, undefined);
  });

  test('swallows prisma create() errors and returns null', async () => {
    const broken = { auditLog: { create: async () => { throw new Error('db down'); } } };
    const r = await writeAuditLog(broken, { action: 'login' });
    assert.equal(r, null);
  });
});

describe('writeAuditLog — mapping', () => {
  test('maps userId → actorId with actorType=user', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      userId: 'u-1',
      actorName: 'a@b.com',
    });
    assert.equal(capture.data.actorType, 'user');
    assert.equal(capture.data.actorId, 'u-1');
    assert.equal(capture.data.actorName, 'a@b.com');
    assert.equal(capture.data.action, 'login');
  });

  test('defaults actorType=system when no userId is supplied', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), { action: 'cron_run' });
    assert.equal(capture.data.actorType, 'system');
    assert.equal(capture.data.actorId, null);
    assert.equal(capture.data.resourceType, 'system');
  });

  test('honours resource/resourceId and falls back to actorType', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'payment_instant',
      userId: 'u-1',
      resource: 'payment',
      resourceId: 'p-9',
    });
    assert.equal(capture.data.resourceType, 'payment');
    assert.equal(capture.data.resourceId, 'p-9');
  });

  test('extracts ip / ua / requestId from req when not provided', async () => {
    const capture = {};
    const req = {
      ip: '10.0.0.1',
      headers: { 'user-agent': 'jest', 'x-request-id': 'req-42' },
      user: { id: 'u-1', email: 'a@b.com' },
    };
    await writeAuditLog(makePrisma(capture), { action: 'login', req });
    assert.equal(capture.data.actorId, 'u-1');
    assert.equal(capture.data.actorName, 'a@b.com');
    assert.equal(capture.data.metadata.ip, '10.0.0.1');
    assert.equal(capture.data.metadata.ua, 'jest');
    assert.equal(capture.data.metadata.requestId, 'req-42');
  });

  test('explicit ip/ua override req-derived values', async () => {
    const capture = {};
    const req = { ip: '1.1.1.1', headers: { 'user-agent': 'jest' } };
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      ip: '8.8.8.8',
      ua: 'explicit',
      req,
    });
    assert.equal(capture.data.metadata.ip, '8.8.8.8');
    assert.equal(capture.data.metadata.ua, 'explicit');
  });

  test('merges caller metadata with derived ip/ua/requestId', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      ip: '1.2.3.4',
      ua: 'Mozilla/5.0',
      metadata: { reason: 'password' },
    });
    assert.deepEqual(capture.data.metadata, {
      reason: 'password',
      ip: '1.2.3.4',
      ua: 'Mozilla/5.0',
    });
  });

  test('emits null metadata when nothing is collected', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), { action: 'cron_run' });
    assert.equal(capture.data.metadata, null);
  });

  test('falls back to x-forwarded-for and socket.remoteAddress for ip', async () => {
    const capture = {};
    const req = {
      headers: { 'x-forwarded-for': '5.5.5.5' },
      socket: { remoteAddress: '6.6.6.6' },
    };
    await writeAuditLog(makePrisma(capture), { action: 'login', req });
    assert.equal(capture.data.metadata.ip, '5.5.5.5');
  });

  test('normalises tags (trim/lowercase/dedupe/non-empty) into metadata.tags', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      tags: [' Security ', 'security', 'LOGIN', '', 42, null, 'login'],
    });
    assert.deepEqual(capture.data.metadata.tags, ['security', 'login']);
  });

  test('omits metadata.tags when tags array yields no valid entries', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'cron_run',
      tags: ['', '   ', 7, null],
    });
    assert.equal(capture.data.metadata, null);
  });

  test('ignores non-array tags payload without throwing', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      tags: 'security',
    });
    assert.equal(capture.data.metadata, null);
  });

  test('tags coexist with ip/ua/requestId and caller metadata', async () => {
    const capture = {};
    await writeAuditLog(makePrisma(capture), {
      action: 'login',
      ip: '1.2.3.4',
      metadata: { reason: 'password' },
      tags: ['security', 'login'],
    });
    assert.deepEqual(capture.data.metadata, {
      reason: 'password',
      ip: '1.2.3.4',
      tags: ['security', 'login'],
    });
  });

  test('persists before/after snapshots verbatim', async () => {
    const capture = {};
    const before = { name: 'old' };
    const after = { name: 'new' };
    await writeAuditLog(makePrisma(capture), {
      action: 'user_update',
      userId: 'u-1',
      before,
      after,
    });
    assert.equal(capture.data.before, before);
    assert.equal(capture.data.after, after);
    assert.equal(capture.data.diff, null);
  });
});
