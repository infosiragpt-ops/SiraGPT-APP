'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createNotifier,
  buildDigestBody,
  sanitizeText,
  NOTIFY_KINDS,
  DEFAULT_DEDUPE_TTL_MS,
} = require('../src/services/notify');

function makeTransport(log, name, { fail = false } = {}) {
  return async (payload) => {
    log.push({ name, payload });
    if (fail) throw new Error(`${name} transport down`);
    return { ok: true };
  };
}

describe('notify — unified dispatcher', () => {
  describe('fan-out by prefsProvider', () => {
    it('delivers only to the channels the user prefers', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email'),
          telegram: makeTransport(log, 'telegram'),
          webpush: makeTransport(log, 'webpush'),
        },
        prefsProvider: async () => ({ channels: ['email', 'telegram'] }),
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_done',
        title: 'Build listo',
        body: 'La tarea terminó bien.',
      });

      assert.deepEqual(result, { delivered: ['email', 'telegram'], failed: [], deduped: false });
      assert.deepEqual(log.map((entry) => entry.name).sort(), ['email', 'telegram']);
    });

    it('defaults to every injected transport when there is no prefsProvider', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email'),
          telegram: makeTransport(log, 'telegram'),
        },
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'approval_pending',
        title: 'Aprobación',
        body: 'Hay una acción esperando tu OK.',
      });

      assert.deepEqual(result.delivered, ['email', 'telegram']);
      assert.equal(result.failed.length, 0);
    });

    it('ignores preferred channels that have no transport injected', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: { email: makeTransport(log, 'email') },
        prefsProvider: async () => ({ channels: ['email', 'sms', 'telegram'] }),
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'digest',
        title: 'Resumen',
        body: 'Digest diario.',
      });

      assert.deepEqual(result.delivered, ['email']);
      assert.equal(result.failed.length, 0);
    });

    it('falls back to all transports when prefsProvider throws', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email'),
          telegram: makeTransport(log, 'telegram'),
        },
        prefsProvider: async () => {
          throw new Error('prefs store down');
        },
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_done',
        title: 'ok',
        body: 'ok',
      });

      assert.deepEqual(result.delivered, ['email', 'telegram']);
    });

    it('an empty channels preference means the user opted out (no delivery)', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: { email: makeTransport(log, 'email') },
        prefsProvider: async () => ({ channels: [] }),
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_done',
        title: 'ok',
        body: 'ok',
      });

      assert.deepEqual(result, { delivered: [], failed: [], deduped: false });
      assert.equal(log.length, 0);
    });
  });

  describe('best-effort per channel', () => {
    it('one throwing transport never blocks the others', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email', { fail: true }),
          telegram: makeTransport(log, 'telegram'),
          webpush: makeTransport(log, 'webpush'),
        },
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_error',
        title: 'Falló la tarea',
        body: 'Detalle del error.',
      });

      assert.deepEqual(result.delivered, ['telegram', 'webpush']);
      assert.deepEqual(result.failed, [{ channel: 'email', error: 'email transport down' }]);
      assert.equal(result.deduped, false);
      // The failing transport was still attempted.
      assert.equal(log.filter((entry) => entry.name === 'email').length, 1);
    });

    it('all transports failing still resolves (never throws)', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email', { fail: true }),
          telegram: makeTransport(log, 'telegram', { fail: true }),
        },
      });

      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_error',
        title: 't',
        body: 'b',
      });

      assert.deepEqual(result.delivered, []);
      assert.deepEqual(
        result.failed.map((failure) => failure.channel),
        ['email', 'telegram'],
      );
    });
  });

  describe('dedupe by dedupeKey with TTL (fake clock)', () => {
    it('suppresses a repeat inside the TTL and allows it after expiry', async () => {
      let fakeTime = 1_000_000;
      const log = [];
      const notifier = createNotifier({
        transports: { email: makeTransport(log, 'email') },
        now: () => fakeTime,
      });

      const message = {
        userId: 'u1',
        kind: 'task_done',
        title: 'ok',
        body: 'ok',
        dedupeKey: 'task-42-done',
      };

      const first = await notifier.notify(message);
      assert.deepEqual(first, { delivered: ['email'], failed: [], deduped: false });

      // 9 minutes later: still inside the 10-minute window → deduped, no send.
      fakeTime += 9 * 60 * 1000;
      const second = await notifier.notify(message);
      assert.deepEqual(second, { delivered: [], failed: [], deduped: true });
      assert.equal(log.length, 1);

      // Cross the TTL (10 min from the FIRST send) → delivered again.
      fakeTime += 61 * 1000;
      const third = await notifier.notify(message);
      assert.deepEqual(third, { delivered: ['email'], failed: [], deduped: false });
      assert.equal(log.length, 2);
    });

    it('different dedupeKeys never collide and no key means no dedupe', async () => {
      let fakeTime = 5_000;
      const log = [];
      const notifier = createNotifier({
        transports: { email: makeTransport(log, 'email') },
        now: () => fakeTime,
      });

      await notifier.notify({ userId: 'u1', kind: 'task_done', title: 'a', body: 'a', dedupeKey: 'k1' });
      await notifier.notify({ userId: 'u1', kind: 'task_done', title: 'b', body: 'b', dedupeKey: 'k2' });
      // Same content twice, but with no dedupeKey → both go out.
      await notifier.notify({ userId: 'u1', kind: 'task_done', title: 'c', body: 'c' });
      await notifier.notify({ userId: 'u1', kind: 'task_done', title: 'c', body: 'c' });

      assert.equal(log.length, 4);
      assert.equal(DEFAULT_DEDUPE_TTL_MS, 10 * 60 * 1000);
    });
  });

  describe('buildDigestBody', () => {
    it('formats N items compactly in Spanish', () => {
      const digest = buildDigestBody({
        items: [
          { kind: 'task_done', title: 'Deploy backend', body: 'Sin errores' },
          { kind: 'task_error', title: 'Scraper leads' },
          { kind: 'approval_pending', title: 'Enviar propuesta', body: 'Esperando tu OK' },
        ],
      });

      const lines = digest.split('\n');
      assert.equal(lines.length, 4);
      assert.equal(lines[0], 'Resumen diario — 3 elementos:');
      assert.equal(lines[1], '1. [Completado] Deploy backend — Sin errores');
      assert.equal(lines[2], '2. [Error] Scraper leads');
      assert.equal(lines[3], '3. [Aprobación pendiente] Enviar propuesta — Esperando tu OK');
    });

    it('handles the empty/singular cases without exploding', () => {
      assert.equal(buildDigestBody({ items: [] }), 'Resumen diario: sin novedades.');
      assert.equal(buildDigestBody(), 'Resumen diario: sin novedades.');
      assert.match(buildDigestBody({ items: [{ title: 'solo uno' }] }), /1 elemento:/);
    });
  });

  describe('payload hygiene', () => {
    it('whitelists payload fields and redacts secret-looking material', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: { email: makeTransport(log, 'email') },
      });

      await notifier.notify({
        userId: 'u1',
        kind: 'task_done',
        title: 'Key sk-abcdefghijklmnop leaked',
        body: 'Header was Bearer abc.def.ghi-jkl_mno and password=SuperSecret1',
        dedupeKey: 'x',
        // Caller noise that must NEVER reach a transport:
        apiKey: 'sk-should-not-pass',
        prisma: { fake: true },
      });

      const { payload } = log[0];
      assert.deepEqual(Object.keys(payload).sort(), ['body', 'kind', 'title', 'userId']);
      assert.ok(!payload.title.includes('sk-abcdefghijklmnop'));
      assert.ok(!payload.body.includes('SuperSecret1'));
      assert.ok(!/Bearer\s+abc/.test(payload.body));
      assert.ok(payload.title.includes('[redacted]'));
    });

    it('sanitizeText is exported and caps length', () => {
      assert.equal(sanitizeText(null), '');
      assert.equal(sanitizeText('hola'), 'hola');
      assert.equal(sanitizeText('x'.repeat(9000)).length, 4000);
    });
  });

  describe('edge cases', () => {
    it('zero transports → {delivered:[]} without exploding', async () => {
      const notifier = createNotifier({});
      const result = await notifier.notify({
        userId: 'u1',
        kind: 'digest',
        title: 'Resumen',
        body: 'Nada que enviar.',
      });
      assert.deepEqual(result, { delivered: [], failed: [], deduped: false });
    });

    it('rejects unknown kinds loudly', async () => {
      const notifier = createNotifier({});
      await assert.rejects(
        () => notifier.notify({ userId: 'u1', kind: 'party_time', title: 't', body: 'b' }),
        /unknown kind/,
      );
      assert.deepEqual(NOTIFY_KINDS, ['task_done', 'task_error', 'approval_pending', 'digest']);
    });

    it('non-function transport values are ignored', async () => {
      const log = [];
      const notifier = createNotifier({
        transports: {
          email: makeTransport(log, 'email'),
          telegram: null,
          webpush: 'not-a-function',
        },
      });
      const result = await notifier.notify({
        userId: 'u1',
        kind: 'task_done',
        title: 't',
        body: 'b',
      });
      assert.deepEqual(result.delivered, ['email']);
      assert.equal(result.failed.length, 0);
    });
  });
});
