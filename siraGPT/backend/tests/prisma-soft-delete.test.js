/**
 * prisma-soft-delete — opt-in soft-delete helpers (cycle 14). Verifies
 * the where-composer, the updateMany-based delete/restore wrapper, and
 * the per-user cascade resilience contract.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SOFT_DELETE_MODELS,
  softDeleteWhere,
  softDelete,
  cascadeSoftDeleteForUser,
} = require('../src/utils/prisma-soft-delete');

describe('softDeleteWhere', () => {
  test('returns {deletedAt: null} for empty/undefined input', () => {
    assert.deepEqual(softDeleteWhere(), { deletedAt: null });
    assert.deepEqual(softDeleteWhere(null), { deletedAt: null });
  });

  test('merges extra filters with deletedAt: null', () => {
    const out = softDeleteWhere({ userId: 'u1', orgId: 'o1' });
    assert.deepEqual(out, { userId: 'u1', orgId: 'o1', deletedAt: null });
  });

  test('respects caller-provided deletedAt (e.g. show-only-trash)', () => {
    const out = softDeleteWhere({ userId: 'u1', deletedAt: { not: null } });
    assert.deepEqual(out, { userId: 'u1', deletedAt: { not: null } });
  });

  test('throws on non-object extras', () => {
    assert.throws(() => softDeleteWhere('nope'), /plain object/);
    assert.throws(() => softDeleteWhere([1, 2, 3]), /plain object/);
  });
});

describe('softDelete', () => {
  test('marks rows with current timestamp by default', async () => {
    let captured = null;
    const delegate = {
      updateMany: async (args) => {
        captured = args;
        return { count: 1 };
      },
    };
    const before = Date.now();
    const r = await softDelete(delegate, { id: 'x' });
    assert.equal(r.count, 1);
    assert.deepEqual(captured.where, { id: 'x' });
    assert.ok(captured.data.deletedAt instanceof Date);
    assert.ok(captured.data.deletedAt.getTime() >= before);
  });

  test('restore: true clears deletedAt', async () => {
    let captured = null;
    const delegate = { updateMany: async (a) => { captured = a; return { count: 1 }; } };
    await softDelete(delegate, { id: 'x' }, { restore: true });
    assert.deepEqual(captured.data, { deletedAt: null });
  });

  test('honours an explicit deletedAt option', async () => {
    let captured = null;
    const delegate = { updateMany: async (a) => { captured = a; return { count: 1 }; } };
    const fixed = new Date('2024-01-01T00:00:00Z');
    await softDelete(delegate, { id: 'y' }, { deletedAt: fixed });
    assert.equal(captured.data.deletedAt, fixed);
  });

  test('rejects non-delegate inputs', async () => {
    await assert.rejects(() => softDelete(null, { id: 'x' }), /invalid Prisma delegate/);
    await assert.rejects(() => softDelete({}, { id: 'x' }), /invalid Prisma delegate/);
  });
});

describe('cascadeSoftDeleteForUser', () => {
  function makePrisma() {
    const counts = { chats: 3, files: 2, projects: 1, customGpts: 1, messages: 7 };
    return {
      chat: { updateMany: async () => ({ count: counts.chats }) },
      file: { updateMany: async () => ({ count: counts.files }) },
      project: { updateMany: async () => ({ count: counts.projects }) },
      customGpt: { updateMany: async () => ({ count: counts.customGpts }) },
      message: { updateMany: async () => ({ count: counts.messages }) },
    };
  }

  test('returns per-resource counts on the happy path', async () => {
    const res = await cascadeSoftDeleteForUser(makePrisma(), 'u-1');
    assert.deepEqual(res, { chats: 3, files: 2, projects: 1, customGpts: 1, messages: 7 });
  });

  test('isolates failures per resource so one bad table does not strand the rest', async () => {
    const prisma = makePrisma();
    prisma.file.updateMany = async () => { throw new Error('boom'); };
    const res = await cascadeSoftDeleteForUser(prisma, 'u-1');
    assert.equal(res.chats, 3);
    assert.deepEqual(res.files, { error: 'boom' });
    assert.equal(res.messages, 7);
  });

  test('throws TypeError when called without userId or prisma', async () => {
    await assert.rejects(() => cascadeSoftDeleteForUser(null, 'u'), /prisma \+ userId/);
    await assert.rejects(() => cascadeSoftDeleteForUser({}, ''), /prisma \+ userId/);
  });
});

describe('SOFT_DELETE_MODELS', () => {
  test('exposes the cycle-14 supported model list and is frozen', () => {
    assert.ok(SOFT_DELETE_MODELS.includes('user'));
    assert.ok(SOFT_DELETE_MODELS.includes('chat'));
    assert.ok(SOFT_DELETE_MODELS.includes('message'));
    assert.ok(SOFT_DELETE_MODELS.includes('file'));
    assert.ok(SOFT_DELETE_MODELS.includes('project'));
    assert.ok(SOFT_DELETE_MODELS.includes('customGpt'));
    assert.ok(Object.isFrozen(SOFT_DELETE_MODELS));
  });
});
