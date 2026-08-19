'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const triggers = require('../src/services/trigger-registry');
const slackIntegration = require('../src/services/slack-integration');

function buildFakePrisma({ endpoints = [], slack = null } = {}) {
  return {
    webhookEndpoint: {
      findMany: async () => endpoints,
      update: async () => ({}),
    },
    slackIntegration: {
      findFirst: async () => slack,
      update: async () => ({}),
    },
  };
}

describe('trigger-registry · publish', () => {
  beforeEach(() => triggers.resetForTests());

  test('exposes the canonical TRIGGERS list', () => {
    assert.ok(triggers.TRIGGERS.includes('chat.created'));
    assert.ok(triggers.TRIGGERS.includes('payment.succeeded'));
    assert.ok(triggers.isKnownTrigger('chat.archived'));
    assert.equal(triggers.isKnownTrigger('not.a.thing'), false);
  });

  test('fans out to matching webhook endpoints', async () => {
    const calls = [];
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [
        { id: 'e1', url: 'https://a.example/x', events: ['chat.created'], secret: 's1', isActive: true },
        { id: 'e2', url: 'https://b.example/y', events: ['payment.succeeded'], secret: 's2', isActive: true },
        { id: 'e3', url: 'https://c.example/z', events: ['*'], secret: 's3', isActive: true },
      ],
    }));
    triggers.__setDispatcher({
      dispatch: async (opts) => {
        calls.push(opts);
        return { id: 'd1', status: 'delivered', attempts: 1 };
      },
    });
    triggers.__setSlackSender({ sendEventNotification: async () => ({ ok: true, status: 200 }) });

    const result = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(result.deduped, false);
    assert.equal(calls.length, 2); // e1 + e3 (wildcard); e2 skipped
    assert.equal(calls[0].event, 'chat.created');
    assert.equal(result.dispatched, 2);
  });

  test('skips duplicate publishes via idempotency hash', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    const r1 = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    const r2 = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, true);
    assert.equal(dispatched, 1);
  });

  test('a publish result with errors remains retryable instead of being deduped', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{
        id: 'e1',
        url: 'https://a/x',
        events: ['payment.succeeded'],
        secret: 's',
        isActive: true,
      }],
    }));
    triggers.__setDispatcher({
      dispatch: async () => {
        dispatched += 1;
        return dispatched === 1
          ? { status: 'failed', error: 'temporary downstream failure' }
          : { status: 'delivered' };
      },
    });
    triggers.__setSlackSender(null);
    const payload = { stripeEventId: 'evt_retryable', idempotencyKey: 'stripe:evt_retryable' };

    const failed = await triggers.publish('payment.succeeded', payload, 'u1');
    const retried = await triggers.publish('payment.succeeded', payload, 'u1');

    assert.equal(failed.errors.length, 1);
    assert.equal(retried.errors.length, 0);
    assert.equal(retried.deduped, false);
    assert.equal(dispatched, 2);
  });

  test('different payloads produce different hashes', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    await triggers.publish('chat.created', { chatId: 'c2' }, 'u1');
    assert.equal(dispatched, 2);
  });

  test('fires Slack when configured + enabled', async () => {
    let slackCalls = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [],
      slack: {
        id: 's1',
        userId: 'u1',
        webhookUrl: 'https://hooks.slack.com/services/T/B/fire',
        isEnabled: true,
      },
    }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async () => { slackCalls++; return { ok: true, status: 200 }; },
    });
    const r = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(slackCalls, 1);
    assert.equal(r.dispatched, 1);
  });

  test('decrypts an encrypted Slack webhook before validated dispatch without exposing plaintext', async () => {
    const plaintext = 'https://hooks.slack.com/services/T000/B000/secret-value';
    const encrypted = slackIntegration.encryptToken(plaintext);
    let decryptCalls = 0;
    let dispatchedUrl = null;
    const logs = [];
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [],
      slack: {
        id: 's-encrypted',
        userId: 'u1',
        webhookUrl: encrypted,
        isEnabled: true,
      },
    }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender({
      decryptToken: (value) => {
        decryptCalls += 1;
        return slackIntegration.decryptToken(value);
      },
      sendEventNotification: async ({ webhookUrl }) => {
        dispatchedUrl = webhookUrl;
        return { ok: true, status: 200 };
      },
    });
    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    for (const level of Object.keys(originalConsole)) {
      console[level] = (...args) => {
        logs.push(args.map((arg) => (
          typeof arg === 'string' ? arg : JSON.stringify(arg)
        )).join(' '));
      };
    }

    let result;
    try {
      result = await triggers.publish('payment.succeeded', { invoiceId: 'in_1' }, 'u1');
    } finally {
      Object.assign(console, originalConsole);
    }

    assert.equal(decryptCalls, 1);
    assert.equal(dispatchedUrl, plaintext);
    assert.equal(result.dispatched, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
    assert.doesNotMatch(logs.join('\n'), /secret-value/);
  });

  test('redacts a decrypted Slack webhook from transport error results', async () => {
    const plaintext = 'https://hooks.slack.com/services/T000/B000/transport-secret';
    const encrypted = slackIntegration.encryptToken(plaintext);
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [],
      slack: {
        id: 's-transport-error',
        userId: 'u1',
        webhookUrl: encrypted,
        isEnabled: true,
      },
    }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender({
      decryptToken: slackIntegration.decryptToken,
      sendEventNotification: async ({ webhookUrl }) => {
        throw new Error(`request to ${webhookUrl} failed`);
      },
    });

    const result = await triggers.publish('payment.failed', { invoiceId: 'in_error' }, 'u1');

    assert.equal(result.dispatched, 0);
    assert.deepEqual(result.errors, [{
      stage: 'slack',
      message: 'Slack integration delivery failed',
    }]);
    assert.doesNotMatch(JSON.stringify(result), /transport-secret/);
  });

  test('reports unconfigured Slack as an explicit optional skipped-success', async () => {
    triggers.__setPrisma(buildFakePrisma({ endpoints: [], slack: null }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender(null);

    const result = await triggers.publish(
      'payment.succeeded',
      { stripeEventId: 'evt_no_slack' },
      'u1',
    );

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.integrations.slack, {
      configured: false,
      attempted: false,
      ok: true,
      skipped: 'not_configured',
    });
  });

  test('configured Slack {ok:false} is a retryable publish failure', async () => {
    let slackCalls = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [],
      slack: {
        id: 's-failing',
        userId: 'u1',
        webhookUrl: 'https://hooks.slack.com/services/T/B/failing',
        isEnabled: true,
      },
    }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async () => {
        slackCalls += 1;
        return { ok: false, status: 503 };
      },
    });
    const payload = { stripeEventId: 'evt_slack_retry', idempotencyKey: 'evt_slack_retry' };

    const first = await triggers.publish('payment.failed', payload, 'u1');
    const second = await triggers.publish('payment.failed', payload, 'u1');

    assert.equal(first.errors.length, 1);
    assert.equal(first.errors[0].stage, 'slack');
    assert.match(first.errors[0].message, /503/);
    assert.deepEqual(first.integrations.slack, {
      configured: true,
      attempted: true,
      ok: false,
      status: 503,
    });
    assert.equal(second.deduped, false);
    assert.equal(slackCalls, 2);
  });
});

