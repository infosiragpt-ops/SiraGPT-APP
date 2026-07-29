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
  const state = {
    advisoryLocks: 0,
    channel: structuredClone(channel),
    failNextTransactionAfterOperation: false,
    inboxMessages: [],
    nextInboxId: 1,
    nextPairingId: 1,
    pairing: null,
    pairings: [],
    transactionFailureCodes: [],
    transactions: 0,
  };
  const findPairing = ({ channelId, senderRef }) => state.pairings.find(
    (pairing) => pairing.channelId === channelId && pairing.senderRef === senderRef,
  );
  const matchesWhere = (pairing, where = {}) => {
    if (where.id?.in && !where.id.in.includes(pairing.id)) return false;
    if (where.channelId && pairing.channelId !== where.channelId) return false;
    if (where.status && pairing.status !== where.status) return false;
    if (where.expiresAt?.lte && pairing.expiresAt > where.expiresAt.lte) return false;
    if (where.expiresAt?.gt && pairing.expiresAt <= where.expiresAt.gt) return false;
    return true;
  };
  const client = {
    state,
    businessChannel: {
      findFirst: async ({ where } = {}) => {
        if (where?.id && state.channel.id !== where.id) return null;
        if (where?.companyId && state.channel.companyId !== where.companyId) return null;
        if (where?.userId && state.channel.userId !== where.userId) return null;
        return structuredClone(state.channel);
      },
      update: async ({ data }) => {
        state.channel = { ...state.channel, ...structuredClone(data), updatedAt: new Date() };
        return structuredClone(state.channel);
      },
    },
    inboxMessage: {
      create: async ({ data }) => {
        const duplicate = state.inboxMessages.find(
          (message) => (
            message.channelId === data.channelId
            && message.externalId === data.externalId
          ),
        );
        if (duplicate) {
          const error = new Error('unique inbox message');
          error.code = 'P2002';
          throw error;
        }
        const message = {
          id: `inbox-${state.nextInboxId++}`,
          ...structuredClone(data),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.inboxMessages.push(message);
        return structuredClone(message);
      },
      update: async ({ where, data }) => {
        const index = state.inboxMessages.findIndex((message) => message.id === where.id);
        state.inboxMessages[index] = {
          ...state.inboxMessages[index],
          ...structuredClone(data),
          updatedAt: new Date(),
        };
        return structuredClone(state.inboxMessages[index]);
      },
    },
    businessChannelPairing: {
      upsert: async ({ where, create, update }) => {
        const key = where.channelId_senderRef;
        const existing = findPairing(key);
        state.pairing = existing
          ? { ...existing, ...structuredClone(update), updatedAt: new Date() }
          : {
            id: `pair-${state.nextPairingId++}`,
            ...structuredClone(create),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        if (existing) {
          state.pairings[state.pairings.indexOf(existing)] = state.pairing;
        } else {
          state.pairings.push(state.pairing);
        }
        return structuredClone(state.pairing);
      },
      findUnique: async ({ where }) => structuredClone(
        findPairing(where.channelId_senderRef) || null,
      ),
      findMany: async ({ where }) => state.pairings
        .filter((pairing) => matchesWhere(pairing, where))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
        .map((pairing) => ({ id: pairing.id, senderRef: pairing.senderRef })),
      updateMany: async ({ where, data }) => {
        let count = 0;
        state.pairings = state.pairings.map((pairing) => {
          if (!matchesWhere(pairing, where)) return pairing;
          count += 1;
          const updated = { ...pairing, ...structuredClone(data), updatedAt: new Date() };
          if (state.pairing?.id === updated.id) state.pairing = updated;
          return updated;
        });
        return { count };
      },
      deleteMany: async ({ where }) => {
        const before = state.pairings.length;
        const removedIds = new Set(
          state.pairings
            .filter((pairing) => matchesWhere(pairing, where))
            .map((pairing) => pairing.id),
        );
        state.pairings = state.pairings.filter((pairing) => !removedIds.has(pairing.id));
        if (state.pairing && removedIds.has(state.pairing.id)) state.pairing = null;
        return { count: before - state.pairings.length };
      },
      update: async ({ where, data }) => {
        const existing = state.pairings.find((pairing) => pairing.id === where.id);
        state.pairing = { ...existing, ...structuredClone(data), updatedAt: new Date() };
        state.pairings[state.pairings.indexOf(existing)] = state.pairing;
        return structuredClone(state.pairing);
      },
    },
  };
  client.$transaction = async (operation) => {
    state.transactions += 1;
    const snapshot = structuredClone({
      channel: state.channel,
      inboxMessages: state.inboxMessages,
      nextInboxId: state.nextInboxId,
      nextPairingId: state.nextPairingId,
      pairing: state.pairing,
      pairings: state.pairings,
    });
    const tx = {
      ...client,
      $queryRaw: async () => {
        state.advisoryLocks += 1;
        return [];
      },
    };
    try {
      const result = await operation(tx);
      const transactionFailureCode = state.transactionFailureCodes.shift();
      if (transactionFailureCode) {
        const error = new Error('injected transaction write conflict');
        error.code = transactionFailureCode;
        throw error;
      }
      if (state.failNextTransactionAfterOperation) {
        state.failNextTransactionAfterOperation = false;
        throw new Error('injected_transaction_failure');
      }
      return result;
    } catch (error) {
      state.channel = snapshot.channel;
      state.inboxMessages = snapshot.inboxMessages;
      state.nextInboxId = snapshot.nextInboxId;
      state.nextPairingId = snapshot.nextPairingId;
      state.pairing = snapshot.pairing;
      state.pairings = snapshot.pairings;
      throw error;
    }
  };
  return client;
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
  assert.equal(authorization.created, true);
  assert.match(authorization.pairingCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(
    authorization.expiresAt.getTime() - now.getTime(),
    service.PAIRING_TTL_MS,
  );

  const repeated = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:42',
    now: new Date(now.getTime() + 30_000),
    env: ENV,
  });
  assert.equal(repeated.pairingCode, authorization.pairingCode);
  assert.equal(repeated.expiresAt.getTime(), authorization.expiresAt.getTime());
  assert.equal(repeated.created, false);

  const approved = await service.approvePairing({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    channelId: channel.id,
    senderRef: 'tg:42',
    code: authorization.pairingCode,
    now: new Date(now.getTime() + 30_000),
    env: ENV,
  });
  assert.deepEqual(approved.allowFrom, []);
  assert.equal(prisma.state.pairing.status, 'approved');
  const afterApproval = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:42',
    now: new Date(now.getTime() + 45_000),
    env: ENV,
  });
  assert.deepEqual(afterApproval, { allowed: true, reason: 'approved_pairing' });
  await assert.rejects(
    service.approvePairing({
      prisma,
      company: { id: 'company-1', userId: 'user-1' },
      channelId: channel.id,
      senderRef: 'tg:42',
      code: authorization.pairingCode,
      now: new Date(now.getTime() + 50_000),
      env: ENV,
    }),
    /invalid_or_expired_pairing_code/,
  );
  await service.revokePairing({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    channelId: channel.id,
    senderRef: 'tg:42',
    now: new Date(now.getTime() + 55_000),
  });
  const afterRevoke = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:42',
    now: new Date(now.getTime() + 60_000),
    env: ENV,
  });
  assert.equal(afterRevoke.reason, 'pairing_required');
  assert.equal(afterRevoke.created, true);
  assert.ok(prisma.state.transactions >= 5);
  assert.ok(prisma.state.advisoryLocks >= 5);
});

