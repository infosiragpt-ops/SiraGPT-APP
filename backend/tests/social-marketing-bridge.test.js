'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLedgerContext,
  contentHashFor,
  marketingBatchId,
  normalizeLedgerEntries,
  runMarketingCycle,
} = require('../src/services/social-company/marketing-bridge');
const { policyKey } = require('../src/services/social-company/policy');

const NOW = new Date('2026-07-29T15:00:00.000Z');
const PROJECT = { id: 'proj-1', userId: 'user-1', name: 'Acme OS' };

function reviewPolicy(overrides = {}) {
  return {
    enabled: true,
    mode: 'review',
    autopilot: true,
    objective: 'Contar en público lo que la empresa construye cada semana',
    dailyLimit: 3,
    platforms: { facebook: false, linkedin: true, x: false },
    workspaceId: PROJECT.id,
    updatedAt: null,
    ...overrides,
  };
}

function createFakePrisma({ posts = [], settings = {} } = {}) {
  const state = { posts: [...posts], creates: [] };
  const matches = (post, where = {}) => {
    if (where.userId !== undefined && post.userId !== where.userId) return false;
    if (where.batchId !== undefined && post.batchId !== where.batchId) return false;
    if (where.createdAt) {
      const at = new Date(post.createdAt).getTime();
      if (where.createdAt.gte && at < new Date(where.createdAt.gte).getTime()) return false;
      if (where.createdAt.lt && at >= new Date(where.createdAt.lt).getTime()) return false;
    }
    return true;
  };
  const prisma = {
    systemSettings: {
      findUnique: async ({ where }) => settings[where.key] || null,
      upsert: async () => null,
    },
    scheduledPost: {
      count: async ({ where }) => state.posts.filter((post) => matches(post, where)).length,
      findFirst: async ({ where }) => state.posts.find((post) => matches(post, where)) || null,
      create: async ({ data }) => {
        const row = { id: `post-${state.posts.length + 1}`, createdAt: NOW, ...data };
        state.posts.push(row);
        state.creates.push(row);
        return row;
      },
    },
  };
  return { prisma, state };
}

test('drafts an unapproved review post whose content carries the ledger context', async () => {
  const { prisma, state } = createFakePrisma({
    settings: {
      [policyKey(PROJECT.userId, PROJECT.id)]: {
        key: policyKey(PROJECT.userId, PROJECT.id),
        value: JSON.stringify(reviewPolicy()),
      },
    },
  });
  const generateCalls = [];
  const result = await runMarketingCycle({
    project: PROJECT,
    ledgerEntries: [
      { title: 'Refactor del onboarding', outcome: 'shipped', learnings: 'Menos fricción en el registro' },
      { title: 'Panel de métricas en vivo', outcome: 'shipped' },
    ],
    deps: {
      prisma,
      now: () => NOW,
      generateContent: async (args) => {
        generateCalls.push(args);
        return {
          caption: `Semana de resultados reales. ${args.ledgerContext}`,
          mediaBrief: 'Equipo revisando el nuevo panel de métricas.',
        };
      },
    },
  });

  assert.equal(result.action, 'drafted');
  assert.equal(result.status, 'draft');
  assert.equal(result.postId, 'post-1');
  assert.deepEqual(result.platforms, ['linkedin']);
  assert.match(result.batchId, /^marketing-bridge:2026-07-29:[0-9a-f]{32}$/);

  // The generator received the real-work context, and it landed in the caption.
  assert.equal(generateCalls.length, 1);
  assert.match(generateCalls[0].ledgerContext, /Esta semana la empresa construyó:/);
  assert.match(generateCalls[0].ledgerContext, /Refactor del onboarding/);
  assert.deepEqual(generateCalls[0].ledger[0], {
    task: 'Refactor del onboarding',
    outcome: 'shipped',
    learnings: 'Menos fricción en el registro',
  });

  assert.equal(state.creates.length, 1);
  const row = state.creates[0];
  assert.equal(row.status, 'draft');
  assert.equal(row.scheduledAt, null);
  assert.equal(row.config.approved, false);
  assert.equal(row.config.source, 'marketing_bridge');
  assert.equal(row.config.projectId, PROJECT.id);
  assert.match(row.caption, /Refactor del onboarding/);
  assert.match(row.caption, /Panel de métricas en vivo/);
  assert.match(row.config.ledgerContext, /Menos fricción en el registro/);
  assert.equal(row.config.contentHash, contentHashFor({
    projectId: PROJECT.id,
    caption: row.caption,
    day: '2026-07-29',
  }));
});

