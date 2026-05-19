'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run, SCRUB_MARKER } = require('../src/jobs/scrub-deleted-user-content');

function buildPrismaStub() {
  const state = {
    users: [
      { id: 'u-old', email: 'alice@example.com', deletedAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'u-recent', email: 'recent@example.com', deletedAt: new Date() }, // inside grace
    ],
    chats: {
      'u-old': [{ id: 'c-1' }, { id: 'c-2' }],
      'u-recent': [{ id: 'c-3' }],
    },
    messages: {
      'c-1': [
        { id: 'm-1', content: 'call me at +14155552671', metadata: {} },
        { id: 'm-2', content: 'no pii', metadata: { piiScrubbed: true } }, // skipped
      ],
      'c-2': [
        { id: 'm-3', content: 'email me at bob@example.com', metadata: null },
      ],
      'c-3': [
        { id: 'm-4', content: 'inside grace, should not be touched', metadata: {} },
      ],
    },
    files: {
      'u-old': [
        { id: 'f-1', filename: 'a@b.com.pdf', originalName: 'a@b.com.pdf', extractedText: 'ssn 123-45-6789', processingError: null },
      ],
      'u-recent': [
        { id: 'f-2', filename: 'safe.pdf', originalName: 'safe.pdf', extractedText: 'nothing', processingError: null },
      ],
    },
    updatedMessages: [],
    updatedFiles: [],
  };

  return {
    user: {
      async findMany({ where }) {
        // emulate `deletedAt: { lt: cutoff, not: null }`
        const cutoff = where.deletedAt.lt;
        return state.users.filter((u) => u.deletedAt && u.deletedAt < cutoff);
      },
    },
    chat: {
      async findMany({ where }) {
        return state.chats[where.userId] || [];
      },
    },
    message: {
      async findMany({ where }) {
        const ids = where.chatId.in;
        const out = [];
        for (const id of ids) out.push(...(state.messages[id] || []));
        return out;
      },
      async update({ where, data }) {
        state.updatedMessages.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    file: {
      async findMany({ where }) {
        return state.files[where.userId] || [];
      },
      async update({ where, data }) {
        state.updatedFiles.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    _state: state,
  };
}

describe('scrub-deleted-user-content', () => {
  test('scrubs PII from soft-deleted users past the window', async () => {
    const prisma = buildPrismaStub();
    const result = await run({
      prisma,
      scrubAfterDays: 27,
      now: new Date('2026-05-19T00:00:00Z'),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.users, 1);
    // m-1 (phone) + m-3 (email); m-2 already scrubbed, m-4 inside grace.
    assert.equal(result.messages, 2);
    assert.equal(result.files, 1);

    const m1 = prisma._state.updatedMessages.find((u) => u.id === 'm-1');
    assert.ok(m1, 'm-1 should have been updated');
    assert.match(m1.data.content, /<PHONE>/);
    assert.equal(m1.data.metadata.piiScrubbed, true);

    const m3 = prisma._state.updatedMessages.find((u) => u.id === 'm-3');
    assert.ok(m3);
    assert.match(m3.data.content, /<EMAIL>/);

    // m-4 should not be in the updates
    assert.ok(!prisma._state.updatedMessages.find((u) => u.id === 'm-4'));

    const f1 = prisma._state.updatedFiles.find((u) => u.id === 'f-1');
    assert.ok(f1);
    assert.match(f1.data.originalName, /<EMAIL>/);
    assert.match(f1.data.extractedText, /<SSN>/);
    assert.equal(f1.data.processingError, SCRUB_MARKER);
  });

  test('dry-run does not call update', async () => {
    const prisma = buildPrismaStub();
    const result = await run({
      prisma,
      scrubAfterDays: 27,
      now: new Date('2026-05-19T00:00:00Z'),
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.dryRun, true);
    assert.equal(prisma._state.updatedMessages.length, 0);
    assert.equal(prisma._state.updatedFiles.length, 0);
    assert.ok(result.messages >= 1);
  });

  test('skips messages already marked as scrubbed', async () => {
    const prisma = buildPrismaStub();
    await run({
      prisma,
      scrubAfterDays: 27,
      now: new Date('2026-05-19T00:00:00Z'),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.ok(!prisma._state.updatedMessages.find((u) => u.id === 'm-2'));
  });

  test('returns zero when there are no candidates', async () => {
    const prisma = buildPrismaStub();
    const result = await run({
      prisma,
      scrubAfterDays: 365 * 10, // very far future cutoff
      now: new Date('2026-05-19T00:00:00Z'),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.deepEqual(
      { u: result.users, m: result.messages, f: result.files },
      { u: 0, m: 0, f: 0 },
    );
  });
});
