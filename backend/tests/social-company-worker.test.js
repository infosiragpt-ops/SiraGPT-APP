'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  claimWithinDailyLimit,
  countPublishedToday,
  livePolicyAuthorization,
  processPost,
  recoverStalePublishing,
  runOnce,
} = require('../src/services/social-company/worker');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

function socialConnection(platform, overrides = {}) {
  return {
    id: `connection-${platform}`,
    platform,
    accountId: `account-${platform}`,
    accessToken: `token-${platform}`,
    ...overrides,
  };
}

function socialKey(platform, overrides = {}) {
  return socialResourceKeyForConnection(socialConnection(platform, overrides));
}

test('live policy gate revokes a platform disabled after preparation', () => {
  const denied = livePolicyAuthorization(
    { config: { approved: true } },
    { approved: true, source: 'ceo_office' },
    {
      enabled: true,
      mode: 'review',
      autopilot: false,
      platforms: { facebook: false, linkedin: false, x: false },
    },
    'linkedin',
  );
  assert.equal(denied.code, 'SOCIAL_PLATFORM_PAUSED');
});

function makePrisma({ policy, connections }) {
  const updates = [];
  const policyKeys = [];
  let scheduledStatus = 'scheduled';
  let scheduledScope = null;
  const connectionRows = Object.fromEntries(
    Object.entries(connections).map(([platform, connection]) => [
      platform,
      socialConnection(platform, connection),
    ]),
  );
  return {
    updates,
    policyKeys,
    setScheduledStatus(status) {
      scheduledStatus = status;
    },
    getScheduledStatus() {
      return scheduledStatus;
    },
    codexProject: {
      findFirst: async ({ where }) => ({
        id: where.id,
        userId: where.userId,
        deletedAt: null,
        brief: {
          companyResources: {
            assignments: {
              [socialKey('facebook', connections.facebook)]: 'marketing',
              [socialKey('linkedin', connections.linkedin)]: 'marketing',
              [socialKey('x', connections.x)]: 'marketing',
            },
            pinned: [],
          },
        },
        companyLink: {
          project: { id: 'company-1', userId: where.userId, deletedAt: null },
        },
      }),
    },
    systemSettings: {
      findUnique: async ({ where }) => {
        policyKeys.push(where.key);
        return { value: JSON.stringify(policy) };
      },
    },
    scheduledPost: {
      count: async () => 0,
      updateMany: async ({ where, data }) => {
        scheduledStatus = data.status;
        scheduledScope = where?.config?.equals || scheduledScope;
        return { count: 1 };
      },
      findFirst: async ({ where }) => ({
        id: where.id,
        userId: where.userId,
        status: scheduledStatus,
        config: { workspaceId: scheduledScope || 'workspace-a' },
      }),
      update: async ({ data }) => {
        updates.push(data);
        scheduledStatus = data.status;
        return { id: 'post-1', ...data };
      },
    },
    socialConnection: {
      findMany: async ({ where }) => Object.values(connectionRows)
        .filter((connection) => (
          !where?.platform?.in || where.platform.in.includes(connection.platform)
        )),
      findUnique: async ({ where }) => (
        connectionRows[where.userId_platform.platform] || null
      ),
    },
  };
}

test('worker refuses unapproved posts while policy is in review mode', async () => {
  const prisma = makePrisma({
    policy: { enabled: true, mode: 'review', dailyLimit: 3 },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-1',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['facebook'],
      scheduledAt: new Date(),
      config: { approved: false, workspaceId: 'workspace-a' },
    },
  });
  assert.equal(result.action, 'skipped_review');
  assert.equal(prisma.updates.length, 0);
});

test('worker never lets a user-wide legacy policy auto-approve an unscoped post', async () => {
  const prisma = makePrisma({
    policy: { enabled: true, mode: 'auto', dailyLimit: 3 },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-unscoped',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: false },
    },
  });

  assert.equal(result.action, 'skipped_policy_scope_required');
  assert.equal(prisma.policyKeys.length, 0);
});