test('concurrent contact from one sender returns one stable persistent code', async () => {
  const channel = {
    id: 'channel-concurrent-sender',
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
  const now = new Date('2026-07-28T13:00:00.000Z');
  const responses = await Promise.all(Array.from({ length: 20 }, () => (
    service.authorizeSender({
      prisma,
      channel,
      senderRef: 'tg:concurrent',
      now,
      env: ENV,
    })
  )));
  assert.equal(new Set(responses.map((response) => response.pairingCode)).size, 1);
  assert.equal(responses.filter((response) => response.created).length, 1);
  assert.equal(prisma.state.pairings.length, 1);
  assert.equal(prisma.state.transactions, 20);
});

test('approval rollback leaves the pending code retryable', async () => {
  const channel = {
    id: 'channel-approval-rollback',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'slack',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const now = new Date('2026-07-28T14:00:00.000Z');
  const authorization = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'slack:rollback',
    now,
    env: ENV,
  });
  prisma.state.failNextTransactionAfterOperation = true;
  await assert.rejects(
    service.approvePairing({
      prisma,
      company: { id: 'company-1', userId: 'user-1' },
      channelId: channel.id,
      senderRef: 'slack:rollback',
      code: authorization.pairingCode,
      now: new Date(now.getTime() + 1_000),
      env: ENV,
    }),
    /injected_transaction_failure/,
  );
  assert.equal(prisma.state.pairings[0].status, 'pending');
  await service.approvePairing({
    prisma,
    company: { id: 'company-1', userId: 'user-1' },
    channelId: channel.id,
    senderRef: 'slack:rollback',
    code: authorization.pairingCode,
    now: new Date(now.getTime() + 2_000),
    env: ENV,
  });
  assert.equal(prisma.state.pairings[0].status, 'approved');
});

