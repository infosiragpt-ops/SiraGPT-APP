'use strict';

/**
 * Chaos: SMTP timeout.
 *
 * Verifies that a mail-send wrapped in withRetry + AsyncGuard fails fast
 * within its deadline rather than hanging the calling request. This is the
 * pattern production code is supposed to use for outbound email.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { AsyncGuard, GuardError } = require('../../src/utils/async-guard');
const { withRetry } = require('../../src/utils/retry-with-backoff');

/** A fake transport whose `sendMail` never resolves. */
function makeHangingTransport() {
  return {
    sendMail() {
      return new Promise(() => { /* never resolves */ });
    },
  };
}

/** A fake transport that resolves after `ms`. */
function makeSlowTransport(ms) {
  return {
    sendMail() { return new Promise((r) => setTimeout(() => r({ accepted: ['x@y'] }), ms)); },
  };
}

describe('chaos: SMTP timeout', () => {
  it('AsyncGuard surfaces a GuardError before the request would hang', async () => {
    const transport = makeHangingTransport();
    const guard = new AsyncGuard({ defaultTimeoutMs: 30 });
    const t0 = Date.now();
    await assert.rejects(
      guard.run(transport.sendMail({ to: 'x@y' }), { label: 'smtp.send' }),
      (err) => err instanceof GuardError && err.code === 'GUARD_TIMEOUT'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `should bail well before 500ms, took ${elapsed}`);
  });

  it('withRetry does not loop forever on a hanging transport (deadline wins)', async () => {
    const transport = makeHangingTransport();
    const guard = new AsyncGuard({ defaultTimeoutMs: 25 });

    const send = () => guard.run(transport.sendMail({ to: 'x@y' }), { label: 'smtp.send' });

    const t0 = Date.now();
    await assert.rejects(
      withRetry(send, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        classifyError: (err) => ({
          retryable: err && err.code === 'GUARD_TIMEOUT',
          reason: 'smtp_timeout',
          ttlMs: 1,
        }),
      }),
      /timed out/i
    );
    const elapsed = Date.now() - t0;
    // 1 attempt + 2 retries × ~25ms each + a few ms of overhead.
    assert.ok(elapsed < 500, `should bail well under 500ms, took ${elapsed}`);
  });

  it('a transport that responds within deadline succeeds', async () => {
    const transport = makeSlowTransport(5);
    const guard = new AsyncGuard({ defaultTimeoutMs: 200 });
    const result = await guard.run(transport.sendMail({}), { label: 'smtp.send' });
    assert.deepEqual(result, { accepted: ['x@y'] });
  });
});
