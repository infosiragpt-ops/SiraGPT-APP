'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  SOFT_DELETE_MODELS,
  softDeleteWhere,
  softDelete,
  cascadeSoftDeleteForUser,
} = require('../src/utils/prisma-soft-delete');
const { writeAuditLog } = require('../src/utils/audit-log');
const hardDeleteJob = require('../src/jobs/hard-delete-deleted-users');

describe('softDeleteWhere', () => {
  it('returns { deletedAt: null } when no extra clause given', () => {
    assert.deepStrictEqual(softDeleteWhere(), { deletedAt: null });
    assert.deepStrictEqual(softDeleteWhere(null), { deletedAt: null });
  });

  it('merges extra filters on top of deletedAt null', () => {
    assert.deepStrictEqual(
      softDeleteWhere({ userId: 'u1' }),
      { userId: 'u1', deletedAt: null },
    );
  });

  it('respects caller-supplied deletedAt clause (e.g. show trash)', () => {
    const w = softDeleteWhere({ userId: 'u1', deletedAt: { not: null } });
    assert.deepStrictEqual(w.deletedAt, { not: null });
    assert.strictEqual(w.userId, 'u1');
  });

  it('rejects non-object extras', () => {
    assert.throws(() => softDeleteWhere('bad'), TypeError);
    assert.throws(() => softDeleteWhere(['bad']), TypeError);
  });

  it('exposes the soft-delete model whitelist', () => {
    assert.ok(SOFT_DELETE_MODELS.includes('user'));
    assert.ok(SOFT_DELETE_MODELS.includes('chat'));
    assert.ok(SOFT_DELETE_MODELS.includes('message'));
    assert.ok(SOFT_DELETE_MODELS.includes('file'));
    assert.ok(SOFT_DELETE_MODELS.includes('project'));
    assert.ok(SOFT_DELETE_MODELS.includes('customGpt'));
    assert.strictEqual(Object.isFrozen(SOFT_DELETE_MODELS), true);
  });
});

describe('softDelete', () => {
  it('calls updateMany with { deletedAt: <Date> } by default', async () => {
    let captured;
    const delegate = { updateMany: async (args) => { captured = args; return { count: 1 }; } };
    const before = Date.now();
    await softDelete(delegate, { id: 'x' });
    assert.deepStrictEqual(captured.where, { id: 'x' });
    assert.ok(captured.data.deletedAt instanceof Date);
    assert.ok(captured.data.deletedAt.getTime() >= before);
  });

  it('restores when opts.restore is true', async () => {
    let captured;
    const delegate = { updateMany: async (args) => { captured = args; return { count: 1 }; } };
    await softDelete(delegate, { id: 'x' }, { restore: true });
    assert.deepStrictEqual(captured.data, { deletedAt: null });
  });

  it('rejects invalid delegate', async () => {
    await assert.rejects(() => softDelete(null, {}), TypeError);
    await assert.rejects(() => softDelete({}, {}), TypeError);
  });
});

describe('cascadeSoftDeleteForUser', () => {
  it('marks chats, files, projects, customGpts, and messages as deleted', async () => {
    const calls = [];
    const fake = (table) => ({
      updateMany: async (args) => {
        calls.push({ table, where: args.where, data: args.data });
        return { count: 2 };
      },
    });
    const prisma = {
      chat: fake('chat'),
      file: fake('file'),
      project: fake('project'),
      customGpt: fake('customGpt'),
      message: fake('message'),
    };
    const result = await cascadeSoftDeleteForUser(prisma, 'u1');
    assert.strictEqual(result.chats, 2);
    assert.strictEqual(result.files, 2);
    assert.strictEqual(result.projects, 2);
    assert.strictEqual(result.customGpts, 2);
    assert.strictEqual(result.messages, 2);
    // Every cascaded write should target the user and only alive rows.
    assert.strictEqual(calls.length, 5);
    for (const c of calls) {
      assert.ok(c.data.deletedAt instanceof Date);
    }
    const customGptCall = calls.find((c) => c.table === 'customGpt');
    assert.strictEqual(customGptCall.where.creatorId, 'u1');
    const messageCall = calls.find((c) => c.table === 'message');
    assert.deepStrictEqual(messageCall.where.chat, { userId: 'u1' });
  });

  it('captures per-table failures without aborting the cascade', async () => {
    const prisma = {
      chat: { updateMany: async () => { throw new Error('boom'); } },
      file: { updateMany: async () => ({ count: 1 }) },
      project: { updateMany: async () => ({ count: 0 }) },
      customGpt: { updateMany: async () => ({ count: 0 }) },
      message: { updateMany: async () => ({ count: 0 }) },
    };
    const result = await cascadeSoftDeleteForUser(prisma, 'u1');
    assert.ok(result.chats && typeof result.chats === 'object' && result.chats.error);
    assert.strictEqual(result.files, 1);
  });

  it('rejects missing args', async () => {
    await assert.rejects(() => cascadeSoftDeleteForUser(null, 'u'), TypeError);
    await assert.rejects(() => cascadeSoftDeleteForUser({}, ''), TypeError);
  });
});