test('auto mode enqueues an approved scheduled post but never publishes directly', async () => {
  const { prisma, state } = createFakePrisma();
  const result = await runMarketingCycle({
    project: PROJECT,
    ledgerEntries: [{ title: 'Integración de pagos', outcome: 'shipped' }],
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({ mode: 'auto' }),
      generateContent: async () => ({ caption: 'Nueva integración de pagos en producción.', mediaBrief: '' }),
    },
  });
  assert.equal(result.action, 'drafted');
  assert.equal(result.status, 'scheduled');
  assert.equal(state.creates.length, 1);
  // Enqueued for the existing publisher — not published by the bridge.
  assert.equal(state.creates[0].status, 'scheduled');
  assert.equal(state.creates[0].config.approved, true);
  assert.notEqual(state.creates[0].status, 'published');
  assert.equal(state.creates[0].publishedAt, undefined);
});

test('respects the policy dailyLimit counting the posts already created today', async () => {
  const todayPost = (id, hour) => ({
    id,
    userId: PROJECT.userId,
    batchId: `other:${id}`,
    createdAt: new Date(`2026-07-29T0${hour}:00:00.000Z`),
  });
  const { prisma, state } = createFakePrisma({
    posts: [todayPost('p1', 1), todayPost('p2', 2)],
  });
  let generateCalls = 0;
  const result = await runMarketingCycle({
    project: PROJECT,
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({ dailyLimit: 2 }),
      generateContent: async () => {
        generateCalls += 1;
        return { caption: 'no debería generarse' };
      },
    },
  });
  assert.equal(result.action, 'skipped_budget');
  assert.equal(result.postedToday, 2);
  assert.equal(result.dailyLimit, 2);
  assert.equal(generateCalls, 0);
  assert.equal(state.creates.length, 0);
});

test('posts from a previous day do not consume today\'s budget', async () => {
  const { prisma, state } = createFakePrisma({
    posts: [
      { id: 'old-1', userId: PROJECT.userId, batchId: 'other:old-1', createdAt: new Date('2026-07-28T23:00:00.000Z') },
      { id: 'old-2', userId: PROJECT.userId, batchId: 'other:old-2', createdAt: new Date('2026-07-28T22:00:00.000Z') },
    ],
  });
  const result = await runMarketingCycle({
    project: PROJECT,
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({ dailyLimit: 2 }),
      generateContent: async () => ({ caption: 'Contenido nuevo del día.' }),
    },
  });
  assert.equal(result.action, 'drafted');
  assert.equal(state.creates.length, 1);
});

test('same content for the same project and day is skipped as duplicate', async () => {
  const { prisma, state } = createFakePrisma();
  const deps = {
    prisma,
    now: () => NOW,
    readPolicy: async () => reviewPolicy(),
    generateContent: async () => ({ caption: 'Misma pieza de contenido.' }),
  };
  const first = await runMarketingCycle({ project: PROJECT, deps });
  assert.equal(first.action, 'drafted');

  const second = await runMarketingCycle({ project: PROJECT, deps });
  assert.equal(second.action, 'skipped_duplicate');
  assert.equal(second.postId, first.postId);
  assert.equal(second.batchId, first.batchId);
  assert.equal(state.creates.length, 1);
});

