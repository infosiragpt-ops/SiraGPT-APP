'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  listManifestModels,
  DEFAULT_ACTIVE_IMAGE_MODEL_NAMES,
} = require('../src/services/model-catalog-manifest');
const { ModelSyncService } = require('../src/services/model-sync-service');

const EXPECTED_IMAGE_MODELS = [
  'openai/gpt-5.4-image-2',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image-preview',
  'bytedance-seed/seedream-4.5',
  'recraftai/recraft-v3',
  'ideogram/ideogram-v2',
  'black-forest-labs/flux-1.1-pro',
  'black-forest-labs/flux-1.1-ultra',
  'dall-e-3',
  'dall-e-2',
  'imagen-4.0-generate-001',
  'fal-ai/flux/schnell',
  'fal-ai/flux/dev',
  'fal-ai/flux-pro/v1.1',
];

test('static manifest includes every image model surfaced by the chat picker', () => {
  const imageModels = listManifestModels({ type: 'IMAGE' });
  const names = imageModels.map(model => model.name).sort();

  assert.deepStrictEqual(names, [...EXPECTED_IMAGE_MODELS].sort());
  assert.ok(imageModels.every(model => model.type === 'IMAGE'));
});

test('static image catalog updates metadata but preserves activation state for non-default models', async () => {
  const operations = [];
  // seedream-4.5 is NOT in the default-active set, so updating its metadata must
  // never touch its isActive flag (admin choice preserved).
  const existing = new Set(['bytedance-seed/seedream-4.5']);
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        async findMany() {
          return [...existing].map(name => ({ name }));
        },
        async update(args) {
          operations.push({ op: 'update', args });
          assert.strictEqual(Object.prototype.hasOwnProperty.call(args.data, 'isActive'), false);
          return args;
        },
        async create(args) {
          operations.push({ op: 'create', args });
          // Curated default-active models seed ACTIVE; everything else inactive.
          assert.strictEqual(args.data.isActive, DEFAULT_ACTIVE_IMAGE_MODEL_NAMES.has(args.data.name));
          existing.add(args.data.name);
          return args;
        },
        async updateMany(args) {
          operations.push({ op: 'updateMany', args });
          return { count: 0 };
        },
      },
    },
  });

  const result = await service.ensureStaticCatalogModels({ types: ['IMAGE'] });

  assert.strictEqual(result.count, EXPECTED_IMAGE_MODELS.length);
  assert.strictEqual(result.updated, 1);
  assert.strictEqual(result.created, EXPECTED_IMAGE_MODELS.length - 1);
  assert.strictEqual(operations.filter(item => item.op === 'create').length, EXPECTED_IMAGE_MODELS.length - 1);
  assert.strictEqual(operations.filter(item => item.op === 'update').length, 1);

  // The curated default-active IMAGE models are force-activated via updateMany,
  // even pre-existing inactive rows, so they surface in the picker.
  const updateManyOps = operations.filter(item => item.op === 'updateMany');
  assert.strictEqual(updateManyOps.length, 1);
  const targeted = updateManyOps[0].args.where.name.in;
  for (const name of DEFAULT_ACTIVE_IMAGE_MODEL_NAMES) {
    if (EXPECTED_IMAGE_MODELS.includes(name)) {
      assert.ok(targeted.includes(name), `expected updateMany to target ${name}`);
    }
  }
  assert.strictEqual(updateManyOps[0].args.data.isActive, true);
});

test('concurrent create race (P2002) falls back to a metadata update', async () => {
  const operations = [];
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        async findMany() {
          // Simulate a fresh DB: nothing exists yet, so every model takes the
          // create path.
          return [];
        },
        async update(args) {
          operations.push({ op: 'update', args });
          return args;
        },
        async create(args) {
          operations.push({ op: 'create', args });
          // A competing request already created this row between findMany and
          // create — Prisma raises a unique-constraint violation.
          const err = new Error('Unique constraint failed on the fields: (`name`)');
          err.code = 'P2002';
          throw err;
        },
        async updateMany(args) {
          operations.push({ op: 'updateMany', args });
          return { count: 0 };
        },
      },
    },
  });

  const result = await service.ensureStaticCatalogModels({ types: ['IMAGE'] });

  // Every create lost the race and was recovered via update — no throw escapes.
  assert.strictEqual(result.count, EXPECTED_IMAGE_MODELS.length);
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.updated, EXPECTED_IMAGE_MODELS.length);
  assert.strictEqual(operations.filter(item => item.op === 'create').length, EXPECTED_IMAGE_MODELS.length);
  assert.strictEqual(operations.filter(item => item.op === 'update').length, EXPECTED_IMAGE_MODELS.length);
  // The P2002 fallback update must never touch isActive (preserve admin state).
  for (const op of operations.filter(item => item.op === 'update')) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(op.args.data, 'isActive'), false);
  }
});

test('non-P2002 create errors still propagate', async () => {
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        async findMany() { return []; },
        async update() { throw new Error('update should not be called'); },
        async create() {
          const err = new Error('database is on fire');
          err.code = 'P1001';
          throw err;
        },
        async updateMany() { return { count: 0 }; },
      },
    },
  });

  await assert.rejects(
    () => service.ensureStaticCatalogModels({ types: ['IMAGE'] }),
    /database is on fire/,
  );
});
