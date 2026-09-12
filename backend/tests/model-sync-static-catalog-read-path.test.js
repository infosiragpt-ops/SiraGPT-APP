'use strict';

/**
 * Read-path behaviour of the static-catalog sync in model-sync-service.js:
 *   - `ensureStaticCatalogModelsCached` skips the pass while every requested
 *     type was ensured inside the TTL, and only writes rows whose metadata
 *     drifted from the manifest (`skipUnchanged`).
 *   - `fetchFalVideoModels` serves a stale fal.ai catalog immediately and
 *     refreshes in the background instead of blocking the picker.
 * The forced `ensureStaticCatalogModels` (admin sync) keeps its historical
 * "refresh every row" contract — covered by model-admin-*-catalog.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelSyncService } = require('../src/services/model-sync-service');
const { listManifestModels } = require('../src/services/model-catalog-manifest');

function manifestRowsFor(service, type) {
  // Rows that ALREADY match the manifest byte for byte (what a steady-state DB
  // looks like after one full pass).
  return listManifestModels({ type }).map((model) => ({
    name: model.name,
    displayName: model.displayName,
    description: model.description === undefined ? null : model.description,
    provider: model.provider,
    type: model.type,
    icon: service.getModelIcon(model),
    syncSource: model.syncSource || 'static_manifest',
    contextLength: model.contextLength === undefined ? null : model.contextLength,
    pricing: model.pricing === undefined ? null : model.pricing,
    tags: model.tags && model.tags.length ? model.tags : service.generateTags(model),
  }));
}

function serviceWithRows(rows, operations) {
  return new ModelSyncService({
    prismaClient: {
      aiModel: {
        async findMany(args) {
          operations.push({ op: 'findMany', args });
          return rows.map((row) => ({ ...row }));
        },
        async update(args) { operations.push({ op: 'update', args }); return args; },
        async create(args) { operations.push({ op: 'create', args }); return args; },
        async updateMany(args) { operations.push({ op: 'updateMany', args }); return { count: 0 }; },
      },
    },
  });
}

test('cached pass: unchanged manifest rows are not rewritten, drifted rows are', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  const rows = manifestRowsFor(service, 'MUSIC');
  assert.ok(rows.length >= 2, 'fixture needs at least two MUSIC manifest rows');
  // Drift one row: an admin/legacy sync left an old displayName behind.
  rows[0] = { ...rows[0], displayName: `${rows[0].displayName} (old)` };
  service.prisma.aiModel.findMany = async (args) => { operations.push({ op: 'findMany', args }); return rows.map((r) => ({ ...r })); };

  const result = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'] });

  assert.equal(result.skipped, undefined);
  assert.equal(result.count, rows.length);
  assert.equal(result.updated, 1, 'only the drifted row is written');
  assert.equal(result.unchanged, rows.length - 1);
  assert.equal(result.created, 0);
  const updates = operations.filter((o) => o.op === 'update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.where.name, rows[0].name);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].args.data, 'isActive'), false, 'never touches activation');
  // The read-path select asks for the compared columns (not just the name).
  const findMany = operations.find((o) => o.op === 'findMany');
  assert.deepEqual(Object.keys(findMany.args.select).sort(), [
    'contextLength', 'description', 'displayName', 'icon', 'name', 'pricing', 'provider', 'syncSource', 'tags', 'type',
  ]);
});

test('cached pass: missing manifest rows are still created (inactive)', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  const result = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'] });
  const created = operations.filter((o) => o.op === 'create');
  assert.equal(result.created, created.length);
  assert.ok(created.length > 0);
  assert.ok(created.every((o) => o.args.data.isActive === false));
});

test('cached pass: second call inside the TTL skips the DB entirely; force re-runs', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  const rows = manifestRowsFor(service, 'MUSIC');
  service.prisma.aiModel.findMany = async (args) => { operations.push({ op: 'findMany', args }); return rows.map((r) => ({ ...r })); };

  const first = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000 });
  assert.equal(first.skipped, undefined);
  const reads = () => operations.filter((o) => o.op === 'findMany').length;
  assert.equal(reads(), 1);

  const second = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000 });
  assert.deepEqual(second, { skipped: true, created: 0, updated: 0, unchanged: 0, existing: 0, count: 0 });
  assert.equal(reads(), 1, 'memoised: no DB round-trip');

  const forced = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000, force: true });
  assert.equal(forced.skipped, undefined);
  assert.equal(reads(), 2);

  service.invalidateStaticCatalogMemo();
  await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000 });
  assert.equal(reads(), 3, 'an explicit memo reset re-runs the pass');
});

test('cached pass: a superset pass covers narrower type requests', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  service.fetchFalVideoModels = async () => [];
  await service.ensureStaticCatalogModelsCached({ types: ['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'], ttlMs: 60_000 });
  const reads = operations.filter((o) => o.op === 'findMany').length;
  const video = await service.ensureStaticCatalogModelsCached({ types: ['VIDEO'], ttlMs: 60_000 });
  const audio = await service.ensureStaticCatalogModelsCached({ types: ['AUDIO'], ttlMs: 60_000 });
  assert.equal(video.skipped, true);
  assert.equal(audio.skipped, true);
  assert.equal(operations.filter((o) => o.op === 'findMany').length, reads);
  // A type outside the stamped set still runs.
  const text = await service.ensureStaticCatalogModelsCached({ types: ['TEXT'], ttlMs: 60_000 });
  assert.equal(text.skipped, undefined);
});

test('cached pass: ttl 0 disables the memo; env default is 10 minutes', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 0 });
  await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 0 });
  assert.equal(operations.filter((o) => o.op === 'findMany').length, 2);
  assert.equal(service.getStaticCatalogEnsureTtlMs({}), 10 * 60_000);
  assert.equal(service.getStaticCatalogEnsureTtlMs({ SIRAGPT_STATIC_CATALOG_ENSURE_TTL_MS: '5000' }), 5000);
  assert.equal(service.getStaticCatalogEnsureTtlMs({ SIRAGPT_STATIC_CATALOG_ENSURE_TTL_MS: '-1' }), 0);
});

test('forced pass keeps the legacy contract: every existing row is refreshed', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  const rows = manifestRowsFor(service, 'MUSIC');
  service.prisma.aiModel.findMany = async (args) => { operations.push({ op: 'findMany', args }); return rows.map((r) => ({ ...r })); };
  const result = await service.ensureStaticCatalogModels({ types: ['MUSIC'] });
  assert.equal(result.updated, rows.length);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(operations.find((o) => o.op === 'findMany').args.select, { name: true });
});

test('memo stamps are per service instance and cleared by the forced pass too', async () => {
  const operations = [];
  const service = serviceWithRows([], operations);
  await service.ensureStaticCatalogModels({ types: ['MUSIC'] });
  // The forced pass stamps the type: the read path right after an admin sync
  // does not re-run.
  const next = await service.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000 });
  assert.equal(next.skipped, true);
  const fresh = new ModelSyncService({ prismaClient: service.prisma });
  const other = await fresh.ensureStaticCatalogModelsCached({ types: ['MUSIC'], ttlMs: 60_000 });
  assert.equal(other.skipped, undefined, 'a new process starts cold');
});

// ── fal.ai stale-while-revalidate ──────────────────────────────────────────

test('fetchFalVideoModels: expired cache is served immediately and refreshed in the background', async () => {
  const service = new ModelSyncService({ prismaClient: { aiModel: {} } });
  const stale = [{ name: 'fal-ai/stale', type: 'VIDEO' }];
  service.cache.falVideo = { data: stale, lastFetch: Date.now() - 2 * 3600000, ttl: 3600000 };
  let uncachedCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  service._fetchFalVideoModelsUncached = async ({ useCache }) => {
    uncachedCalls += 1;
    await gate;
    const fresh = [{ name: 'fal-ai/fresh', type: 'VIDEO' }];
    if (useCache) { service.cache.falVideo.data = fresh; service.cache.falVideo.lastFetch = Date.now(); }
    return fresh;
  };

  const startedAt = Date.now();
  const served = await service.fetchFalVideoModels();
  assert.ok(Date.now() - startedAt < 50, 'must not wait for the network');
  assert.equal(served, stale);
  assert.equal(uncachedCalls, 1, 'one background refresh started');
  const again = await service.fetchFalVideoModels();
  assert.equal(again, stale);
  assert.equal(uncachedCalls, 1, 'concurrent stale reads do not stack refreshes');

  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await service.fetchFalVideoModels();
  assert.equal(fresh[0].name, 'fal-ai/fresh', 'the refreshed catalog is the next answer');
  assert.equal(uncachedCalls, 1);
});

test('fetchFalVideoModels: cold cache still blocks (there is nothing to serve), blocking:true forces a wait', async () => {
  const service = new ModelSyncService({ prismaClient: { aiModel: {} } });
  let calls = 0;
  service._fetchFalVideoModelsUncached = async () => { calls += 1; return [{ name: 'fal-ai/cold' }]; };
  const cold = await service.fetchFalVideoModels();
  assert.equal(cold[0].name, 'fal-ai/cold');
  assert.equal(calls, 1);

  service.cache.falVideo = { data: [{ name: 'fal-ai/stale' }], lastFetch: 0, ttl: 3600000 };
  const forced = await service.fetchFalVideoModels({ blocking: true });
  assert.equal(forced[0].name, 'fal-ai/cold');
  assert.equal(calls, 2);
});

test('fetchFalVideoModels: a failing background refresh keeps the stale list and can retry later', async () => {
  const service = new ModelSyncService({ prismaClient: { aiModel: {} } });
  const stale = [{ name: 'fal-ai/stale' }];
  service.cache.falVideo = { data: stale, lastFetch: 0, ttl: 3600000 };
  let calls = 0;
  service._fetchFalVideoModelsUncached = async () => { calls += 1; throw new Error('fal.ai 502'); };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await service.fetchFalVideoModels(), stale);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service._falVideoRefreshFlight, null, 'flight slot is released after the failure');
    assert.equal(await service.fetchFalVideoModels(), stale);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 2, 'the next stale read retries the refresh');
  } finally {
    console.warn = originalWarn;
  }
});