test('different content on the same day drafts a second post (hash covers content)', async () => {
  const { prisma, state } = createFakePrisma();
  const captions = ['Primera pieza del día.', 'Segunda pieza distinta.'];
  let call = 0;
  const deps = {
    prisma,
    now: () => NOW,
    readPolicy: async () => reviewPolicy(),
    generateContent: async () => ({ caption: captions[call++] }),
  };
  const first = await runMarketingCycle({ project: PROJECT, deps });
  const second = await runMarketingCycle({ project: PROJECT, deps });
  assert.equal(first.action, 'drafted');
  assert.equal(second.action, 'drafted');
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(state.creates.length, 2);
});

test('paused policy skips without generating or writing anything', async () => {
  const { prisma, state } = createFakePrisma();
  let generateCalls = 0;
  const result = await runMarketingCycle({
    project: PROJECT,
    ledgerEntries: [{ title: 'Trabajo real', outcome: 'shipped' }],
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({ enabled: false }),
      generateContent: async () => {
        generateCalls += 1;
        return { caption: 'no' };
      },
    },
  });
  assert.equal(result.action, 'skipped_policy');
  assert.equal(result.reason, 'disabled');
  assert.equal(generateCalls, 0);
  assert.equal(state.creates.length, 0);
});

test('policy without objective or without platforms also skips under policy', async () => {
  const { prisma } = createFakePrisma();
  const noObjective = await runMarketingCycle({
    project: PROJECT,
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({ objective: '' }),
      generateContent: async () => ({ caption: 'no' }),
    },
  });
  assert.equal(noObjective.action, 'skipped_policy');
  assert.equal(noObjective.reason, 'objective_missing');

  const noPlatforms = await runMarketingCycle({
    project: PROJECT,
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy({
        platforms: { facebook: false, linkedin: false, x: false },
      }),
      generateContent: async () => ({ caption: 'no' }),
    },
  });
  assert.equal(noPlatforms.action, 'skipped_policy');
  assert.equal(noPlatforms.reason, 'no_platforms');
});

test('invalid project or invalid generated content never creates rows', async () => {
  const { prisma, state } = createFakePrisma();
  const invalidProject = await runMarketingCycle({
    project: { id: '', userId: '' },
    deps: { prisma, now: () => NOW },
  });
  assert.equal(invalidProject.action, 'skipped_invalid_project');

  const invalidContent = await runMarketingCycle({
    project: PROJECT,
    deps: {
      prisma,
      now: () => NOW,
      readPolicy: async () => reviewPolicy(),
      generateContent: async () => null,
    },
  });
  assert.equal(invalidContent.action, 'skipped_invalid_content');
  assert.equal(state.creates.length, 0);
});

test('helpers: ledger normalization, context builder and deterministic hash', () => {
  const entries = normalizeLedgerEntries([
    null,
    'not-an-object',
    { title: '  Recorte  ', outcome: 'shipped', learnings: '' },
    { title: '', outcome: '', learnings: '' },
    ...Array.from({ length: 8 }, (_, i) => ({ title: `Item ${i}`, outcome: 'ok' })),
  ]);
  assert.equal(entries.length, 6);
  assert.equal(entries[entries.length - 1].title, 'Item 7');

  assert.equal(buildLedgerContext([]), '');
  const context = buildLedgerContext([{ title: 'Recorte', outcome: 'shipped', learnings: 'menos código' }]);
  assert.match(context, /Esta semana la empresa construyó:/);
  assert.match(context, /- Recorte · resultado: shipped · aprendizaje: menos código/);

  const hash = contentHashFor({ projectId: 'p', caption: 'c', day: '2026-07-29' });
  assert.equal(hash, contentHashFor({ projectId: 'p', caption: 'c', day: '2026-07-29' }));
  assert.notEqual(hash, contentHashFor({ projectId: 'p', caption: 'c', day: '2026-07-30' }));
  assert.notEqual(hash, contentHashFor({ projectId: 'p2', caption: 'c', day: '2026-07-29' }));
  assert.equal(marketingBatchId({ day: '2026-07-29', hash }), `marketing-bridge:2026-07-29:${hash.slice(0, 32)}`);
});