test('serializable write conflicts retry without duplicating pairing state', async () => {
  const channel = {
    id: 'channel-transaction-retry',
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
  prisma.state.transactionFailureCodes.push('P2034');
  const result = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:retry',
    env: ENV,
  });
  assert.equal(result.reason, 'pairing_required');
  assert.equal(prisma.state.transactions, 2);
  assert.equal(prisma.state.pairings.length, 1);
});

test('concurrent approvals preserve both persistent grants', async () => {
  const channel = {
    id: 'channel-concurrent-approval',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'whatsapp',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const now = new Date('2026-07-28T14:15:00.000Z');
  const senders = ['wa:a', 'wa:b'];
  const requests = await Promise.all(senders.map((senderRef) => (
    service.authorizeSender({ prisma, channel, senderRef, now, env: ENV })
  )));
  await Promise.all(senders.map((senderRef, index) => (
    service.approvePairing({
      prisma,
      company: { id: 'company-1', userId: 'user-1' },
      channelId: channel.id,
      senderRef,
      code: requests[index].pairingCode,
      now: new Date(now.getTime() + 1_000),
      env: ENV,
    })
  )));
  assert.equal(
    prisma.state.pairings.filter((pairing) => pairing.status === 'approved').length,
    2,
  );
  const grants = await Promise.all(senders.map((senderRef) => (
    service.authorizeSender({ prisma, channel, senderRef, now, env: ENV })
  )));
  assert.ok(grants.every((grant) => grant.reason === 'approved_pairing'));
});

test('pairing approval and authorization enforce company ownership', async () => {
  const channel = {
    id: 'channel-tenant-b',
    companyId: 'company-b',
    userId: 'user-b',
    kind: 'discord',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const authorization = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'discord:same-sender',
    env: ENV,
  });
  await assert.rejects(
    service.approvePairing({
      prisma,
      company: { id: 'company-a', userId: 'user-a' },
      channelId: channel.id,
      senderRef: 'discord:same-sender',
      code: authorization.pairingCode,
      env: ENV,
    }),
    /business_channel_not_found/,
  );
  prisma.state.pairings[0].companyId = 'company-a';
  await assert.rejects(
    service.authorizeSender({
      prisma,
      channel,
      senderRef: 'discord:same-sender',
      env: ENV,
    }),
    /business_channel_pairing_tenant_mismatch/,
  );
});

test('business-channel authorizer pins account scope and reloads live channel policy', async () => {
  const channel = {
    id: 'channel-live-policy',
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
  const authorizer = service.createBusinessChannelAuthorizer({
    prisma,
    companyId: channel.companyId,
    userId: channel.userId,
    channelId: channel.id,
    env: ENV,
  });
  assert.equal(authorizer.accountId, 'company-1:user-1:channel-live-policy');
  assert.deepEqual(
    await authorizer.authorizeInbound({
      accountId: 'company-2:user-2:channel-live-policy',
      senderId: 'tg:sender',
    }),
    { allowed: false, reason: 'business_channel_scope_mismatch' },
  );

  const pending = await authorizer.authorizeInbound({
    accountId: authorizer.accountId,
    senderId: 'tg:sender',
  });
  assert.equal(pending.reason, 'pairing_required');

  prisma.state.channel.status = 'paused';
  assert.deepEqual(
    await authorizer.authorizeInbound({
      accountId: authorizer.accountId,
      senderId: 'tg:sender',
    }),
    { allowed: false, reason: 'channel_unavailable' },
  );

  prisma.state.channel.status = 'active';
  prisma.state.channel.dmPolicy = 'allowlist';
  prisma.state.channel.allowFrom = ['tg:sender'];
  assert.deepEqual(
    await authorizer.authorizeInbound({
      accountId: authorizer.accountId,
      senderId: 'tg:sender',
    }),
    { allowed: true, reason: 'allowlist' },
  );
});

test('legacy pending hashes rotate explicitly and production requires a dedicated pepper', async () => {
  const channel = {
    id: 'channel-legacy',
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
  const now = new Date('2026-07-28T14:30:00.000Z');
  await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:legacy',
    now,
    env: ENV,
  });
  prisma.state.pairings[0].codeHash = '0'.repeat(64);
  const rotated = await service.authorizeSender({
    prisma,
    channel,
    senderRef: 'tg:legacy',
    now: new Date(now.getTime() + 1_000),
    env: ENV,
  });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.rotationReason, 'legacy_or_secret_changed');

  await assert.rejects(
    service.authorizeSender({
      prisma: fakePairingPrisma({ ...channel, id: 'channel-no-pepper' }),
      channel: { ...channel, id: 'channel-no-pepper' },
      senderRef: 'tg:no-pepper',
      env: { NODE_ENV: 'production' },
    }),
    /channel_pairing_secret_unavailable/,
  );
});

