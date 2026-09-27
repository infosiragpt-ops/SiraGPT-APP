'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach, afterEach } = require('node:test');

const { maybeDeliver, _resetForTests } = require('../src/services/webpush-delivery');

const silentLogger = { info() {}, warn() {}, error() {} };

function makeWebpushStub({ failures = {} } = {}) {
  const sent = [];
  return {
    sent,
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      sent.push({ sub, payload });
      const fail = failures[sub.endpoint];
      if (fail) {
        const err = new Error(fail.message || 'send failed');
        err.statusCode = fail.statusCode;
        throw err;
      }
      return { statusCode: 201 };
    },
  };
}

function makePrisma({ subs = [], deleteCapture = [] } = {}) {
  return {
    pushSubscription: {
      async findMany() { return subs; },
      async delete(args) { deleteCapture.push(args); return { id: args.where.id }; },
    },
  };
}

describe('webpush-delivery.maybeDeliver', () => {
  beforeEach(() => {
    _resetForTests();
    process.env.VAPID_PUBLIC_KEY = 'pub-key';
    process.env.VAPID_PRIVATE_KEY = 'priv-key';
  });
  afterEach(() => {
    _resetForTests();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  test('skips when severity is not critical', async () => {
    const webpush = makeWebpushStub();
    const prisma = makePrisma({ subs: [{ id: 's1', endpoint: 'e', p256dh: 'p', auth: 'a', platform: 'web' }] });
    const res = await maybeDeliver(prisma, { userId: 'u1', severity: 'warning' }, { webpush, logger: silentLogger });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'not-critical');
    assert.equal(webpush.sent.length, 0);
  });

  test('skips when prisma has no pushSubscription model', async () => {
    const webpush = makeWebpushStub();
    const res = await maybeDeliver({}, { userId: 'u1', severity: 'critical' }, { webpush, logger: silentLogger });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-model');
  });

  test('skips when VAPID keys missing', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const webpush = makeWebpushStub();
    const prisma = makePrisma();
    const res = await maybeDeliver(prisma, { userId: 'u1', severity: 'critical' }, { webpush, logger: silentLogger });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-vapid');
  });

  test('returns no-subs when user has zero browser subscriptions', async () => {
    const webpush = makeWebpushStub();
    const prisma = makePrisma({ subs: [] });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical' },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.attempted, 0);
    assert.equal(res.delivered, 0);
    assert.equal(res.reason, 'no-subs');
  });

  test('delivers to all browser subs', async () => {
    const webpush = makeWebpushStub();
    const subs = [
      { id: 's1', endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1', platform: 'web' },
      { id: 's2', endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2', platform: 'web' },
    ];
    const prisma = makePrisma({ subs });
    const res = await maybeDeliver(
      prisma,
      {
        id: 'n1',
        userId: 'u1',
        severity: 'critical',
        title: 'Hello',
        message: 'world',
        type: 'announcement',
      },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.attempted, 2);
    assert.equal(res.delivered, 2);
    assert.equal(res.failed, 0);
    assert.equal(webpush.sent.length, 2);
    const payload = JSON.parse(webpush.sent[0].payload);
    assert.equal(payload.title, 'Hello');
    assert.equal(payload.body, 'world');
    assert.equal(payload.severity, 'critical');
  });

  test('ignores native subs without endpoint/keys', async () => {
    const webpush = makeWebpushStub();
    const subs = [
      { id: 's1', endpoint: null, p256dh: null, auth: null, platform: 'ios', token: 'apns-token' },
      { id: 's2', endpoint: 'https://push.example/b', p256dh: 'p', auth: 'a', platform: 'web' },
    ];
    const prisma = makePrisma({ subs });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.attempted, 1);
    assert.equal(res.delivered, 1);
  });

  test('drops dead subscriptions on 410 Gone', async () => {
    const webpush = makeWebpushStub({
      failures: { 'https://push.example/dead': { statusCode: 410, message: 'gone' } },
    });
    const subs = [
      { id: 'dead-1', endpoint: 'https://push.example/dead', p256dh: 'p', auth: 'a', platform: 'web' },
      { id: 'ok-1', endpoint: 'https://push.example/ok', p256dh: 'p', auth: 'a', platform: 'web' },
    ];
    const deleteCapture = [];
    const prisma = makePrisma({ subs, deleteCapture });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.attempted, 2);
    assert.equal(res.delivered, 1);
    assert.equal(res.failed, 1);
    assert.equal(deleteCapture.length, 1);
    assert.equal(deleteCapture[0].where.id, 'dead-1');
  });

  test('non-410 errors are logged but do not delete sub', async () => {
    const webpush = makeWebpushStub({
      failures: { 'https://push.example/x': { statusCode: 500, message: 'boom' } },
    });
    const subs = [
      { id: 's1', endpoint: 'https://push.example/x', p256dh: 'p', auth: 'a', platform: 'web' },
    ];
    const deleteCapture = [];
    const prisma = makePrisma({ subs, deleteCapture });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.delivered, 0);
    assert.equal(res.failed, 1);
    assert.equal(deleteCapture.length, 0);
  });

  test('handles findMany throwing', async () => {
    const webpush = makeWebpushStub();
    const prisma = {
      pushSubscription: {
        async findMany() { throw new Error('db down'); },
      },
    };
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical' },
      { webpush, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'lookup-failed');
  });
});

