'use strict';

/**
 * Ratchet 45 — failed-email retry queue tests.
 *
 * Drives the queue with an in-memory SystemSettings fake and a stub
 * email service. Verifies:
 *   - enqueue persists a JSON row keyed by `failed_email_retry:*`
 *   - enqueueIfFailed only persists on rejection (not on success)
 *   - runRetryPass redelivers successfully + drops the row
 *   - runRetryPass bumps attempts on continued failure
 *   - runRetryPass drops rows after MAX_ATTEMPTS
 *   - runRetryPass skips entirely when SMTP is unconfigured
 *   - malformed rows are cleaned up on the next pass
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const retry = require('../src/services/failed-email-retry');

function makeFakePrisma() {
  const store = new Map();
  return {
    _store: store,
    systemSettings: {
      create: async ({ data }) => {
        if (store.has(data.key)) {
          const err = new Error('Unique constraint failed');
          throw err;
        }
        store.set(data.key, { ...data });
        return store.get(data.key);
      },
      findMany: async ({ where }) => {
        const prefix = where && where.key && where.key.startsWith;
        return [...store.values()].filter(
          (r) => !prefix || r.key.startsWith(prefix),
        );
      },
      update: async ({ where, data }) => {
        const existing = store.get(where.key);
        if (!existing) throw new Error('row not found');
        store.set(where.key, { ...existing, ...data });
        return store.get(where.key);
      },
      delete: async ({ where }) => {
        store.delete(where.key);
        return {};
      },
    },
  };
}

function makeEmailService(opts = {}) {
  const calls = { invitation: 0, verification: 0 };
  let mode = opts.mode || 'ok'; // 'ok' | 'throw' | 'unconfigured'
  return {
    _calls: calls,
    _setMode: (m) => { mode = m; },
    isConfigured: () => mode !== 'unconfigured',
    sendOrgWelcome: async () => {
      calls.invitation += 1;
      if (mode === 'throw') throw new Error('SMTP boom');
      return true;
    },
    sendEmailVerification: async () => {
      calls.verification += 1;
      if (mode === 'throw') throw new Error('SMTP boom');
      return true;
    },
  };
}

describe('failed-email-retry.enqueue', () => {
  test('persists a row under failed_email_retry:<id>', async () => {
    const prisma = makeFakePrisma();
    const id = await retry.enqueue(prisma, 'invitation', {
      user: { email: 'a@b.com', name: 'A' },
      org: { id: 'o1', name: 'Org' },
    });
    assert.ok(id, 'returns row id');
    const key = `${retry.KEY_PREFIX}${id}`;
    const row = prisma._store.get(key);
    assert.ok(row, 'row stored');
    const parsed = JSON.parse(row.value);
    assert.equal(parsed.kind, 'invitation');
    assert.equal(parsed.attempts, 0);
    assert.equal(typeof parsed.firstFailedAt, 'string');
    assert.equal(parsed.lastAttemptAt, null);
  });

  test('rejects unknown kinds (returns null)', async () => {
    const prisma = makeFakePrisma();
    assert.equal(await retry.enqueue(prisma, 'bogus', {}), null);
    assert.equal(prisma._store.size, 0);
  });

  test('returns null when prisma is missing', async () => {
    assert.equal(await retry.enqueue(null, 'invitation', {}), null);
  });
});

describe('failed-email-retry.enqueueIfFailed', () => {
  test('does not persist on resolved send', async () => {
    const prisma = makeFakePrisma();
    const ok = await retry.enqueueIfFailed(
      prisma,
      'verification',
      { user: { email: 'a@b' }, token: 'tok' },
      Promise.resolve(true),
    );
    assert.equal(ok, true);
    assert.equal(prisma._store.size, 0);
  });

  test('persists a row on rejection', async () => {
    const prisma = makeFakePrisma();
    const ok = await retry.enqueueIfFailed(
      prisma,
      'invitation',
      { user: { email: 'a@b' }, org: { id: 'o' } },
      Promise.reject(new Error('SMTP down')),
    );
    assert.equal(ok, false);
    assert.equal(prisma._store.size, 1);
  });

  test('treats a `false` resolved sentinel as not-failed by default', async () => {
    const prisma = makeFakePrisma();
    // sendOrgWelcome returns `false` when SMTP is unconfigured — we
    // must not queue in that case (would flood SystemSettings in dev).
    const ok = await retry.enqueueIfFailed(
      prisma,
      'invitation',
      { user: { email: 'a@b' }, org: { id: 'o' } },
      Promise.resolve(false),
    );
    assert.equal(ok, false);
    assert.equal(prisma._store.size, 0);
  });
});

describe('failed-email-retry.runRetryPass', () => {
  let prisma;
  let email;
  beforeEach(() => { prisma = makeFakePrisma(); email = makeEmailService(); });

  test('redelivers successfully + deletes the row', async () => {
    await retry.enqueue(prisma, 'invitation', {
      user: { email: 'a@b.com' }, org: { id: 'o1' },
    });
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.redelivered, 1);
    assert.equal(summary.dropped, 0);
    assert.equal(summary.requeued, 0);
    assert.equal(prisma._store.size, 0, 'row deleted');
    assert.equal(email._calls.invitation, 1);
  });

  test('bumps attempts on a failed send (still under MAX_ATTEMPTS)', async () => {
    await retry.enqueue(prisma, 'verification', {
      user: { email: 'a@b.com' }, token: 't',
    });
    email._setMode('throw');
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.redelivered, 0);
    assert.equal(summary.dropped, 0);
    assert.equal(summary.requeued, 1);
    assert.equal(prisma._store.size, 1);
    const row = [...prisma._store.values()][0];
    const parsed = JSON.parse(row.value);
    assert.equal(parsed.attempts, 1);
    assert.ok(parsed.lastError);
    assert.equal(typeof parsed.lastAttemptAt, 'string');
  });

  test('drops a row after MAX_ATTEMPTS failures', async () => {
    const id = await retry.enqueue(prisma, 'verification', {
      user: { email: 'a@b.com' }, token: 't',
    });
    // Pre-seed the row so its `attempts` is one short of MAX so a
    // single failing pass tips it over.
    const key = `${retry.KEY_PREFIX}${id}`;
    const existing = prisma._store.get(key);
    const parsed = JSON.parse(existing.value);
    parsed.attempts = retry.MAX_ATTEMPTS - 1;
    existing.value = JSON.stringify(parsed);
    email._setMode('throw');
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.dropped, 1);
    assert.equal(summary.requeued, 0);
    assert.equal(prisma._store.size, 0, 'row deleted after max attempts');
  });

  test('skips entire pass when SMTP is unconfigured', async () => {
    await retry.enqueue(prisma, 'invitation', {
      user: { email: 'a@b.com' }, org: { id: 'o1' },
    });
    email._setMode('unconfigured');
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.equal(summary.scanned, 0);
    assert.equal(prisma._store.size, 1, 'row preserved for next pass');
  });

  test('cleans up malformed rows (unparseable JSON)', async () => {
    const key = `${retry.KEY_PREFIX}broken`;
    prisma._store.set(key, { key, value: '{not json' });
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.equal(summary.scanned, 0);
    assert.equal(prisma._store.size, 0, 'malformed row removed');
  });

  test('emits zero-summary on empty queue', async () => {
    const summary = await retry.runRetryPass({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.deepEqual(summary, { scanned: 0, redelivered: 0, dropped: 0, requeued: 0 });
  });

  test('exposes run(opts) as the cron entry point', async () => {
    assert.equal(typeof retry.run, 'function');
    const summary = await retry.run({ prisma, emailService: email, logger: { info() {}, warn() {} } });
    assert.deepEqual(summary, { scanned: 0, redelivered: 0, dropped: 0, requeued: 0 });
  });
});
