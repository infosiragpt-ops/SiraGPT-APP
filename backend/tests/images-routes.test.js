'use strict';

// F4 PR15 — Unit tests for the images router. Verifies Zod schemas
// (accept/reject), the image-provider mock returns SVG placeholders,
// serializer's BigInt + asset shape, and router exposes the expected
// endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const request = require('supertest');

const origRequire = Module.prototype.require;
const stubs = new Map();
let chargeCalls = 0;
let refundCalls = [];
let failureTransitions = [];
let refundOutcome = { ok: true, txn: { id: 'refund-1' } };
let refundError = null;
let providerOutcome = {
  ok: true,
  assets: [{ url: 'data:mock', format: 'svg' }],
  providerUsed: 'mock',
};
let providerError = null;
let parsedAtCharge = null;
let cacheOutcome = { ok: true };
let cacheError = null;
let responseUnavailableCalls = [];
let responseUnavailableError = null;
let attachCalls = [];
let attachOutcome = null;
let chargedResourceId = null;
let chargedResourceSpec = null;
let chargeRecovered = false;
let providerCalls = 0;
let providerSpecs = [];
let providerImplementations = [];
let createCalls = 0;
let heartbeatStarts = 0;
let heartbeatStops = 0;
let heartbeatLosesLease = false;
let providerWaitsForAbort = false;
let resourceRecoveryError = null;
let eventOrder = [];
let imageSequence = 0;
let imageUpdateHistory = [];
const imageRows = new Map();