test("open policy requires '*' and closed policy ignores specific allowlist entries", async () => {
  const base = {
    id: 'channel-policy',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'discord',
    status: 'active',
    outboundMode: 'review',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const blockedOpen = await service.authorizeSender({
    prisma: fakePairingPrisma({ ...base, dmPolicy: 'open', allowFrom: [] }),
    channel: { ...base, dmPolicy: 'open', allowFrom: [] },
    senderRef: 'discord:7',
    env: ENV,
  });
  assert.deepEqual(blockedOpen, {
    allowed: false,
    reason: 'open_policy_requires_wildcard',
  });

  const explicitOpen = await service.authorizeSender({
    prisma: fakePairingPrisma({ ...base, dmPolicy: 'open', allowFrom: ['*'] }),
    channel: { ...base, dmPolicy: 'open', allowFrom: ['*'] },
    senderRef: 'discord:7',
    env: ENV,
  });
  assert.deepEqual(explicitOpen, {
    allowed: true,
    reason: 'explicit_open_policy',
  });

  const closed = await service.authorizeSender({
    prisma: fakePairingPrisma({
      ...base,
      dmPolicy: 'closed',
      allowFrom: ['discord:7'],
    }),
    channel: { ...base, dmPolicy: 'closed', allowFrom: ['discord:7'] },
    senderRef: 'discord:7',
    env: ENV,
  });
  assert.deepEqual(closed, {
    allowed: false,
    reason: 'sender_not_allowed',
  });
});

test('revocation refuses to claim success for a statically allowlisted sender', async () => {
  const channel = {
    id: 'channel-static-grant',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'slack',
    status: 'active',
    dmPolicy: 'allowlist',
    outboundMode: 'review',
    allowFrom: ['slack:static'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  await assert.rejects(
    service.revokePairing({
      prisma,
      company: { id: channel.companyId, userId: channel.userId },
      channelId: channel.id,
      senderRef: 'slack:static',
    }),
    /sender_statically_allowlisted/,
  );
});

test('concurrent persistent pairing stays within the per-channel row cap', async () => {
  const channel = {
    id: 'channel-cap',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'whatsapp',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const start = new Date('2026-07-28T15:00:00.000Z');
  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    service.authorizeSender({
      prisma,
      channel,
      senderRef: `wa:${index}`,
      now: new Date(start.getTime() + index * 1_000),
      env: ENV,
    })
  )));
  const pending = prisma.state.pairings.filter((pairing) => pairing.status === 'pending');
  assert.equal(pending.length, 3);
  assert.equal(prisma.state.pairings.length, 3);
  assert.equal(prisma.state.pairings.some((pairing) => pairing.senderRef === 'wa:0'), false);
  assert.equal(prisma.state.transactions, 20);
});

test('unknown inbound is paired first; approval permits one inbox and one run on replay', async () => {
  const channel = {
    id: 'channel-inbound-e2e',
    companyId: 'company-1',
    userId: 'user-1',
    kind: 'telegram',
    status: 'active',
    dmPolicy: 'pairing',
    outboundMode: 'review',
    allowFrom: [],
    company: {
      project: {
        codexLink: { codexProjectId: 'codex-project-1' },
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePairingPrisma(channel);
  const company = {
    id: channel.companyId,
    userId: channel.userId,
    name: 'Sira Test',
  };
  const now = new Date('2026-07-28T16:00:00.000Z');
  let runCalls = 0;
  const runService = {
    createRun: async () => {
      runCalls += 1;
      return { id: `run-${runCalls}` };
    },
  };
  const message = {
    externalId: 'telegram:update-42',
    from: 'tg:unknown',
    body: 'Necesito ayuda con la API',
  };

  const blocked = await service.recordInboundMessage({
    prisma,
    company,
    channelId: channel.id,
    message,
    runService,
    now,
    env: ENV,
  });
  assert.equal(blocked.authorization.reason, 'pairing_required');
  assert.equal(blocked.inboxMessage, null);
  assert.equal(prisma.state.inboxMessages.length, 0);
  assert.equal(runCalls, 0);

  await service.approvePairing({
    prisma,
    company,
    channelId: channel.id,
    senderRef: message.from,
    code: blocked.authorization.pairingCode,
    now: new Date(now.getTime() + 1_000),
    env: ENV,
  });

  const deliveries = await Promise.all(Array.from({ length: 10 }, () => (
    service.recordInboundMessage({
      prisma,
      company,
      channelId: channel.id,
      message,
      runService,
      now: new Date(now.getTime() + 2_000),
      env: ENV,
    })
  )));
  assert.equal(prisma.state.inboxMessages.length, 1);
  assert.equal(runCalls, 1);
  assert.equal(deliveries.filter((result) => result.duplicate === true).length, 9);
  assert.equal(prisma.state.inboxMessages[0].metadata.runId, 'run-1');
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