test('worker also rejects explicitly approved legacy posts without a company scope', async () => {
  const prisma = makePrisma({
    policy: { enabled: true, mode: 'review', dailyLimit: 3 },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-unscoped-approved',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true },
    },
  });
  assert.equal(result.action, 'skipped_policy_scope_required');
  assert.equal(prisma.policyKeys.length, 0);
});

test('worker resolves the policy in the queued post workspace', async () => {
  const prisma = makePrisma({
    policy: { enabled: false, mode: 'review', workspaceId: 'workspace-a' },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-scoped',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, workspaceId: 'workspace-a' },
    },
  });

  assert.equal(result.action, 'skipped_paused');
  assert.equal(prisma.policyKeys.length, 1);
  assert.match(prisma.policyKeys[0], /^social_company_policy:v2:u1:workspace-a$/);
});

test('worker applies the daily publication limit within the same workspace', async () => {
  let countWhere = null;
  const prisma = {
    scheduledPost: {
      count: async ({ where }) => {
        countWhere = where;
        return 2;
      },
    },
  };
  const count = await countPublishedToday(
    prisma,
    'u1',
    new Date('2026-07-27T18:00:00.000Z'),
    'workspace-a',
  );

  assert.equal(count, 2);
  assert.deepEqual(countWhere.config, {
    path: ['workspaceId'],
    equals: 'workspace-a',
  });
  assert.equal(countWhere.publishedAt.gte.toISOString(), '2026-07-27T00:00:00.000Z');
});

test('worker fails closed when a post carries invalid company scope metadata', async () => {
  const prisma = makePrisma({
    policy: { enabled: true, mode: 'auto' },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-invalid-scope',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, workspaceId: ' ' },
    },
  });

  assert.equal(result.action, 'skipped_invalid_scope');
  assert.equal(prisma.policyKeys.length, 0);
});

test('worker publishes approved connected targets and persists per-platform results', async () => {
  let mediaPreparationCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'auto',
      dailyLimit: 3,
      platforms: { facebook: true, linkedin: false, x: false },
    },
    connections: {
      facebook: { accessToken: 'sealed', accountId: 'page-1' },
    },
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-1',
      userId: 'u1',
      status: 'scheduled',
      prompt: 'Hola',
      caption: 'Hola Facebook',
      platforms: ['facebook'],
      scheduledAt: new Date(),
      config: { approved: true, workspaceId: 'workspace-a' },
    },
    env: {
      SOCIAL_FACEBOOK_CLIENT_ID: 'client',
      SOCIAL_FACEBOOK_CLIENT_SECRET: 'secret',
    },
    vault: {
      openProviderTokens: () => ({ accessToken: 'page-token', expiresAt: Date.now() + 60_000 }),
    },
    mediaPreparer: async () => {
      mediaPreparationCalls += 1;
      return {
        media: {
          buffer: Buffer.from('one-generated-image'),
          mime: 'image/jpeg',
          generated: true,
        },
        metadata: {
          status: 'generated',
          provider: 'openai',
          model: 'gpt-image-2',
          bytes: 19,
        },
      };
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: 'external-1' }), { status: 200 }),
  });
  assert.equal(result.action, 'published');
  assert.equal(mediaPreparationCalls, 1);
  assert.equal(prisma.updates.at(-1).status, 'published');
  assert.equal(prisma.updates.at(-1).config.publicationResults.facebook.status, 'published');
  assert.equal(prisma.updates.at(-1).config.mediaGeneration.status, 'generated');
});

