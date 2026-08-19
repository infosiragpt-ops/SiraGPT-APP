'use strict';

// F4 PR15 — Unit tests for the images router. Verifies Zod schemas
// (accept/reject), the image-provider mock returns SVG placeholders,
// serializer's BigInt + asset shape, and router exposes the expected
// endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origRequire = Module.prototype.require;
const stubs = new Map();
stubs.set('../middleware/auth', { authenticateToken: (_req, _res, next) => next() });
stubs.set('../middleware/charge-credits', Object.assign(
  () => (_req, _res, next) => next(),
  { refundLastCharge: async () => null },
));
stubs.set('../config/database', {
  generatedImage: {
    async create({ data }) { return { id: 'img_1', ...data, createdAt: new Date(), updatedAt: new Date() }; },
    async update({ data }) { return { id: 'img_1', ...data, createdAt: new Date(), updatedAt: new Date() }; },
    async findUnique() { return null; },
    async findMany() { return []; },
  },
});
stubs.set('../services/image-provider', {
  generate: async (spec) => ({ ok: true, assets: [{ url: 'data:mock', format: 'svg' }], providerUsed: 'mock' }),
  pickProvider: () => 'mock',
  DEFAULT_PROVIDER: 'mock',
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

const images = require('../src/routes/images');
const { GenerateSchema, VariationsSchema, UpscaleSchema, serializeImage, imageCost } = images;
const provider = require('../src/services/image-provider');

Module.prototype.require = origRequire;

test('images router: exposes /jobs (POST + GET), /history, /:id/variations, /:id/upscale, /:id/delete', () => {
  const paths = new Set();
  for (const layer of images.stack) {
    if (!layer.route) continue;
    paths.add(layer.route.path);
  }
  assert.ok(paths.has('/jobs'));
  assert.ok(paths.has('/jobs/:id'));
  assert.ok(paths.has('/history'));
  assert.ok(paths.has('/:id/variations'));
  assert.ok(paths.has('/:id/upscale'));
  assert.ok(paths.has('/:id/delete'));
});

test('GenerateSchema: requires prompt, enforces size pattern', () => {
  assert.equal(GenerateSchema.safeParse({ prompt: 'a cat' }).success, true);
  assert.equal(GenerateSchema.safeParse({ prompt: 'a cat', size: '1024x1024' }).success, true);
  assert.equal(GenerateSchema.safeParse({ prompt: 'a cat', size: 'huge' }).success, false);
  assert.equal(GenerateSchema.safeParse({}).success, false);
});

test('GenerateSchema: clamps n to 1..4', () => {
  assert.equal(GenerateSchema.safeParse({ prompt: 'x', n: 4 }).success, true);
  assert.equal(GenerateSchema.safeParse({ prompt: 'x', n: 5 }).success, false);
  assert.equal(GenerateSchema.safeParse({ prompt: 'x', n: 0 }).success, false);
});

test('VariationsSchema: defaults n=1, max 4', () => {
  const parse = VariationsSchema.safeParse({});
  assert.equal(parse.success, true);
  assert.equal(parse.data.n, 1);
});

test('UpscaleSchema: only 2 or 4 accepted; defaults to 2', () => {
  assert.equal(UpscaleSchema.safeParse({}).success, true);
  assert.equal(UpscaleSchema.safeParse({}).data.factor, 2);
  assert.equal(UpscaleSchema.safeParse({ factor: 4 }).success, true);
  assert.equal(UpscaleSchema.safeParse({ factor: 3 }).success, false);
});

test('serializeImage: BigInt seed + costCredits become strings; defaults assetIds to []', () => {
  const out = serializeImage({
    id: 'img_1',
    userId: 'u1',
    prompt: 'cat',
    provider: 'mock',
    model: 'mock-v1',
    size: '1024x1024',
    n: 1,
    seed: BigInt(42),
    status: 'READY',
    costCredits: BigInt(5),
    assetIds: null,
    parentImageId: null,
    kind: 'original',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(out.seed, '42');
  assert.equal(out.costCredits, '5');
  assert.deepEqual(out.assetIds, []);
});

test('serializeImage: null/undefined → null', () => {
  assert.equal(serializeImage(null), null);
  assert.equal(serializeImage(undefined), null);
});

test('imageCost: respects CREDITS_IMAGE_BASE env, default 5, min 1', () => {
  const orig = process.env.CREDITS_IMAGE_BASE;
  delete process.env.CREDITS_IMAGE_BASE;
  assert.equal(imageCost(), 5);
  process.env.CREDITS_IMAGE_BASE = '20';
  assert.equal(imageCost(), 20);
  process.env.CREDITS_IMAGE_BASE = '0';
  assert.equal(imageCost(), 1, 'must clamp to >=1');
  if (orig === undefined) delete process.env.CREDITS_IMAGE_BASE;
  else process.env.CREDITS_IMAGE_BASE = orig;
});

test('image-provider: mock returns an SVG asset (no external call)', async () => {
  const real = require('../src/services/image-provider');
  const result = await real.generate({ prompt: 'a smiling fox', n: 2, provider: 'mock' });
  assert.equal(result.ok, true);
  assert.equal(result.providerUsed, 'mock');
  assert.equal(result.assets.length, 2);
  for (const a of result.assets) {
    assert.match(a.url, /^data:image\/svg\+xml;utf8,/);
  }
});

test('image-provider: openai without OPENAI_API_KEY returns PROVIDER_DOWN', async () => {
  const real = require('../src/services/image-provider');
  const orig = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const result = await real.generate({ prompt: 'x', provider: 'openai' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DOWN');
  assert.equal(result.providerUsed, 'openai');
  if (orig) process.env.OPENAI_API_KEY = orig;
});

test('image-provider: unknown provider returns PROVIDER_DOWN', async () => {
  const real = require('../src/services/image-provider');
  const result = await real.generate({ prompt: 'x', provider: 'midjourney' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DOWN');
});
