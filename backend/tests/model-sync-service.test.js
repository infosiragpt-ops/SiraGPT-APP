const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelSyncService } = require('../src/services/model-sync-service');

test('model sync repairs provider-synced rows that were auto-created as active', () => {
  const service = new ModelSyncService();
  const createdAt = new Date('2026-05-25T22:51:00.000Z');

  assert.equal(service.shouldRepairAutoActivatedSyncedModel({
    isActive: true,
    syncSource: 'api',
    createdAt,
    lastSynced: new Date('2026-05-25T22:52:30.000Z'),
  }), true);
});

test('model sync does not deactivate manual or intentionally managed active rows', () => {
  const service = new ModelSyncService();

  assert.equal(service.shouldRepairAutoActivatedSyncedModel({
    isActive: true,
    syncSource: 'manual',
    createdAt: new Date('2026-05-25T22:51:00.000Z'),
    lastSynced: new Date('2026-05-25T22:52:30.000Z'),
  }), false);

  assert.equal(service.shouldRepairAutoActivatedSyncedModel({
    isActive: true,
    syncSource: 'api',
    createdAt: new Date('2026-05-20T22:51:00.000Z'),
    lastSynced: new Date('2026-05-25T22:52:30.000Z'),
  }), false);
});
