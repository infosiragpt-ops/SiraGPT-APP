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
