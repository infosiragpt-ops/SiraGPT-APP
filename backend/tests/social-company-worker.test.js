'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  processPost,
  recoverStalePublishing,
  runOnce,
} = require('../src/services/social-company/worker');

function makePrisma({ policy, connections }) {
  const updates = [];
  return {
    updates,
    systemSettings: {
      findUnique: async () => ({ value: JSON.stringify(policy) }),
    },
    scheduledPost: {
      count: async () => 0,
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }) => {
        updates.push(data);
        return { id: 'post-1', ...data };
      },
    },
    socialConnection: {
      findUnique: async ({ where }) => connections[where.userId_platform.platform] || null,
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
      config: { approved: false },
    },
  });
  assert.equal(result.action, 'skipped_review');
  assert.equal(prisma.updates.length, 0);
});

test('worker publishes approved connected targets and persists per-platform results', async () => {
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
      config: { approved: true },
    },
    env: {
      SOCIAL_FACEBOOK_CLIENT_ID: 'client',
      SOCIAL_FACEBOOK_CLIENT_SECRET: 'secret',
    },
    vault: {
      openProviderTokens: () => ({ accessToken: 'page-token', expiresAt: Date.now() + 60_000 }),
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: 'external-1' }), { status: 200 }),
  });
  assert.equal(result.action, 'published');
  assert.equal(prisma.updates.at(-1).status, 'published');
  assert.equal(prisma.updates.at(-1).config.publicationResults.facebook.status, 'published');
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
    systemSettings: {
      findMany: async () => [{
        key: 'social_company_policy:u1',
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'Publicar avances verificables del producto',
          platforms: { facebook: false, linkedin: true, x: false },
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
      findMany: async () => [{ platform: 'linkedin' }],
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
  assert.equal(llmCalls, 1);
});