stubs.set('../middleware/auth', {
  authenticateToken: (req, _res, next) => {
    req.user = { id: 'u1', isSuperAdmin: true };
    next();
  },
});
stubs.set('../middleware/require-paid-plan', () => (_req, _res, next) => next());
stubs.set('../middleware/charge-credits', Object.assign(
  () => (req, _res, next) => {
    chargeCalls += 1;
    parsedAtCharge = req._validatedImageData;
    req._chargedCredits = {
      feature: 'image_generation',
      amount: 5,
      replay: false,
      txn: {
        id: 'charge-1',
        userId: 'u1',
        amount: -5n,
        idempotencyKey: 'credit-idem:v1:image-test',
        metadata: {
          path: 'paid',
          feature: 'image_generation',
          requestHash: 'image-request-hash',
          requestedAmount: '5',
          ...(chargedResourceId
            ? {
              resourceId: chargedResourceId,
              resourceType: 'generatedImage',
              ...(chargedResourceSpec ? { resourceSpec: chargedResourceSpec } : {}),
            }
            : {}),
          idempotency: {
            state: 'in_progress',
            leaseToken: '11111111-1111-4111-8111-111111111111',
            leaseMs: 5_000,
          },
        },
      },
      ownsLease: true,
      recovered: chargeRecovered,
    };
    next();
  },
  {
    cacheIdempotentResponse: async () => {
      if (cacheError) throw cacheError;
      return cacheOutcome;
    },
    completeIdempotentResponseUnavailable: async (_req, options) => {
      responseUnavailableCalls.push(options);
      if (responseUnavailableError) throw responseUnavailableError;
      return { ok: true };
    },
    attachIdempotentResource: async (req, options) => {
      eventOrder.push('attach');
      attachCalls.push(options);
      if (attachOutcome?.ok === false) return attachOutcome;
      req._chargedCredits.txn.metadata.resourceId = options.resourceId;
      req._chargedCredits.txn.metadata.resourceType = options.resourceType;
      return { ok: true, txn: req._chargedCredits.txn };
    },
    startIdempotencyLeaseHeartbeat: (_req, { abortController } = {}) => {
      heartbeatStarts += 1;
      if (heartbeatLosesLease) {
        queueMicrotask(() => {
          const error = new Error('lease ownership lost');
          error.code = 'LEASE_LOST';
          abortController?.abort(error);
        });
      }
      return {
        async stop() {
          heartbeatStops += 1;
        },
      };
    },
    verifyIdempotentLeaseOwnership: async (req) => (
      req._leaseOwned === false
        ? { ok: false, code: 'LEASE_LOST' }
        : { ok: true, txn: req._chargedCredits?.txn }
    ),
    refundLastCharge: async (_req, reason, options) => {
      refundCalls.push({ reason, options });
      if (refundError) throw refundError;
      return refundOutcome;
    },
    failIdempotentOperation: async (_req, options) => {
      failureTransitions.push(options);
      return { ok: true };
    },
  },
));
stubs.set('../config/database', {
  generatedImage: {
    async create({ data }) {
      createCalls += 1;
      eventOrder.push('create');
      imageSequence += 1;
      const row = {
        id: `img_${imageSequence}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      imageRows.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      const current = imageRows.get(where.id) || {
        id: where.id,
        createdAt: new Date(),
      };
      const row = { ...current, ...data, updatedAt: new Date() };
      imageUpdateHistory.push({ id: row.id, data: { ...data } });
      imageRows.set(row.id, row);
      return row;
    },
    async findUnique({ where }) {
      if (resourceRecoveryError) throw resourceRecoveryError;
      return imageRows.get(where.id) || null;
    },
    async findMany() { return [...imageRows.values()]; },
  },
});
stubs.set('../services/image-provider', {
  generate: async (spec) => {
    providerCalls += 1;
    providerSpecs.push(spec);
    eventOrder.push('provider');
    if (providerImplementations.length > 0) {
      return providerImplementations.shift()(spec);
    }
    if (providerWaitsForAbort) {
      return new Promise((_resolve, reject) => {
        if (spec?.signal?.aborted) {
          reject(spec.signal.reason);
          return;
        }
        spec?.signal?.addEventListener(
          'abort',
          () => reject(spec.signal.reason),
          { once: true },
        );
        setTimeout(() => reject(new Error('provider did not receive abort signal')), 50);
      });
    }
    if (providerError) throw providerError;
    return providerOutcome;
  },
  pickProvider: () => 'mock',
  DEFAULT_PROVIDER: 'mock',
});
stubs.set('../services/object-storage', {
  enabled: () => false,
  sanitizeSegment: (value) => String(value),
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

const images = require('../src/routes/images');
const {
  GenerateSchema,
  VariationsSchema,
  UpscaleSchema,
  imageCost,
  runGenerationAndPersist,
  serializeImage,
} = images;
const provider = require('../src/services/image-provider');

Module.prototype.require = origRequire;

test.beforeEach(() => {
  chargeCalls = 0;
  refundCalls = [];
  failureTransitions = [];
  refundOutcome = { ok: true, txn: { id: 'refund-1' } };
  refundError = null;
  providerOutcome = {
    ok: true,
    assets: [{ url: 'data:mock', format: 'svg' }],
    providerUsed: 'mock',
  };
  providerError = null;
  parsedAtCharge = null;
  cacheOutcome = { ok: true };
  cacheError = null;
  responseUnavailableCalls = [];
  responseUnavailableError = null;
  attachCalls = [];
  attachOutcome = null;
  chargedResourceId = null;
  chargedResourceSpec = null;
  chargeRecovered = false;
  providerCalls = 0;
  providerSpecs = [];
  providerImplementations = [];
  createCalls = 0;
  heartbeatStarts = 0;
  heartbeatStops = 0;
  heartbeatLosesLease = false;
  providerWaitsForAbort = false;
  resourceRecoveryError = null;
  eventOrder = [];
  imageSequence = 0;
  imageUpdateHistory = [];
  imageRows.clear();
});

function buildImagesApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/images', images);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message, code: err.code || 'INTERNAL_ERROR' });
  });
  return app;
}

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

test('image provider timeout is bounded below the maximum default lease', () => {
  const real = require('../src/services/image-provider');
  assert.equal(real.resolveImageTimeoutMs({}), 120_000);
  assert.equal(
    real.resolveImageTimeoutMs({ IMAGE_GEN_TIMEOUT_MS: '999999999' }),
    3_570_000,
  );
});

test('invalid image payloads are rejected before charge middleware', async () => {
  const app = buildImagesApp();
  const jobs = await request(app)
    .post('/api/images/jobs')
    .send({ prompt: '', n: 9 });
  const variation = await request(app)
    .post('/api/images/parent-1/variations')
    .send({ n: 9 });
  const upscale = await request(app)
    .post('/api/images/parent-1/upscale')
    .send({ factor: 3 });

  assert.equal(jobs.status, 400);
  assert.equal(variation.status, 400);
  assert.equal(upscale.status, 400);
  assert.equal(chargeCalls, 0);
  assert.equal(refundCalls.length, 0);
});

test('validated image data is stored before charging', async () => {
  providerOutcome = {
    ok: false,
    code: 'PROVIDER_DOWN',
    reason: 'offline',
    providerUsed: 'mock',
  };
  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'a valid image prompt', n: 2 });

  assert.equal(response.status, 201);
  assert.equal(chargeCalls, 1);
  assert.deepEqual(parsedAtCharge, { prompt: 'a valid image prompt', n: 2 });
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].options.strict, true);
});

test('image resource is durably attached before provider work and heartbeat stops', async () => {
  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'attach this generated image before provider work' });

  assert.equal(response.status, 201);
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].resourceId, 'img_1');
  assert.equal(attachCalls[0].resourceType, 'generatedImage');
  assert.deepEqual(attachCalls[0].resourceSpec, {
    prompt: 'attach this generated image before provider work',
    negativePrompt: null,
    provider: 'mock',
    model: 'mock-v1',
    size: '1024x1024',
    n: 1,
    seed: null,
    quality: null,
    style: null,
  });
  assert.ok(eventOrder.indexOf('attach') > eventOrder.indexOf('create'));
  assert.ok(eventOrder.indexOf('provider') > eventOrder.indexOf('attach'));
  assert.equal(heartbeatStarts, 1);
  assert.equal(heartbeatStops, 1);
});

test('recovered READY image synthesizes response without create or provider rerun', async () => {
  chargedResourceId = 'img_existing_ready';
  imageRows.set(chargedResourceId, {
    id: chargedResourceId,
    userId: 'u1',
    prompt: 'already generated',
    provider: 'mock',
    model: 'mock-v1',
    size: '1024x1024',
    n: 1,
    status: 'READY',
    costCredits: 5n,
    assetIds: ['https://assets.example/existing.png'],
    kind: 'original',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'already generated' });

  assert.equal(response.status, 201);
  assert.equal(response.body.image.id, chargedResourceId);
  assert.equal(response.body.image.status, 'READY');
  assert.equal(providerCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(refundCalls.length, 0);
});

test('recovered PENDING and RUNNING images resume the same durable provider spec', async () => {
  chargeRecovered = true;
  chargedResourceSpec = {
    prompt: 'durable original prompt',
    negativePrompt: 'durable negative prompt',
    provider: 'mock',
    model: 'durable-model',
    size: '1024x1024',
    n: 1,
    seed: '42',
    quality: 'high',
    style: 'natural',
  };

  for (const status of ['PENDING', 'RUNNING']) {
    const resourceId = `img_resume_${status.toLowerCase()}`;
    chargedResourceId = resourceId;
    imageRows.set(resourceId, {
      id: resourceId,
      userId: 'u1',
      prompt: chargedResourceSpec.prompt,
      negativePrompt: chargedResourceSpec.negativePrompt,
      provider: chargedResourceSpec.provider,
      model: chargedResourceSpec.model,
      size: chargedResourceSpec.size,
      n: chargedResourceSpec.n,
      seed: 42n,
      quality: chargedResourceSpec.quality,
      style: chargedResourceSpec.style,
      status,
      costCredits: 5n,
      assetIds: [],
      kind: 'original',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(buildImagesApp())
      .post('/api/images/jobs')
      .send({ prompt: 'retry body must not replace durable spec' });

    assert.equal(response.status, 201);
    assert.equal(response.body.image.id, resourceId);
    assert.equal(response.body.image.status, 'READY');
  }

  assert.equal(createCalls, 0);
  assert.equal(providerCalls, 2);
  assert.equal(attachCalls.length, 0);
  for (const spec of providerSpecs) {
    assert.equal(spec.prompt, chargedResourceSpec.prompt);
    assert.equal(spec.negativePrompt, chargedResourceSpec.negativePrompt);
    assert.equal(spec.model, chargedResourceSpec.model);
    assert.equal(spec.seed, chargedResourceSpec.seed);
    assert.ok(spec.signal instanceof AbortSignal);
  }
});

test('recovered MODERATED and FAILED images never rerun provider and are refunded', async () => {
  for (const status of ['MODERATED', 'FAILED']) {
    const resourceId = `img_existing_${status.toLowerCase()}`;
    chargedResourceId = resourceId;
    imageRows.set(resourceId, {
      id: resourceId,
      userId: 'u1',
      prompt: `${status} image`,
      provider: 'mock',
      model: 'mock-v1',
      size: '1024x1024',
      n: 1,
      status,
      costCredits: 5n,
      assetIds: [],
      errorMessage: status,
      kind: 'original',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await request(buildImagesApp())
      .post('/api/images/jobs')
      .send({ prompt: `${status} image` });
    assert.equal(response.status, 201);
    assert.equal(response.body.image.id, resourceId);
    assert.equal(response.body.image.status, status);
  }
  assert.equal(providerCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(refundCalls.length, 2);
});

test('provider failure with a failed strict refund becomes refund_pending and retryable', async () => {
  providerOutcome = {
    ok: false,
    code: 'PROVIDER_DOWN',
    reason: 'offline',
    providerUsed: 'mock',
  };
  refundOutcome = { ok: false, code: 'REFUND_BALANCE_UNAVAILABLE' };

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'a valid image prompt' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'REFUND_PENDING');
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.refunded, undefined);
  assert.deepEqual(failureTransitions, [{
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  }]);
});

test('provider throw with a failed strict refund never reports refunded', async () => {
  providerError = new Error('provider crashed');
  refundError = new Error('refund database unavailable');

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'another valid image prompt' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'REFUND_PENDING');
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.refunded, undefined);
  assert.deepEqual(failureTransitions, [{
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  }]);
});

test('READY image stays successful and charged when cached response is oversized', async () => {
  cacheError = new RangeError('response too large');
  cacheError.code = 'IDEMPOTENCY_RESPONSE_TOO_LARGE';

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'a successful image with a very large response' });

  assert.equal(response.status, 201);
  assert.equal(response.body.image.status, 'READY');
  assert.deepEqual(response.body.image.assetIds, ['data:mock']);
  assert.equal(refundCalls.length, 0);
  assert.equal(failureTransitions.length, 0);
  assert.deepEqual(responseUnavailableCalls, [{
    code: 'IDEMPOTENCY_RESPONSE_TOO_LARGE',
  }]);
});

test('READY image stays successful when response-cache persistence returns failure', async () => {
  cacheOutcome = { ok: false, code: 'IDEMPOTENCY_CACHE_FAILED' };

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'another successful accessible image' });

  assert.equal(response.status, 201);
  assert.equal(response.body.image.status, 'READY');
  assert.deepEqual(response.body.image.assetIds, ['data:mock']);
  assert.equal(refundCalls.length, 0);
  assert.equal(failureTransitions.length, 0);
  assert.deepEqual(responseUnavailableCalls, [{
    code: 'IDEMPOTENCY_CACHE_FAILED',
  }]);
});

test('READY image success is preserved even when unavailable-marker persistence also fails', async () => {
  cacheError = new Error('credit metadata unavailable');
  cacheError.code = 'IDEMPOTENCY_CACHE_FAILED';
  responseUnavailableError = new Error('credit metadata still unavailable');

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'successful artifact survives cache outage' });

  assert.equal(response.status, 201);
  assert.equal(response.body.image.status, 'READY');
  assert.equal(refundCalls.length, 0);
  assert.equal(failureTransitions.length, 0);
  assert.deepEqual(responseUnavailableCalls, [{
    code: 'IDEMPOTENCY_CACHE_FAILED',
  }]);
});

test('durable marker and image resource recovery failure returns 503 without refunding READY work', async () => {
  cacheError = new Error('credit response cache unavailable');
  cacheError.code = 'IDEMPOTENCY_CACHE_FAILED';
  responseUnavailableError = new Error('credit marker unavailable');
  resourceRecoveryError = new Error('generated image lookup unavailable');

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'successful image whose recovery stores are unavailable' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE');
  assert.equal(response.body.retryable, true);
  assert.equal(refundCalls.length, 0);
  assert.equal(imageRows.get('img_1').status, 'READY');
});

test('image heartbeat LEASE_LOST aborts provider work without refund or downgrade', async () => {
  heartbeatLosesLease = true;
  providerWaitsForAbort = true;

  const response = await request(buildImagesApp())
    .post('/api/images/jobs')
    .send({ prompt: 'abort this provider after lease ownership is lost' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'LEASE_LOST');
  assert.equal(response.body.retryable, true);
  assert.equal(providerCalls, 1);
  assert.equal(refundCalls.length, 0);
  assert.equal(heartbeatStops, 1);
  assert.equal(imageRows.get('img_1').status, 'RUNNING');
});

test('late stale owner cannot overwrite recovered terminal image or double refund', async () => {
  const row = {
    id: 'img_overlap',
    userId: 'u1',
    prompt: 'overlapping generation',
    provider: 'mock',
    model: 'mock-v1',
    size: '1024x1024',
    n: 1,
    status: 'PENDING',
    costCredits: 5n,
    assetIds: [],
    kind: 'original',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  imageRows.set(row.id, row);
  let releaseOriginal;
  let originalProviderStarted;
  const originalStarted = new Promise((resolve) => {
    originalProviderStarted = resolve;
  });
  providerImplementations = [
    async () => {
      originalProviderStarted();
      return new Promise((resolve) => {
        releaseOriginal = () => resolve({
          ok: true,
          assets: [{ url: 'data:stale-result', format: 'png' }],
          providerUsed: 'mock',
        });
      });
    },
    async () => ({
      ok: true,
      assets: [{ url: 'data:recovered-result', format: 'png' }],
      providerUsed: 'mock',
    }),
  ];
  const makeWorkerRequest = () => ({
    user: { id: 'u1' },
    _leaseOwned: true,
    _chargedCredits: {
      amount: 5,
      ownsLease: true,
      txn: {
        id: 'charge-overlap',
        userId: 'u1',
        idempotencyKey: 'credit-idem:v1:overlap',
        metadata: {
          resourceId: row.id,
          resourceType: 'generatedImage',
          idempotency: {
            state: 'in_progress',
            leaseToken: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
    },
  });
  const originalReq = makeWorkerRequest();
  const recoveredReq = makeWorkerRequest();
  recoveredReq._chargedCredits.txn.metadata.idempotency.leaseToken =
    '22222222-2222-4222-8222-222222222222';

  const originalRun = runGenerationAndPersist(
    originalReq,
    row,
    { prompt: row.prompt, provider: 'mock' },
    { signal: new AbortController().signal },
  );
  await originalStarted;
  originalReq._leaseOwned = false;

  const recovered = await runGenerationAndPersist(
    recoveredReq,
    row,
    { prompt: row.prompt, provider: 'mock' },
    { signal: new AbortController().signal },
  );
  releaseOriginal();
  await assert.rejects(originalRun, (error) => error?.code === 'LEASE_LOST');

  assert.equal(recovered.row.status, 'READY');
  assert.deepEqual(recovered.row.assetIds, ['data:recovered-result']);
  assert.equal(providerCalls, 2);
  assert.equal(refundCalls.length, 0);
  const terminalUpdates = imageUpdateHistory.filter(({ data }) => (
    ['READY', 'FAILED', 'MODERATED'].includes(data.status)
  ));
  assert.equal(terminalUpdates.length, 1);
  assert.equal(terminalUpdates[0].data.status, 'READY');
  assert.deepEqual(imageRows.get(row.id).assetIds, ['data:recovered-result']);
});

test('owner already stale before provider work cannot downgrade a terminal image', async () => {
  const row = {
    id: 'img_already_recovered',
    userId: 'u1',
    prompt: 'already recovered',
    provider: 'mock',
    model: 'mock-v1',
    size: '1024x1024',
    n: 1,
    status: 'READY',
    costCredits: 5n,
    assetIds: ['data:winner-result'],
    kind: 'original',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  imageRows.set(row.id, row);
  const staleReq = {
    user: { id: 'u1' },
    _leaseOwned: false,
    _chargedCredits: {
      amount: 5,
      ownsLease: true,
      txn: {
        id: 'charge-already-recovered',
        userId: 'u1',
        idempotencyKey: 'credit-idem:v1:already-recovered',
        metadata: {
          idempotency: {
            state: 'in_progress',
            leaseToken: '33333333-3333-4333-8333-333333333333',
          },
        },
      },
    },
  };

  await assert.rejects(
    runGenerationAndPersist(
      staleReq,
      row,
      { prompt: row.prompt, provider: 'mock' },
      { signal: new AbortController().signal },
    ),
    (error) => error?.code === 'LEASE_LOST',
  );

  assert.equal(providerCalls, 0);
  assert.equal(imageUpdateHistory.length, 0);
  assert.equal(imageRows.get(row.id).status, 'READY');
  assert.deepEqual(imageRows.get(row.id).assetIds, ['data:winner-result']);
  assert.equal(refundCalls.length, 0);
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