describe('trigger-registry · publishDebounced', () => {
  beforeEach(() => triggers.resetForTests());

  test('collapses bursts into a single publish', async () => {
    let count = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.message_sent'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { count++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    const opts = { delayMs: 20, dedupeKey: 'chat:c1' };
    await Promise.all([
      triggers.publishDebounced('chat.message_sent', { msg: 'a' }, 'u1', opts),
      new Promise((r) => setTimeout(() => r(triggers.publishDebounced('chat.message_sent', { msg: 'b' }, 'u1', opts)), 5)),
    ]);
    // Wait a bit past the debounce window for the trailing dispatch.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(count, 1);
  });
});

describe('trigger-registry · event glob matcher (ratchet 45 Task 1)', () => {
  beforeEach(() => triggers.resetForTests());

  test('eventMatches handles literal, single-star and double-star patterns', () => {
    assert.equal(triggers.eventMatches('chat.created', 'chat.created'), true);
    assert.equal(triggers.eventMatches('chat.created', 'chat.archived'), false);
    assert.equal(triggers.eventMatches('*', 'anything.here'), true);
    assert.equal(triggers.eventMatches('**', 'a.b.c'), true);
    // Single-star tail matches one segment.
    assert.equal(triggers.eventMatches('org.invitation.*', 'org.invitation.created'), true);
    assert.equal(triggers.eventMatches('org.invitation.*', 'org.invitation.accepted'), true);
    assert.equal(triggers.eventMatches('org.invitation.*', 'org.invitation.revoked'), true);
    // Negative: different prefix must not match.
    assert.equal(triggers.eventMatches('org.invitation.*', 'org.member.created'), false);
    // Negative: '.*' is single-segment only.
    assert.equal(triggers.eventMatches('org.invitation.*', 'org.invitation.created.extra'), false);
    // Prefix wildcard.
    assert.equal(triggers.eventMatches('*.created', 'chat.created'), true);
    assert.equal(triggers.eventMatches('*.created', 'payment.succeeded'), false);
    // Bad inputs return false instead of throwing.
    assert.equal(triggers.eventMatches(null, 'x'), false);
    assert.equal(triggers.eventMatches('x', null), false);
  });

  test('publish fans out via wildcard subscription org.invitation.*', async () => {
    const calls = [];
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [
        { id: 'e1', url: 'https://a/x', events: ['org.invitation.*'], secret: 's', isActive: true },
        { id: 'e2', url: 'https://b/x', events: ['org.member.*'], secret: 's', isActive: true },
      ],
    }));
    triggers.__setDispatcher({
      dispatch: async (opts) => { calls.push(opts.event); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const r1 = await triggers.publish('org.invitation.created', { id: 'i1' }, 'u1');
    const r2 = await triggers.publish('org.invitation.accepted', { id: 'i2' }, 'u1');
    const r3 = await triggers.publish('org.invitation.revoked', { id: 'i3' }, 'u1');
    assert.deepEqual(calls, ['org.invitation.created', 'org.invitation.accepted', 'org.invitation.revoked']);
    assert.equal(r1.dispatched + r2.dispatched + r3.dispatched, 3);
  });
});