test('worker does not spend image generation when no target account is connected', async () => {
  let mediaPreparationCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'auto',
      dailyLimit: 3,
      platforms: { facebook: true, linkedin: false, x: false },
    },
    connections: {},
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-no-connection',
      userId: 'u1',
      status: 'scheduled',
      caption: 'Contenido pendiente',
      platforms: ['facebook'],
      scheduledAt: new Date(),
      config: {
        approved: true,
        workspaceId: 'workspace-a',
        generateImage: true,
        mediaBrief: 'Imagen editorial profesional.',
      },
    },
    mediaPreparer: async () => {
      mediaPreparationCalls += 1;
      throw new Error('must not generate');
    },
  });

  assert.equal(result.action, 'failed');
  assert.equal(mediaPreparationCalls, 0);
  assert.equal(
    prisma.updates.at(-1).config.mediaGeneration.status,
    'not_needed',
  );
});

test('worker revalidates a Marketing assignment immediately before the provider call', async () => {
  let projectReads = 0;
  let providerCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'auto',
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  prisma.codexProject.findFirst = async ({ where }) => {
    projectReads += 1;
    return {
      id: where.id,
      userId: where.userId,
      brief: {
        companyResources: {
          assignments: projectReads === 1
            ? { [socialKey('linkedin', { accountId: 'company-page' })]: 'marketing' }
            : {},
          pinned: [],
        },
      },
      companyLink: {
        project: { id: 'company-1', userId: where.userId, deletedAt: null },
      },
    };
  };

  const result = await processPost({
    prisma,
    post: {
      id: 'post-revoked',
      userId: 'u1',
      status: 'scheduled',
      caption: 'No debe salir',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, workspaceId: 'workspace-a' },
    },
    mediaPreparer: async () => ({ media: null, metadata: { status: 'not_needed' } }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(result.action, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(
    prisma.updates.at(-1).config.publicationResults.linkedin.code,
    'SOCIAL_RESOURCE_REVOKED',
  );
});

test('worker honors a publishing kill switch changed during media preparation', async () => {
  let policyReads = 0;
  let providerCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'auto',
      autopilot: true,
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  prisma.systemSettings.findUnique = async () => {
    policyReads += 1;
    return {
      value: JSON.stringify({
        enabled: policyReads === 1,
        mode: 'auto',
        autopilot: true,
        dailyLimit: 3,
        platforms: { facebook: false, linkedin: true, x: false },
        workspaceId: 'workspace-a',
      }),
    };
  };
  const result = await processPost({
    prisma,
    post: {
      id: 'post-kill-switch',
      userId: 'u1',
      status: 'scheduled',
      caption: 'No debe salir',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: {
        approved: true,
        source: 'ceo_autopilot',
        workspaceId: 'workspace-a',
      },
    },
    mediaPreparer: async () => ({ media: null, metadata: { status: 'not_needed' } }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(result.action, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(
    prisma.updates.at(-1).config.publicationResults.linkedin.code,
    'SOCIAL_PUBLISHING_PAUSED',
  );
});

test('worker cancellation during media preparation prevents every provider effect', async () => {
  let providerCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'review',
      autopilot: false,
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  const result = await processPost({
    prisma,
    post: {
      id: 'post-cancelled-during-media',
      userId: 'u1',
      status: 'scheduled',
      caption: 'No debe salir',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: {
        approved: true,
        source: 'ceo_office',
        workspaceId: 'workspace-a',
      },
    },
    mediaPreparer: async () => {
      prisma.setScheduledStatus('cancelled');
      return { media: null, metadata: { status: 'not_needed' } };
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(result.action, 'cancelled');
  assert.equal(providerCalls, 0);
  assert.equal(prisma.getScheduledStatus(), 'cancelled');
  assert.equal(
    prisma.updates.some((update) => ['failed', 'published'].includes(update.status)),
    false,
  );
});

test('worker revokes autonomous approval when mode or autopilot changes during preparation', async () => {
  let policyReads = 0;
  const prisma = makePrisma({
    policy: {},
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  prisma.systemSettings.findUnique = async () => {
    policyReads += 1;
    return {
      value: JSON.stringify({
        enabled: true,
        mode: policyReads === 1 ? 'auto' : 'review',
        autopilot: policyReads === 1,
        dailyLimit: 3,
        platforms: { facebook: false, linkedin: true, x: false },
        workspaceId: 'workspace-a',
      }),
    };
  };
  const result = await processPost({
    prisma,
    post: {
      id: 'post-auto-revoked',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: {
        approved: true,
        source: 'proactive_marketing',
        workspaceId: 'workspace-a',
      },
    },
    mediaPreparer: async () => ({ media: null, metadata: { status: 'not_needed' } }),
  });
  assert.equal(result.action, 'failed');
  assert.equal(
    prisma.updates.at(-1).config.publicationResults.linkedin.code,
    'SOCIAL_AUTOPILOT_REVOKED',
  );
});

test('worker re-reads the connection immediately before the provider call', async () => {
  let authorizationReads = 0;
  let providerCalls = 0;
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'review',
      autopilot: false,
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  const connected = socialConnection('linkedin', {
    accessToken: 'sealed',
    accountId: 'company-page',
  });
  prisma.socialConnection.findUnique = async () => connected;
  prisma.socialConnection.findMany = async () => {
    authorizationReads += 1;
    return authorizationReads === 1 ? [connected] : [];
  };
  const result = await processPost({
    prisma,
    post: {
      id: 'post-connection-revoked',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, source: 'ceo_office', workspaceId: 'workspace-a' },
    },
    mediaPreparer: async () => ({ media: null, metadata: { status: 'not_needed' } }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(result.action, 'failed');
  assert.equal(authorizationReads, 2);
  assert.equal(providerCalls, 0);
  assert.equal(
    prisma.updates.at(-1).config.publicationResults.linkedin.code,
    'SOCIAL_RESOURCE_REVOKED',
  );
});

test('worker revokes a queued grant when OAuth reconnects the platform to another account', async () => {
  let authorizationReads = 0;
  let providerCalls = 0;
  const oldConnection = socialConnection('linkedin', {
    accessToken: 'old-token',
    accountId: 'company-page',
  });
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'review',
      autopilot: false,
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: oldConnection,
    },
  });
  prisma.socialConnection.findUnique = async () => oldConnection;
  prisma.socialConnection.findMany = async () => {
    authorizationReads += 1;
    return authorizationReads === 1
      ? [oldConnection]
      : [{ ...oldConnection, accountId: 'different-company-page', accessToken: 'new-token' }];
  };

  const result = await processPost({
    prisma,
    post: {
      id: 'post-account-changed',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, source: 'ceo_office', workspaceId: 'workspace-a' },
    },
    mediaPreparer: async () => ({ media: null, metadata: { status: 'not_needed' } }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(result.action, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(
    prisma.updates.at(-1).config.publicationResults.linkedin.code,
    'SOCIAL_RESOURCE_REVOKED',
  );
});

test('worker fails a claimed post when the linked Company Project is in trash', async () => {
  const prisma = makePrisma({
    policy: {
      enabled: true,
      mode: 'auto',
      dailyLimit: 3,
      platforms: { facebook: false, linkedin: true, x: false },
    },
    connections: {
      linkedin: { accessToken: 'sealed', accountId: 'company-page' },
    },
  });
  prisma.codexProject.findFirst = async ({ where }) => ({
    id: where.id,
    userId: where.userId,
    brief: {
      companyResources: {
        assignments: { [socialKey('linkedin', { accountId: 'company-page' })]: 'marketing' },
        pinned: [],
      },
    },
    companyLink: {
      project: { id: 'company-1', userId: where.userId, deletedAt: new Date() },
    },
  });

  const result = await processPost({
    prisma,
    post: {
      id: 'post-deleted-company',
      userId: 'u1',
      status: 'scheduled',
      platforms: ['linkedin'],
      scheduledAt: new Date(),
      config: { approved: true, workspaceId: 'workspace-a' },
    },
  });
  assert.equal(result.action, 'failed');
  assert.equal(result.code, 'SOCIAL_COMPANY_INACTIVE');
  assert.equal(prisma.updates.at(-1).status, 'failed');
});

test('daily limit claim serializes published and in-flight reservations per company', async () => {
  let reservations = 0;
  let claims = 0;
  const lockQueries = [];
  const tx = {
    $queryRawUnsafe: async (sql, ...params) => {
      lockQueries.push({ sql, params });
      return [{ locked: 1 }];
    },
    scheduledPost: {
      count: async ({ where }) => {
        assert.equal(where.config.equals, 'workspace-a');
        assert.deepEqual(where.OR.map((row) => row.status), ['published', 'publishing']);
        return reservations;
      },
      updateMany: async () => {
        claims += 1;
        reservations += 1;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $queryRawUnsafe: async () => [],
    $transaction: async (callback) => callback(tx),
  };
  const first = await claimWithinDailyLimit({
    prisma,
    post: {
      id: 'post-limit-1',
      userId: 'u1',
      status: 'scheduled',
      scheduledAt: new Date(),
    },
    scope: 'workspace-a',
    dailyLimit: 1,
  });
  const second = await claimWithinDailyLimit({
    prisma,
    post: {
      id: 'post-limit-2',
      userId: 'u1',
      status: 'scheduled',
      scheduledAt: new Date(),
    },
    scope: 'workspace-a',
    dailyLimit: 1,
  });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'daily_limit');
  assert.equal(claims, 1);
  assert.equal(lockQueries.length, 2);
  assert.match(lockQueries[0].sql, /pg_advisory_xact_lock/);
});

test('worker marks stale publishing claims for review instead of blindly duplicating external posts', async () => {
  let request = null;
  const prisma = {
    scheduledPost: {
      updateMany: async (input) => {
        request = input;
        return { count: 2 };
      },
    },
  };
  const recovered = await recoverStalePublishing(
    prisma,
    new Date('2026-07-23T18:00:00.000Z'),
  );
  assert.equal(recovered, 2);
  assert.equal(request.where.status, 'publishing');
  assert.equal(request.where.updatedAt.lt.toISOString(), '2026-07-23T17:50:00.000Z');
  assert.equal(request.data.status, 'failed');
  assert.match(request.data.lastError, /avoid duplicate external posts/i);
});

test('worker run invokes CEO autopilot with the injected LLM dependency', async () => {
  let generatedPost = null;
  let llmCalls = 0;
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => ({
        id: where.id,
        userId: where.userId,
        brief: {
          companyResources: {
            assignments: { [socialKey('linkedin')]: 'marketing' },
            pinned: [],
          },
        },
        companyLink: {
          project: { id: 'company-1', userId: where.userId, deletedAt: null },
        },
      }),
    },
    systemSettings: {
      findMany: async () => [{
        key: 'social_company_policy:u1',
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'Publicar avances verificables del producto',
          platforms: { facebook: false, linkedin: true, x: false },
          workspaceId: 'workspace-a',
        }),
      }],
    },
    scheduledPost: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async ({ data }) => {
        generatedPost = { id: 'auto-1', ...data };
        return generatedPost;
      },
      findMany: async () => [],
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin')],
    },
  };
  const result = await runOnce({
    prisma,
    chatComplete: async () => {
      llmCalls += 1;
      return {
        content: JSON.stringify({
          caption: 'Un avance verificable del producto.',
          mediaBrief: 'Equipo revisando resultados.',
        }),
      };
    },
  });
  assert.equal(result.recoveredStale, 0);
  assert.equal(result.generated[0].action, 'generated');
  assert.equal(generatedPost.config.source, 'ceo_autopilot');
  assert.equal(generatedPost.config.workspaceId, 'workspace-a');
  assert.equal(generatedPost.config.generateImage, true);
  assert.equal(generatedPost.config.mediaMode, 'generated');
  assert.equal(llmCalls, 1);
});
