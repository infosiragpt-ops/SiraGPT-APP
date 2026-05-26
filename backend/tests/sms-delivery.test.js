'use strict';

/**
 * Ratchet 45 — sms-delivery service tests.
 *
 * Covers the same guard matrix as `webpush-delivery`:
 *  - severity !== 'critical' short-circuits
 *  - missing userId / prisma.user / phone column → skip
 *  - missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN → skip
 *  - missing both TWILIO_FROM_NUMBER and TWILIO_MESSAGING_SERVICE_SID → skip
 *  - happy path delivers via twilio.messages.create
 *  - send errors are swallowed (returns failed=1, never throws)
 *  - prefers TWILIO_MESSAGING_SERVICE_SID over TWILIO_FROM_NUMBER
 *  - body is built from "<title>: <message>" and truncated when very long
 */

const assert = require('node:assert/strict');
const { describe, test, beforeEach, afterEach } = require('node:test');

const { maybeDeliver, _resetForTests } = require('../src/services/sms-delivery');

const silentLogger = { info() {}, warn() {}, error() {} };

function makeTwilioStub({ failOnce = false } = {}) {
  const sent = [];
  const client = {
    messages: {
      async create(payload) {
        sent.push(payload);
        if (failOnce) {
          failOnce = false;
          const err = new Error('twilio boom');
          err.code = 21610;
          throw err;
        }
        return { sid: `SM${sent.length}` };
      },
    },
  };
  // The module accepts either a callable (twilio(sid,token)) OR an
  // already-constructed client passed via `opts.client`.
  return { client, sent };
}

function makePrisma({ user = null, lookupFails = false } = {}) {
  return {
    user: {
      async findUnique() {
        if (lookupFails) throw new Error('db down');
        return user;
      },
    },
  };
}

describe('sms-delivery.maybeDeliver', () => {
  beforeEach(() => {
    _resetForTests();
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
    process.env.TWILIO_FROM_NUMBER = '+15550001111';
  });
  afterEach(() => {
    _resetForTests();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  });

  test('skips when severity is not critical', async () => {
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'warning', title: 't', message: 'm' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'not-critical');
    assert.equal(stub.sent.length, 0);
  });

  test('skips when prisma has no user delegate', async () => {
    const stub = makeTwilioStub();
    const res = await maybeDeliver(
      {},
      { userId: 'u1', severity: 'critical' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-model');
  });

  test('skips when user has no phone', async () => {
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: null } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-phone');
    assert.equal(stub.sent.length, 0);
  });

  test('skips when TWILIO env is missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-twilio-env');
  });

  test('skips when neither FROM_NUMBER nor MESSAGING_SERVICE_SID is set', async () => {
    delete process.env.TWILIO_FROM_NUMBER;
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 't', message: 'm' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-twilio-sender');
  });

  test('delivers via twilio.messages.create on happy path', async () => {
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 'Alert', message: 'Server on fire' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.attempted, 1);
    assert.equal(res.delivered, 1);
    assert.equal(res.failed, 0);
    assert.equal(stub.sent.length, 1);
    assert.equal(stub.sent[0].to, '+15557654321');
    assert.equal(stub.sent[0].from, '+15550001111');
    assert.equal(stub.sent[0].body, 'Alert: Server on fire');
  });

  test('prefers messagingServiceSid over from-number when both are set', async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG_test';
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 'T', message: 'M' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.delivered, 1);
    assert.equal(stub.sent[0].messagingServiceSid, 'MG_test');
    assert.equal(stub.sent[0].from, undefined);
  });

  test('swallows twilio send errors and reports failed=1', async () => {
    const stub = makeTwilioStub({ failOnce: true });
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 'T', message: 'M' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.attempted, 1);
    assert.equal(res.delivered, 0);
    assert.equal(res.failed, 1);
    assert.equal(res.skipped, false);
    assert.equal(res.reason, 'send-failed');
  });

  test('returns lookup-failed when user query throws', async () => {
    const stub = makeTwilioStub();
    const prisma = makePrisma({ lookupFails: true });
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical' },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'lookup-failed');
  });

  test('truncates very long bodies', async () => {
    const stub = makeTwilioStub();
    const prisma = makePrisma({ user: { phone: '+15557654321' } });
    const longMsg = 'x'.repeat(2000);
    const res = await maybeDeliver(
      prisma,
      { userId: 'u1', severity: 'critical', title: 'T', message: longMsg },
      { client: stub.client, twilio: () => stub.client, logger: silentLogger },
    );
    assert.equal(res.delivered, 1);
    assert.ok(stub.sent[0].body.length <= 480);
    assert.ok(stub.sent[0].body.endsWith('…'));
  });
});
