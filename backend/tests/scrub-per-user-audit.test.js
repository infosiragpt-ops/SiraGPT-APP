'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mockResolvedModule } = require('./http-test-utils');
const { run } = require('../src/jobs/scrub-deleted-user-content');

/**
 * The per-user GDPR `user_pii_scrub` audit row recorded the RUNNING SUM of
 * messages/files scrubbed across all users (the counters lived outside the
 * per-user loop), so every user after the first over-reported. Each audit
 * row must carry that user's own counts. This is the right-to-be-forgotten
 * evidence artifact, so its accuracy matters.
 */

function buildFakePrisma() {
  // user a: 2 messages, user b: 3 messages, no files.
  const fixtures = { a: { chatId: 'ca', messages: 2 }, b: { chatId: 'cb', messages: 3 } };
  return {
    user: {
      findMany: async () => ([
        { id: 'a', email: 'a@example.com', deletedAt: new Date(0) },
        { id: 'b', email: 'b@example.com', deletedAt: new Date(0) },
      ]),
    },
    chat: {
      findMany: async ({ where }) => {
        const f = fixtures[where.userId];
        return f ? [{ id: f.chatId }] : [];
      },
    },
    message: {
      findMany: async ({ where }) => {
        const chatId = where.chatId.in[0];
        const entry = Object.values(fixtures).find((f) => f.chatId === chatId);
        const n = entry ? entry.messages : 0;
        return Array.from({ length: n }, (_, i) => ({ id: `${chatId}-m${i}`, content: `pii ${i}`, metadata: {} }));
      },
      update: async () => ({}),
    },
    file: { findMany: async () => [], update: async () => ({}) },
  };
}

test('each user gets its OWN scrubbed counts in the audit row, not the running sum', async () => {
  const audited = [];
  const restore = mockResolvedModule(require.resolve('../src/utils/audit-log'), {
    writeAuditLog: async (_prisma, entry) => { audited.push(entry); },
  });
  try {
    const result = await run({
      prisma: buildFakePrisma(),
      // The scrub job deep-masks metadata/files JSON via maskObject, not just
      // free text via mask — the fake must expose BOTH or run() throws
      // `maskObject is not a function` (regressed when deep-scrub was added).
      piiMask: { mask: () => '[masked]', maskObject: (o) => o },
      dryRun: false,
      now: new Date('2030-01-01T00:00:00Z'),
      scrubAfterDays: 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    const rowA = audited.find((e) => e.resourceId === 'a');
    const rowB = audited.find((e) => e.resourceId === 'b');
    assert.ok(rowA && rowB, 'an audit row should be written per scrubbed user');

    assert.equal(rowA.metadata.messages, 2, 'user a should report its own 2 messages');
    assert.equal(rowB.metadata.messages, 3, 'user b should report its own 3 messages, NOT the cumulative 5');
    assert.equal(rowA.metadata.files, 0);
    assert.equal(rowB.metadata.files, 0);

    // Run-level aggregate is unchanged.
    assert.equal(result.messages, 5);
    assert.equal(result.users, 2);
  } finally {
    restore();
  }
});