describe('trigger-registry · unknown events (ratchet 45)', () => {
  beforeEach(() => triggers.resetForTests());

  test('throws on unknown event by default', async () => {
    triggers.__setPrisma(buildFakePrisma());
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender(null);
    await assert.rejects(
      triggers.publish('not.a.real.event', { x: 1 }, 'u1'),
      /unknown trigger event/,
    );
  });

  test('lenient mode warns + no-ops + sets unknown flag', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['*'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);
    const orig = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      const r = await triggers.publish('still.unknown', { x: 1 }, 'u1', { allowUnknown: true });
      assert.equal(r.unknown, true);
      assert.equal(r.dispatched, 0);
      assert.equal(dispatched, 0);
      assert.equal(warned, true);
    } finally {
      console.warn = orig;
    }
  });

  test('known events still dispatch normally', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['*'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);
    const r = await triggers.publish('chat.created', { x: 1 }, 'u1');
    assert.equal(r.dispatched, 1);
    assert.equal(dispatched, 1);
  });
});

describe('trigger-registry · _eventHash', () => {
  test('is deterministic for the same input', () => {
    const a = triggers._eventHash('chat.created', 'u1', { id: 1 });
    const b = triggers._eventHash('chat.created', 'u1', { id: 1 });
    assert.equal(a, b);
    const c = triggers._eventHash('chat.created', 'u1', { id: 2 });
    assert.notEqual(a, c);
  });
});