// Production 2026-09-27: web push is not configured (no VAPID keys, no
// `web-push` package) and the skip was logged as a failure with the whole
// require stack. "Off" is a state: say it once per process, never per message.
describe('webpush-delivery skip notices', () => {
  function capturingLogger() {
    const lines = [];
    const at = (level) => (message) => lines.push({ level, message: String(message) });
    return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  }
  const critical = { userId: 'u1', severity: 'critical', title: 't', message: 'm' };

  beforeEach(() => {
    _resetForTests();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });
  afterEach(() => {
    _resetForTests();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  test('without VAPID keys web-push is never loaded and the state is logged once, at debug', async () => {
    const logger = capturingLogger();
    let loads = 0;
    const loadWebPush = () => { loads += 1; throw Object.assign(new Error("Cannot find module 'web-push'"), { code: 'MODULE_NOT_FOUND' }); };
    for (let i = 0; i < 3; i += 1) {
      const res = await maybeDeliver(makePrisma(), critical, { logger, loadWebPush });
      assert.equal(res.skipped, true);
      assert.equal(res.reason, 'no-vapid');
    }
    assert.equal(loads, 0, 'an unconfigured channel does not touch the optional package');
    assert.deepEqual(logger.lines.map((line) => line.level), ['debug']);
    assert.match(logger.lines[0].message, /not configured/);
  });

  test('VAPID set but package missing warns once, with the error code and without the require stack', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub-key';
    process.env.VAPID_PRIVATE_KEY = 'priv-key';
    const logger = capturingLogger();
    let loads = 0;
    const loadWebPush = () => {
      loads += 1;
      throw Object.assign(new Error("Cannot find module 'web-push'\nRequire stack:\n- /app/src/services/webpush-delivery.js"), { code: 'MODULE_NOT_FOUND' });
    };
    for (let i = 0; i < 3; i += 1) {
      const res = await maybeDeliver(makePrisma(), critical, { logger, loadWebPush });
      assert.equal(res.reason, 'no-webpush-lib');
    }
    assert.equal(loads, 1, 'the require is attempted once per process');
    assert.deepEqual(logger.lines.map((line) => line.level), ['warn']);
    assert.match(logger.lines[0].message, /MODULE_NOT_FOUND/);
    assert.doesNotMatch(logger.lines[0].message, /Require stack|\/app\//);
  });

  test('a rejected VAPID configuration warns once and keeps skipping', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub-key';
    process.env.VAPID_PRIVATE_KEY = 'priv-key';
    const logger = capturingLogger();
    const webpush = { ...makeWebpushStub(), setVapidDetails() { throw new Error('Vapid public key should be 65 bytes long when decoded.'); } };
    for (let i = 0; i < 2; i += 1) {
      const res = await maybeDeliver(makePrisma(), critical, { logger, webpush });
      assert.equal(res.reason, 'no-vapid');
    }
    assert.deepEqual(logger.lines.map((line) => line.level), ['warn']);
  });
});
