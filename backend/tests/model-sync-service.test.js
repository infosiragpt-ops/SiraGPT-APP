const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelSyncService } = require('../src/services/model-sync-service');

test('model sync update payload always disables existing admin models', () => {
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

  assert.equal(payload.isActive, false);
  assert.equal(payload.syncSource, 'api');
  assert.ok(payload.lastSynced instanceof Date);
  assert.ok(payload.updatedAt instanceof Date);
});
