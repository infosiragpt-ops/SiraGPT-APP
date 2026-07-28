'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/codex/business-channels');

const ENV = {
  NODE_ENV: 'test',
  CHANNEL_CREDENTIALS_KEY: '11'.repeat(32),
  CHANNEL_PAIRING_PEPPER: 'pairing-test-pepper',
};

function fakePairingPrisma(channel) {
  const state = { channel: structuredClone(channel), pairing: null };
  return {
    state,
    businessChannel: {
      findFirst: async () => structuredClone(state.channel),
      update: async ({ data }) => {
        state.channel = { ...state.channel, ...structuredClone(data), updatedAt: new Date() };
        return structuredClone(state.channel);
      },
    },
    businessChannelPairing: {
      upsert: async ({ create, update }) => {
        state.pairing = state.pairing
          ? { ...state.pairing, ...structuredClone(update), updatedAt: new Date() }
          : { id: 'pair-1', ...structuredClone(create), createdAt: new Date(), updatedAt: new Date() };
        return structuredClone(state.pairing);
      },
      findUnique: async () => structuredClone(state.pairing),
      update: async ({ data }) => {
        state.pairing = { ...state.pairing, ...structuredClone(data), updatedAt: new Date() };
        return structuredClone(state.pairing);
      },
    },
  };
}

test('channel credentials use authenticated encryption and never round-trip as plaintext storage', () => {
  const credentials = { token: 'secret-token', account: 'sales@example.test' };
  const sealed = service.sealCredentials(credentials, ENV);
  assert.match(sealed, /^v1:/);
  assert.doesNotMatch(sealed, /secret-token/);
  assert.deepEqual(service.openCredentials(sealed, ENV), credentials);
});

test('new channels default to pairing and review mode', async () => {
  let created = null;
  const prisma = {
    businessChannel: {
      create: async ({ data }) => {
        created = {
          id: 'channel-1',
          ...structuredClone(data),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return created;
      },
      update: async () => null,
    },
  };
  const channel = await service.upsertBusinessChannel({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    input: { kind: 'telegram', credentials: { token: 't' } },
    env: ENV,
  });
  assert.equal(channel.dmPolicy, 'pairing');
  assert.equal(channel.outboundMode, 'review');
  assert.equal(channel.credentialsConfigured, true);
  assert.equal(Object.hasOwn(channel, 'credentialsEncrypted'), false);
  assert.notEqual(created.credentialsEncrypted, JSON.stringify({ token: 't' }));
});

test('channel metadata drops hidden secrets before storage and response serialization', async () => {
  let created = null;
  const prisma = {
    businessChannel: {
      create: async ({ data }) => {
        created = {
          id: 'channel-safe-metadata',
          ...structuredClone(data),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return created;
      },
      update: async () => null,
    },
  };
  const channel = await service.upsertBusinessChannel({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    input: {
      kind: 'slack',
      metadata: {
        teamId: 'T123',
        accessToken: 'must-never-persist',
        nested: {
          api_key: 'also-secret',
          channelName: 'ventas',
        },
      },
    },
    env: ENV,
  });
  assert.deepEqual(created.metadata, {
    teamId: 'T123',
    nested: { channelName: 'ventas' },
  });
  assert.deepEqual(channel.metadata, created.metadata);
  assert.doesNotMatch(JSON.stringify(created), /must-never-persist|also-secret/);
});

test('metadata sanitizer also bounds arrays, depth and non-JSON values', () => {
  const sanitized = service.sanitizeChannelMetadata({
    safe: 'x'.repeat(3_000),
    cookie: 'session=secret',
    values: Array.from({ length: 80 }, (_, index) => index),
    nested: { one: { two: { three: { four: { five: 'too-deep' } } } } },
    invalid: Number.POSITIVE_INFINITY,
  });
  assert.equal(sanitized.safe.length, 2_000);
  assert.equal(sanitized.values.length, 50);
  assert.equal(Object.hasOwn(sanitized, 'cookie'), false);
  assert.equal(Object.hasOwn(sanitized, 'invalid'), false);
  assert.deepEqual(sanitized.nested.one.two.three, {});
});

test('unknown senders receive a short-lived pairing code and become allowlisted only after approval', async () => {
  const channel = {
    id: 'channel-1',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'telegram',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const now = new Date('2026-07-28T12:00:00.000Z');
  const authorization = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:42',
    now,
    env: ENV,
  });
  assert.equal(authorization.allowed, false);
  assert.equal(authorization.reason, 'pairing_required');
  assert.match(authorization.pairingCode, /^[A-F0-9]{10}$/);

  const approved = await service.approvePairing({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    channelId: channel.id,
    senderRef: 'tg:42',
    code: authorization.pairingCode,
    now: new Date(now.getTime() + 30_000),
    env: ENV,
  });
  assert.deepEqual(approved.allowFrom, ['tg:42']);
  assert.equal(prisma.state.pairing.status, 'approved');
});

test('channel router maps business intent to the owning department', () => {
  assert.equal(service.classifyDepartment('Quiero una cotización y una demo').id, 'sales');
  assert.equal(service.classifyDepartment('Hay un error en mi factura, necesito soporte').id, 'customer-success');
  assert.equal(service.classifyDepartment('Detectamos un problema de privacidad').id, 'trust');
  assert.equal(service.classifyDepartment('Ayúdame con la API de la aplicación').id, 'product-engineering');
  assert.equal(service.classifyDepartment('Hola').id, 'ceo-office');
});

test('channel doctor fails high-risk open and empty-allowlist policies', async () => {
  const prisma = {
    businessChannel: {
      findMany: async () => [
        {
          id: 'open',
          dmPolicy: 'open',
          allowFrom: [],
          outboundMode: 'auto',
          credentialsEncrypted: 'v1:x',
          connectorAccountId: null,
        },
        {
          id: 'empty',
          dmPolicy: 'allowlist',
          allowFrom: [],
          outboundMode: 'review',
          credentialsEncrypted: null,
          connectorAccountId: null,
        },
      ],
    },
  };
  const audit = await service.auditChannelPolicies({
    prisma,
    companyId: 'company-1',
    userId: 'user-1',
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.findings.some((finding) => finding.code === 'open_dm_policy'));
  assert.ok(audit.findings.some((finding) => finding.code === 'empty_allowlist'));
  assert.ok(audit.findings.some((finding) => finding.code === 'credentials_missing'));
});
