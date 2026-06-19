'use strict';

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const { listManifestModels } = require('../src/services/model-catalog-manifest');
const { ModelSyncService } = require('../src/services/model-sync-service');
const {
  buildFalVideoInputPayload,
  resolveFalVideoModelRequest,
} = require('../src/services/fal-video-model-catalog');

const EXPECTED_CORE_FAL_VIDEO_MODELS = [
  'bytedance/seedance-2.0/text-to-video',
  'fal-ai/kling-video/v3/pro/text-to-video',
  'fal-ai/veo3.1',
  'fal-ai/sora-2/text-to-video/pro',
  'fal-ai/veo3.1/fast',
  'fal-ai/kling-video/v3/standard/text-to-video',
  'fal-ai/veo3/fast',
];

test('static manifest includes the flagship fal.ai video catalog ordered by quality', () => {
  const videoModels = listManifestModels({ type: 'VIDEO' });
  const names = videoModels.map(model => model.name);

  assert.ok(videoModels.length >= 24, `expected at least 24 fal.ai video models, got ${videoModels.length}`);
  assert.deepStrictEqual(names.slice(0, EXPECTED_CORE_FAL_VIDEO_MODELS.length), EXPECTED_CORE_FAL_VIDEO_MODELS);
  assert.ok(videoModels.every(model => model.type === 'VIDEO'));
  assert.ok(videoModels.every(model => model.provider === 'fal.ai'));
  assert.ok(videoModels.every(model => model.icon), 'every video model should carry an icon/logo key');
  assert.ok(videoModels.every(model => model.tags.includes('fal.ai')));
  assert.ok(videoModels.every(model => model.pricing?.provider === 'fal.ai'));
});

test('fal.ai API video sync normalizes all paginated text/image video endpoints as active rows', async () => {
  const calls = [];
  const originalGet = axios.get;
  axios.get = async (_url, options = {}) => {
    const { category, cursor = null } = options.params || {};
    calls.push({ category, cursor });
    const fixtures = {
      'text-to-video': {
        null: {
          next_cursor: 'text-page-2',
          has_more: true,
          models: [
            {
              endpoint_id: 'bytedance/seedance-2.0/text-to-video',
              metadata: {
                display_name: 'Seedance 2.0 Text to Video API',
                category: 'text-to-video',
                description: 'Best text video model',
                status: 'active',
              },
            },
          ],
        },
        'text-page-2': {
          next_cursor: null,
          has_more: false,
          models: [
            {
              endpoint_id: 'fal-ai/kling-video/v3/pro/text-to-video',
              metadata: {
                display_name: 'Kling Video v3 Text to Video [Pro]',
                category: 'text-to-video',
                description: 'Pro model',
                status: 'active',
              },
            },
          ],
        },
      },
      'image-to-video': {
        null: {
          next_cursor: null,
          has_more: false,
          models: [
            {
              endpoint_id: 'fal-ai/kling-video/v3/pro/image-to-video',
              metadata: {
                display_name: 'Kling Video v3 Image to Video [Pro]',
                category: 'image-to-video',
                description: 'Pro image model',
                status: 'active',
              },
            },
          ],
        },
      },
    };
    return { data: fixtures[category]?.[cursor] || { next_cursor: null, has_more: false, models: [] } };
  };

  try {
    const service = new ModelSyncService({ prismaClient: { aiModel: {} } });
    const models = await service.fetchFalVideoModels();

    assert.deepStrictEqual(calls, [
      { category: 'text-to-video', cursor: null },
      { category: 'text-to-video', cursor: 'text-page-2' },
      { category: 'image-to-video', cursor: null },
    ]);
    const names = models.map(model => model.name);
    assert.deepStrictEqual(names.slice(0, 2), [
      'bytedance/seedance-2.0/text-to-video',
      'fal-ai/kling-video/v3/pro/text-to-video',
    ]);
    assert.ok(names.includes('fal-ai/kling-video/v3/pro/image-to-video'));
    assert.ok(models.every(model => model.type === 'VIDEO'));
    assert.ok(models.every(model => model.provider === 'fal.ai'));
    assert.ok(models.every(model => model.isActive === true));
    assert.ok(models.every(model => model.tags.includes('fal.ai')));
  } finally {
    axios.get = originalGet;
  }
});