describe('writeAuditLog', () => {
  function makePrisma() {
    const rows = [];
    return {
      rows,
      auditLog: { create: async ({ data }) => { rows.push(data); return data; } },
    };
  }

  it('returns null when prisma lacks the auditLog model', async () => {
    const r = await writeAuditLog({}, { action: 'login' });
    assert.strictEqual(r, null);
  });

  it('returns null when entry lacks an action', async () => {
    const prisma = makePrisma();
    const r = await writeAuditLog(prisma, {});
    assert.strictEqual(r, null);
    assert.strictEqual(prisma.rows.length, 0);
  });

  it('maps userId → actorId and defaults actorType=user', async () => {
    const prisma = makePrisma();
    await writeAuditLog(prisma, {
      action: 'login',
      userId: 'u1',
      actorName: 'a@b.c',
      resource: 'user',
      resourceId: 'u1',
    });
    assert.strictEqual(prisma.rows.length, 1);
    const row = prisma.rows[0];
    assert.strictEqual(row.actorType, 'user');
    assert.strictEqual(row.actorId, 'u1');
    assert.strictEqual(row.actorName, 'a@b.c');
    assert.strictEqual(row.resourceType, 'user');
    assert.strictEqual(row.action, 'login');
  });

  it('defaults actorType to system when no userId is supplied', async () => {
    const prisma = makePrisma();
    await writeAuditLog(prisma, { action: 'cron_run', resource: 'system' });
    assert.strictEqual(prisma.rows[0].actorType, 'system');
    assert.strictEqual(prisma.rows[0].actorId, null);
  });

  it('pulls ip / ua / requestId from req when present', async () => {
    const prisma = makePrisma();
    const req = {
      ip: '10.0.0.1',
      headers: { 'user-agent': 'test/1.0', 'x-request-id': 'r-1' },
      user: { id: 'u2', email: 'x@y.z' },
    };
    await writeAuditLog(prisma, { req, action: 'login', resource: 'user' });
    const md = prisma.rows[0].metadata;
    assert.strictEqual(md.ip, '10.0.0.1');
    assert.strictEqual(md.ua, 'test/1.0');
    assert.strictEqual(md.requestId, 'r-1');
    assert.strictEqual(prisma.rows[0].actorId, 'u2');
    assert.strictEqual(prisma.rows[0].actorName, 'x@y.z');
  });

  it('never throws even if prisma.create rejects', async () => {
    const prisma = { auditLog: { create: async () => { throw new Error('db down'); } } };
    const r = await writeAuditLog(prisma, { action: 'login', resource: 'user' });
    assert.strictEqual(r, null);
  });

  it('falls back resourceType to actorType when resource is missing', async () => {
    const prisma = makePrisma();
    await writeAuditLog(prisma, { action: 'login', userId: 'u1' });
    assert.strictEqual(prisma.rows[0].resourceType, 'user');
  });
});

describe('hard-delete-deleted-users job', () => {
  it('exports run + DEFAULT_GRACE_DAYS', () => {
    assert.strictEqual(typeof hardDeleteJob.run, 'function');
    assert.strictEqual(typeof hardDeleteJob.DEFAULT_GRACE_DAYS, 'number');
  });

  it('returns deleted:0 when there are no candidates', async () => {
    const prisma = {
      user: { findMany: async () => [], delete: async () => { throw new Error('should not'); } },
    };
    const result = await hardDeleteJob.run({
      prisma,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.candidates, 0);
  });

  it('skips deletion in dry-run but still counts candidates', async () => {
    let deleteCalled = false;
    const prisma = {
      user: {
        findMany: async () => [
          { id: 'u1', email: 'a@b.c', deletedAt: new Date('2020-01-01') },
          { id: 'u2', email: 'b@b.c', deletedAt: new Date('2020-01-02') },
        ],
        delete: async () => { deleteCalled = true; },
      },
    };
    const result = await hardDeleteJob.run({
      prisma,
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.strictEqual(deleteCalled, false);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.candidates, 2);
    assert.strictEqual(result.dryRun, true);
  });

  it('purges candidates and counts successful deletions', async () => {
    const purged = [];
    const prisma = {
      user: {
        findMany: async () => [
          { id: 'u1', email: 'a@b.c', deletedAt: new Date('2020-01-01') },
          { id: 'u2', email: 'b@b.c', deletedAt: new Date('2020-01-02') },
        ],
        delete: async ({ where }) => { purged.push(where.id); },
      },
      auditLog: { create: async () => {} },
    };
    const result = await hardDeleteJob.run({
      prisma,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.deepStrictEqual(purged.sort(), ['u1', 'u2']);
    assert.strictEqual(result.deleted, 2);
    assert.strictEqual(result.candidates, 2);
  });

  it('keeps going when an individual delete fails', async () => {
    let calls = 0;
    const prisma = {
      user: {
        findMany: async () => [
          { id: 'u1', email: 'a@b.c', deletedAt: new Date('2020-01-01') },
          { id: 'u2', email: 'b@b.c', deletedAt: new Date('2020-01-02') },
        ],
        delete: async () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
        },
      },
      auditLog: { create: async () => {} },
    };
    const result = await hardDeleteJob.run({
      prisma,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.strictEqual(result.candidates, 2);
    assert.strictEqual(result.deleted, 1);
  });
});
