'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { listManifestModels } = require('../src/services/model-catalog-manifest');
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
];

test('static manifest includes every image model surfaced by the chat picker', () => {
  const imageModels = listManifestModels({ type: 'IMAGE' });
  const names = imageModels.map(model => model.name).sort();

  assert.deepStrictEqual(names, [...EXPECTED_IMAGE_MODELS].sort());
  assert.ok(imageModels.every(model => model.type === 'IMAGE'));
});

test('static image catalog updates metadata but preserves existing activation state', async () => {
  const operations = [];
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
          assert.strictEqual(args.data.isActive, false);
          existing.add(args.data.name);
          return args;
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
});
