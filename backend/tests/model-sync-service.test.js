const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelSyncService } = require('../src/services/model-sync-service');

test('model sync update payload preserves existing admin activation', () => {
  const service = new ModelSyncService();
  const payload = service.buildModelSyncUpdateData({
    name: 'openai/gpt-4.1',
    displayName: 'GPT 4.1',
    description: 'Synced provider model',
    provider: 'OpenAI',
    type: 'TEXT',
    contextLength: 128000,
    pricing: { input: 2, output: 8 },
    isActive: true,
  });

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'isActive'), false);
  assert.equal(payload.syncSource, 'api');
  assert.ok(payload.lastSynced instanceof Date);
  assert.ok(payload.updatedAt instanceof Date);
});

test('default inactive guard disables existing models once and preserves later manual activation', async () => {
  const calls = [];
  let marker = null;
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        updateMany: async (payload) => {
          calls.push(['updateMany', payload]);
          return { count: 378 };
        },
      },
      systemSettings: {
        findUnique: async (payload) => {
          calls.push(['findUnique', payload]);
          return marker;
        },
        upsert: async (payload) => {
          calls.push(['upsert', payload]);
          marker = { id: payload.create.id || 'marker' };
          return marker;
        },
      },
    },
  });

  const first = await service.ensureDefaultInactiveOnce();
  const second = await service.ensureDefaultInactiveOnce();

  assert.deepEqual(first, {
    applied: true,
    count: 378,
    reason: 'default_inactive_enforced',
  });
  assert.deepEqual(second, {
    applied: false,
    count: 0,
    reason: 'already_applied',
  });
  assert.equal(calls.filter(([name]) => name === 'updateMany').length, 1);
  assert.deepEqual(calls.find(([name]) => name === 'updateMany')[1], {
    where: { isActive: true },
    data: { isActive: false },
  });
});

test('persistModels batches DB work: one findMany, createMany for new, parallel updates', async () => {
  const calls = [];
  const existingNames = new Set(['existing-model']);
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        findMany: async (payload) => {
          calls.push(['findMany', payload]);
          const wanted = payload?.where?.name?.in || [];
          return wanted.filter((n) => existingNames.has(n)).map((name) => ({ name }));
        },
        createMany: async (payload) => {
          calls.push(['createMany', payload]);
          return { count: payload.data.length };
        },
        update: async (payload) => {
          calls.push(['update', payload]);
          return { name: payload.where.name };
        },
        // Must NOT be used by the batched path:
        findUnique: async () => { calls.push(['findUnique']); return null; },
        create: async () => { calls.push(['create']); return {}; },
      },
    },
  });

  const result = await service.persistModels([
    { name: 'new-1', provider: 'Cerebras', type: 'TEXT', isActive: false },
    { name: 'new-2', provider: 'Z.ai', type: 'TEXT' },
    { name: 'existing-model', provider: 'OpenAI', type: 'TEXT' },
    { name: 'new-1', provider: 'Cerebras', type: 'TEXT' }, // duplicate → deduped
  ]);

  assert.equal(result.created, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.errors, 0);

  // Batched: exactly ONE findMany, zero per-model findUnique/create.
  assert.equal(calls.filter(([n]) => n === 'findMany').length, 1);
  assert.equal(calls.filter(([n]) => n === 'findUnique').length, 0);
  assert.equal(calls.filter(([n]) => n === 'create').length, 0);

  const createMany = calls.find(([n]) => n === 'createMany');
  assert.ok(createMany, 'used createMany for new rows');
  assert.equal(createMany[1].data.length, 2);
  assert.equal(createMany[1].skipDuplicates, true);
  // Discovered rows stay inactive unless explicitly true.
  assert.equal(createMany[1].data.every((d) => d.isActive === false), true);
  // One update for the single existing row.
  assert.equal(calls.filter(([n]) => n === 'update').length, 1);
});

test('persistModels skips unchanged rows — no UPDATE when nothing changed', async () => {
  const calls = [];
  let storedRows = [];
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        findMany: async () => { calls.push(['findMany']); return storedRows; },
        createMany: async () => { calls.push(['createMany']); return { count: 0 }; },
        update: async (p) => { calls.push(['update', p]); return {}; },
      },
    },
  });

  const model = {
    name: 'glm-4.6', displayName: 'GLM 4.6', description: 'd', provider: 'Z.ai',
    type: 'TEXT', contextLength: 128000, pricing: { in: 1, out: 2 }, tags: ['chat'],
  };
  // Build the stored row from the service's OWN derived values so the only
  // difference is pricing key order (which stableStringify must treat as equal).
  storedRows = [{
    name: model.name, displayName: model.displayName, description: model.description,
    provider: model.provider, type: model.type, contextLength: model.contextLength,
    pricing: { out: 2, in: 1 },
    tags: model.tags && model.tags.length ? model.tags : service.generateTags(model),
    icon: service.getModelIcon(model),
  }];

  const result = await service.persistModels([model]);
  assert.equal(result.updated, 0, 'unchanged model must not be updated');
  assert.equal(result.skipped, 1);
  assert.equal(calls.filter(([n]) => n === 'update').length, 0);
  assert.equal(calls.filter(([n]) => n === 'createMany').length, 0);

  // Now change a field → it must update.
  calls.length = 0;
  const changed = { ...model, displayName: 'GLM 4.6 Turbo' };
  const r2 = await service.persistModels([changed]);
  assert.equal(r2.updated, 1);
  assert.equal(r2.skipped, 0);
  assert.equal(calls.filter(([n]) => n === 'update').length, 1);
});