test('static fal.ai video catalog creates and updates video rows as active', async () => {
  const operations = [];
  const service = new ModelSyncService({
    prismaClient: {
      aiModel: {
        async findMany() {
          return [{ name: 'fal-ai/veo3.1' }];
        },
        async update(args) {
          operations.push({ op: 'update', args });
          assert.strictEqual(args.data.isActive, true);
          return args;
        },
        async create(args) {
          operations.push({ op: 'create', args });
          assert.strictEqual(args.data.type, 'VIDEO');
          assert.strictEqual(args.data.provider, 'fal.ai');
          assert.strictEqual(args.data.isActive, true);
          return args;
        },
      },
    },
  });
  service.fetchFalVideoModels = async () => [
    { name: 'fal-ai/veo3.1', displayName: 'Veo 3.1', provider: 'fal.ai', type: 'VIDEO', description: 'Existing row', icon: 'GeminiLogo', tags: ['fal.ai', 'video'], pricing: { provider: 'fal.ai' }, isActive: true, syncSource: 'fal_ai_catalog' },
    { name: 'fal-ai/sora-2/text-to-video/pro', displayName: 'Sora 2 Pro', provider: 'fal.ai', type: 'VIDEO', description: 'New row', icon: 'SoraLogo', tags: ['fal.ai', 'video'], pricing: { provider: 'fal.ai' }, isActive: true, syncSource: 'fal_ai_catalog' },
  ];

  const result = await service.ensureStaticCatalogModels({ types: ['VIDEO'] });

  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.updated, 1);
  assert.strictEqual(result.created, 1);
  assert.deepStrictEqual(operations.map(item => item.op), ['update', 'create']);
});

test('fal.ai video payload preserves selected model and user settings', () => {
  const routing = resolveFalVideoModelRequest('bytedance/seedance-2.0/text-to-video');
  assert.strictEqual(routing.ok, true);
  assert.strictEqual(routing.endpoint, 'bytedance/seedance-2.0/text-to-video');

  const payload = buildFalVideoInputPayload({
    endpoint: routing.endpoint,
    prompt: 'Plano cinematografico minimalista de un producto premium',
    aspectRatio: '9:16',
    duration: 12,
    resolution: '480p',
    audio: false,
  });

  assert.deepStrictEqual(payload, {
    prompt: 'Plano cinematografico minimalista de un producto premium',
    aspect_ratio: '9:16',
    duration: '12',
    resolution: '480p',
    generate_audio: false,
  });
});

test('fal.ai video payload preserves automatic aspect ratio for Seedance', () => {
  const payload = buildFalVideoInputPayload({
    endpoint: 'bytedance/seedance-2.0/text-to-video',
    prompt: 'Video corto de un perro corriendo en un parque',
    aspectRatio: 'auto',
    duration: 8,
    resolution: '720p',
    audio: true,
  });

  assert.strictEqual(payload.aspect_ratio, 'auto');
  assert.strictEqual(payload.duration, '8');
  assert.strictEqual(payload.resolution, '720p');
  assert.strictEqual(payload.generate_audio, true);
});

test('fal.ai video routing uses reference-to-video with multiple Seedance images', () => {
  const routing = resolveFalVideoModelRequest('bytedance/seedance-2.0/text-to-video', {
    hasImage: true,
    imageCount: 3,
  });

  assert.strictEqual(routing.ok, true);
  assert.strictEqual(routing.endpoint, 'bytedance/seedance-2.0/reference-to-video');
  assert.strictEqual(routing.usingPairedEndpoint, true);

  const payload = buildFalVideoInputPayload({
    endpoint: routing.endpoint,
    prompt: '@Image1 y @Image2 forman una escena premium con movimiento de camara suave',
    imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png', 'https://cdn.example/c.png'],
    aspectRatio: '16:9',
    duration: 8,
    resolution: '720p',
    audio: true,
  });

  assert.deepStrictEqual(payload.image_urls, [
    'https://cdn.example/a.png',
    'https://cdn.example/b.png',
    'https://cdn.example/c.png',
  ]);
  assert.strictEqual(payload.image_url, undefined);
  assert.strictEqual(payload.generate_audio, true);
});

test('fal.ai video payload maps two image references to supported start and end frame fields', () => {
  const payload = buildFalVideoInputPayload({
    endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
    prompt: 'Transicion limpia entre dos frames',
    imageUrls: ['https://cdn.example/start.png', 'https://cdn.example/end.png'],
    aspectRatio: '9:16',
    duration: 5,
    audio: false,
  });

  assert.strictEqual(payload.start_image_url, 'https://cdn.example/start.png');
  assert.strictEqual(payload.end_image_url, 'https://cdn.example/end.png');
  assert.strictEqual(payload.image_urls, undefined);
});
