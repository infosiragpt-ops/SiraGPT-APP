'use strict';

/**
 * /api/images — F4 PR15 — Async image generation jobs + history + tree.
 *
 *   POST   /api/images/jobs              create generation job
 *   GET    /api/images/jobs/:id          job status
 *   GET    /api/images/history           paginated user history
 *   POST   /api/images/:id/variations    N variations of parent
 *   POST   /api/images/:id/upscale       2x/4x upscale of parent
 *   POST   /api/images/:id/delete        soft delete
 *
 * Persists to the F1 `generated_images` table with `parentImageId` +
 * `kind` to track the variation/upscale tree. Provider is configurable
 * via env `IMAGE_PROVIDER` (mock / openai / none) — see
 * src/services/image-provider.js.
 *
 * Credits: every successful create / variation / upscale charges
 * `CREDITS_IMAGE_BASE` (default 5) credits via the F2 PR8 middleware.
 * On provider failure we refund automatically so the user is never
 * drained for an unsuccessful call.
 *
 * NOTE: this is the new async-first surface. The legacy
 * `POST /api/images/generations` in routes/api.js stays untouched for
 * back-compat with frontend clients pre-F3.
 */

const express = require('express');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const chargeCredits = require('../middleware/charge-credits');
const requirePaidPlan = require('../middleware/require-paid-plan');
const {
  attachIdempotentResource,
  cacheIdempotentResponse,
  completeIdempotentResponseUnavailable,
  failIdempotentOperation,
  refundLastCharge,
  startIdempotencyLeaseHeartbeat,
  verifyIdempotentLeaseOwnership,
} = chargeCredits;
const imageProvider = require('../services/image-provider');
const objectStorage = require('../services/object-storage');
const crypto = require('crypto');
const prisma = require('../config/database');

const router = express.Router();

// Copy provider asset URLs into R2 so they don't expire, returning stable app
// URLs served by the /uploads R2 fallback ("images/" is a public prefix). On
// any failure we keep the original provider URL so generation never appears to
// fail. No-op passthrough when R2 is disabled (dev without R2 secrets).
async function persistAssetsToR2(userId, assets) {
  const urls = [];
  for (const a of assets || []) {
    const src = a && a.url;
    if (!src) continue;
    if (!objectStorage.enabled()) { urls.push(src); continue; }
    try {
      const resp = await fetch(src, { signal: AbortSignal.timeout(Number(process.env.ASSET_FETCH_TIMEOUT_MS) || 30000) });
      if (!resp.ok) { try { await resp.body?.cancel?.(); } catch { /* noop */ } urls.push(src); continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'png';
      const seg = objectStorage.sanitizeSegment(userId);
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const key = `uploads/images/${seg}/${filename}`;
      await objectStorage.putBuffer({ key, buffer: buf, contentType: ct });
      urls.push(`/uploads/images/${seg}/${filename}`);
    } catch (err) {
      console.warn(`[images] R2 asset copy failed, keeping provider URL: ${err && err.message}`);
      urls.push(src);
    }
  }
  return urls;
}

const SIZE_RE = /^(\d{3,5})x(\d{3,5})$/;

const GenerateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  negativePrompt: z.string().max(2000).optional(),
  size: z.string().regex(SIZE_RE).optional(),
  n: z.number().int().min(1).max(4).optional(),
  seed: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  quality: z.string().max(40).optional(),
  style: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  provider: z.enum(['mock', 'openai', 'none']).optional(),
  chatId: z.string().max(64).optional(),
  messageId: z.string().max(64).optional(),
});

const VariationsSchema = z.object({
  n: z.number().int().min(1).max(4).default(1),
});

const UpscaleSchema = z.object({
  factor: z.union([z.literal(2), z.literal(4)]).default(2),
});

function imageCost() {
  return Math.max(1, Number(process.env.CREDITS_IMAGE_BASE || 5));
}

function validateImagePayload(schema) {
  return function imagePayloadValidator(req, res, next) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid payload',
        issues: parsed.error.issues,
      });
    }
    req._validatedImageData = parsed.data;
    return next();
  };
}

function serializeImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    chatId: row.chatId,
    messageId: row.messageId,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    provider: row.provider,
    model: row.model,
    size: row.size,
    n: row.n,
    seed: row.seed ? row.seed.toString() : null,
    quality: row.quality,
    style: row.style,
    status: row.status,
    costCredits: row.costCredits ? row.costCredits.toString() : '0',
    errorMessage: row.errorMessage,
    assetIds: row.assetIds || [],
    parentImageId: row.parentImageId,
    kind: row.kind,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const RECOVERABLE_IMAGE_STATUSES = new Set(['READY', 'MODERATED', 'FAILED']);

function imageResponseBody(req, row, { includeCharge = false } = {}) {
  const body = { image: serializeImage(row) };
  if (includeCharge) {
    const charge = req?._chargedCredits;
    body.charge = charge
      ? { amount: String(charge.amount), transactionId: charge.txn?.id }
      : null;
  }
  return body;
}

function imageLeaseLostResponse(res) {
  return res.status(409).json({
    error: 'idempotency lease ownership lost',
    code: 'LEASE_LOST',
    retryable: true,
  });
}

function imageRecoveryUnavailableResponse(res) {
  return res.status(503).json({
    error: 'generated image idempotency recovery unavailable',
    code: 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE',
    retryable: true,
  });
}

function imageRecoveryUnavailableError(cause) {
  const error = new Error('generated image idempotency recovery unavailable');
  error.code = 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE';
  error.retryable = true;
  error.cause = cause;
  return error;
}

function createImageLeaseContext(req) {
  const abortController = new AbortController();
  const heartbeat = startIdempotencyLeaseHeartbeat(req, { abortController });
  return {
    signal: abortController.signal,
    async stop() {
      await heartbeat.stop?.();
    },
  };
}

async function readAttachedImage(req) {
  const resourceId = req?._chargedCredits?.txn?.metadata?.resourceId;
  if (!resourceId) return null;
  const row = await prisma.generatedImage.findUnique({ where: { id: resourceId } });
  if (!row || row.userId !== req.user.id) {
    throw imageRecoveryUnavailableError(new Error('attached generated image not found'));
  }
  return row;
}

async function persistSuccessfulChargeResponse(
  req,
  statusCode,
  body,
  { includeCharge = false } = {},
) {
  if (!req?._chargedCredits?.txn) return { ok: true, skipped: true };
  let failureCode = 'IDEMPOTENCY_CACHE_FAILED';
  try {
    const cached = await cacheIdempotentResponse(req, { statusCode, body });
    if (cached?.ok) return cached;
    failureCode = cached?.code || failureCode;
  } catch (error) {
    failureCode = error?.code || failureCode;
  }

  // The provider result and READY artifact already exist. Cache failure is
  // therefore an idempotency replay limitation, never a generation failure:
  // do not refund the successful charge or downgrade the accessible artifact.
  let markerOk = false;
  if (failureCode !== 'LEASE_LOST') {
    try {
      const marked = await completeIdempotentResponseUnavailable(req, {
        code: failureCode,
      });
      markerOk = marked?.ok === true;
    } catch (error) {
      req.log?.warn?.(
        { err: error, chargeTransactionId: req._chargedCredits.txn.id },
        'image response-unavailable marker persistence failed',
      );
    }
  }
  let recoveredBody = null;
  try {
    const row = await readAttachedImage(req);
    if (row && RECOVERABLE_IMAGE_STATUSES.has(row.status)) {
      recoveredBody = imageResponseBody(req, row, { includeCharge });
    }
  } catch {
    // The durable response-unavailable marker remains sufficient when it won.
  }
  if (!markerOk && !recoveredBody) {
    throw imageRecoveryUnavailableError(new Error(failureCode));
  }
  return {
    ok: true,
    responseUnavailable: true,
    code: failureCode,
    body: recoveredBody || body,
  };
}

function refundPendingError(cause) {
  const error = new Error('image credit refund pending');
  error.code = 'REFUND_PENDING';
  error.retryable = true;
  error.cause = cause;
  return error;
}

async function markImageRefundPending(req) {
  return failIdempotentOperation(req, {
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  });
}

async function strictRefundImageCharge(req, reason) {
  let failure;
  try {
    const result = await refundLastCharge(req, reason, { strict: true });
    if (result?.ok === true) return result;
    failure = new Error(result?.code || 'credit refund failed');
    failure.code = result?.code || 'REFUND_FAILED';
  } catch (error) {
    failure = error;
  }
  if (failure?.code === 'LEASE_LOST') throw failure;
  try {
    const marked = await markImageRefundPending(req);
    if (marked?.code === 'LEASE_LOST') {
      const error = new Error('idempotency lease ownership lost');
      error.code = 'LEASE_LOST';
      throw error;
    }
  } catch (stateError) {
    if (stateError?.code === 'LEASE_LOST') throw stateError;
    if (!failure) failure = stateError;
  }
  throw refundPendingError(failure);
}

function sendImageRefundPending(req, res) {
  return res.status(503).json({
    error: 'credit refund pending',
    code: 'REFUND_PENDING',
    retryable: true,
    audit: {
      chargeTransactionId: req?._chargedCredits?.txn?.id || null,
    },
  });
}

function imageProviderSpec(row, durableSpec) {
  const spec = durableSpec && typeof durableSpec === 'object' && !Array.isArray(durableSpec)
    ? durableSpec
    : {};
  const n = Number(spec.n ?? row.n ?? 1);
  const seed = spec.seed ?? row.seed ?? null;
  return {
    prompt: String(spec.prompt ?? row.prompt ?? ''),
    negativePrompt: spec.negativePrompt == null
      ? (row.negativePrompt ?? null)
      : String(spec.negativePrompt),
    provider: String(spec.provider ?? row.provider ?? imageProvider.DEFAULT_PROVIDER),
    model: String(spec.model ?? row.model ?? 'mock-v1'),
    size: String(spec.size ?? row.size ?? '1024x1024'),
    n: Number.isInteger(n) && n > 0 ? n : 1,
    seed: seed == null ? null : String(seed),
    quality: spec.quality == null ? (row.quality ?? null) : String(spec.quality),
    style: spec.style == null ? (row.style ?? null) : String(spec.style),
  };
}

async function attachGeneratedImage(req, row, spec) {
  const resourceSpec = imageProviderSpec(row, spec);
  const attached = await attachIdempotentResource(req, {
    resourceId: row.id,
    resourceType: 'generatedImage',
    resourceSpec,
  });
  if (attached?.ok) return attached;
  const error = new Error('generated image idempotency attachment failed');
  error.code = attached?.code || 'IMAGE_RESOURCE_ATTACH_FAILED';
  throw error;
}

async function respondFromAttachedImage(req, res, {
  includeCharge = false,
  signal,
} = {}) {
  if (!req?._chargedCredits?.txn?.metadata?.resourceId) return false;
  let row;
  try {
    row = await readAttachedImage(req);
  } catch (error) {
    return imageRecoveryUnavailableResponse(res);
  }
  if (!RECOVERABLE_IMAGE_STATUSES.has(row.status)) {
    const charge = req._chargedCredits;
    if (
      !['PENDING', 'RUNNING'].includes(row.status)
      || charge?.recovered !== true
      || charge?.ownsLease !== true
    ) {
      return res.status(409).json({
        error: 'generated image resource is still in progress',
        code: 'IMAGE_RESOURCE_IN_PROGRESS',
        retryable: true,
        resourceId: row.id,
      });
    }
    const durableSpec = charge.txn.metadata?.resourceSpec;
    const { row: resumedRow, refunded } = await runGenerationAndPersist(
      req,
      row,
      imageProviderSpec(row, durableSpec),
      { signal },
    );
    let resumedBody = imageResponseBody(req, resumedRow, { includeCharge });
    if (!refunded) {
      const persisted = await persistSuccessfulChargeResponse(
        req,
        201,
        resumedBody,
        { includeCharge },
      );
      resumedBody = persisted?.body || resumedBody;
    }
    res.status(201).json(resumedBody);
    return true;
  }
  let body = imageResponseBody(req, row, { includeCharge });
  if (row.status === 'READY') {
    try {
      const persisted = await persistSuccessfulChargeResponse(
        req,
        201,
        body,
        { includeCharge },
      );
      body = persisted?.body || body;
    } catch (error) {
      return imageRecoveryUnavailableResponse(res);
    }
  } else {
    try {
      await strictRefundImageCharge(req, `recover_resource:${row.status.toLowerCase()}`);
    } catch (error) {
      if (error?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
      return sendImageRefundPending(req, res);
    }
  }
  res.status(201).json(body);
  return true;
}

function leaseLostError() {
  const error = new Error('idempotency lease ownership lost');
  error.code = 'LEASE_LOST';
  error.retryable = true;
  return error;
}

async function requireImageLeaseOwnership(req) {
  const ownership = await verifyIdempotentLeaseOwnership(req);
  if (ownership?.ok !== true) throw leaseLostError();
  return ownership;
}

async function runGenerationAndPersist(req, dbRow, spec, { signal } = {}) {
  // Mark RUNNING, hit provider, then fence all provider-result persistence.
  try {
    await requireImageLeaseOwnership(req);
    await prisma.generatedImage.update({
      where: { id: dbRow.id },
      data: { status: 'RUNNING' },
    });
    const result = await imageProvider.generate({ ...spec, signal });
    if (signal?.aborted) throw signal.reason;
    await requireImageLeaseOwnership(req);
    if (!result.ok) {
      const status = result.code === 'MODERATED' ? 'MODERATED' : 'FAILED';
      const row = await prisma.generatedImage.update({
        where: { id: dbRow.id },
        data: { status, errorMessage: result.reason || result.code },
      });
      await strictRefundImageCharge(req, `provider:${result.code}`);
      return { row, refunded: true, providerResult: result };
    }
    const assetUrls = await persistAssetsToR2(dbRow.userId, result.assets || []);
    await requireImageLeaseOwnership(req);
    const row = await prisma.generatedImage.update({
      where: { id: dbRow.id },
      data: {
        status: 'READY',
        provider: result.providerUsed,
        assetIds: assetUrls,
      },
    });
    return { row, refunded: false, providerResult: result };
  } catch (err) {
    if (err?.code === 'LEASE_LOST' || signal?.reason?.code === 'LEASE_LOST') {
      throw signal?.reason || err;
    }
    if (err?.code === 'REFUND_PENDING') throw err;
    await requireImageLeaseOwnership(req);
    let row;
    try {
      row = await prisma.generatedImage.update({
        where: { id: dbRow.id },
        data: { status: 'FAILED', errorMessage: err && err.message },
      });
    } catch {
      row = {
        ...dbRow,
        status: 'FAILED',
        errorMessage: err && err.message,
      };
    }
    await strictRefundImageCharge(req, 'provider_throw');
    return { row, refunded: true, providerResult: { ok: false, code: 'PROVIDER_ERROR', reason: err.message } };
  }
}

// ── POST /api/images/jobs ──────────────────────────────────────────
router.post(
  '/jobs',
  authenticateToken,
  requirePaidPlan({ feature: 'image_generation' }),
  validateImagePayload(GenerateSchema),
  chargeCredits({ feature: 'image_generation', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const data = req._validatedImageData;
    const charge = req._chargedCredits;
    const lease = createImageLeaseContext(req);
    // Refund the already-charged credits if persistence/generation throws before
    // a row exists (DB error), then re-throw to preserve the existing 500. The
    // happy path never throws, and runGenerationAndPersist only refunds on its
    // normal-return paths, so this can't double-refund.
    try {
      const recovered = await respondFromAttachedImage(req, res, {
        includeCharge: true,
        signal: lease.signal,
      });
      if (recovered) return recovered;
      const dbRow = await prisma.generatedImage.create({
        data: {
          userId: req.user.id,
          chatId: data.chatId || null,
          messageId: data.messageId || null,
          prompt: data.prompt,
          negativePrompt: data.negativePrompt || null,
          provider: data.provider || imageProvider.DEFAULT_PROVIDER,
          model: data.model || (data.provider === 'openai' ? 'dall-e-3' : 'mock-v1'),
          size: data.size || '1024x1024',
          n: data.n || 1,
          seed: data.seed != null ? BigInt(data.seed) : null,
          quality: data.quality || null,
          style: data.style || null,
          status: 'PENDING',
          costCredits: charge ? BigInt(charge.amount) : BigInt(0),
          kind: 'original',
        },
      });
      const providerSpec = imageProviderSpec(dbRow);
      await attachGeneratedImage(req, dbRow, providerSpec);
      // Drive the provider call inline. For real prod we'd push to BullMQ.
      const { row, refunded } = await runGenerationAndPersist(
        req,
        dbRow,
        providerSpec,
        { signal: lease.signal },
      );
      let responseBody = imageResponseBody(req, row, { includeCharge: true });
      if (!refunded) {
        const persisted = await persistSuccessfulChargeResponse(
          req,
          201,
          responseBody,
          { includeCharge: true },
        );
        responseBody = persisted?.body || responseBody;
      }
      return res.status(201).json(responseBody);
    } catch (err) {
      if (err?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
      if (err?.code === 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE') {
        return imageRecoveryUnavailableResponse(res);
      }
      if (err?.code === 'REFUND_PENDING') return sendImageRefundPending(req, res);
      try {
        await strictRefundImageCharge(req, 'persist_error');
      } catch (refundError) {
        if (refundError?.code === 'REFUND_PENDING') {
          return sendImageRefundPending(req, res);
        }
        throw refundError;
      }
      throw err;
    } finally {
      await lease.stop();
    }
  },
);

// ── GET /api/images/jobs/:id ───────────────────────────────────────
router.get('/jobs/:id', authenticateToken, async (req, res, next) => {
  try {
    const row = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
    if (!row || row.userId !== req.user.id) {
      return res.status(404).json({ error: 'image not found' });
    }
    res.json({ image: serializeImage(row) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/images/history ────────────────────────────────────────
router.get('/history', authenticateToken, async (req, res, next) => {
  try {
    // Clamp to [1,100]: `parseInt || 24` turned an explicit 0 into 24, and a
    // negative ?limit slipped through to Prisma's `take` (negative take reverses
    // pagination).
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 100));
    const cursor = req.query.cursor ? { id: String(req.query.cursor) } : undefined;
    const rows = await prisma.generatedImage.findMany({
      where: { userId: req.user.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor && { skip: 1, cursor }),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeImage);
    res.json({ images: items, nextCursor: hasMore ? items[items.length - 1].id : null });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/images/:id/variations ────────────────────────────────
router.post(
  '/:id/variations',
  authenticateToken,
  requirePaidPlan({ feature: 'image_variation' }),
  validateImagePayload(VariationsSchema),
  chargeCredits({ feature: 'image_variation', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const data = req._validatedImageData;
    const lease = createImageLeaseContext(req);
    try {
      const recovered = await respondFromAttachedImage(req, res, {
        signal: lease.signal,
      });
      if (recovered) return recovered;
      const parent = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
      if (!parent || parent.userId !== req.user.id) {
        try {
          await strictRefundImageCharge(req, 'parent_not_found');
        } catch (err) {
          if (err?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
          if (err?.code === 'REFUND_PENDING') return sendImageRefundPending(req, res);
          throw err;
        }
        return res.status(404).json({ error: 'parent image not found' });
      }
      const charge = req._chargedCredits;
      // Refund the already-charged credits if persistence/generation throws (see /jobs).
      try {
        const dbRow = await prisma.generatedImage.create({
          data: {
            userId: req.user.id,
            chatId: parent.chatId,
            prompt: parent.prompt,
            provider: parent.provider,
            model: parent.model,
            size: parent.size,
            n: data.n,
            status: 'PENDING',
            costCredits: charge ? BigInt(charge.amount) : BigInt(0),
            kind: 'variation',
            parentImageId: parent.id,
          },
        });
        const providerSpec = imageProviderSpec(dbRow);
        await attachGeneratedImage(req, dbRow, providerSpec);
        const { row, refunded } = await runGenerationAndPersist(
          req,
          dbRow,
          providerSpec,
          { signal: lease.signal },
        );
        let responseBody = imageResponseBody(req, row);
        if (!refunded) {
          const persisted = await persistSuccessfulChargeResponse(req, 201, responseBody);
          responseBody = persisted?.body || responseBody;
        }
        return res.status(201).json(responseBody);
      } catch (err) {
        if (err?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
        if (err?.code === 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE') {
          return imageRecoveryUnavailableResponse(res);
        }
        if (err?.code === 'REFUND_PENDING') return sendImageRefundPending(req, res);
        try {
          await strictRefundImageCharge(req, 'persist_error');
        } catch (refundError) {
          if (refundError?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
          if (refundError?.code === 'REFUND_PENDING') {
            return sendImageRefundPending(req, res);
          }
          throw refundError;
        }
        throw err;
      }
    } finally {
      await lease.stop();
    }
  },
);

// ── POST /api/images/:id/upscale ───────────────────────────────────
router.post(
  '/:id/upscale',
  authenticateToken,
  requirePaidPlan({ feature: 'image_upscale' }),
  validateImagePayload(UpscaleSchema),
  chargeCredits({ feature: 'image_upscale', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const data = req._validatedImageData;
    const lease = createImageLeaseContext(req);
    try {
      const recovered = await respondFromAttachedImage(req, res, {
        signal: lease.signal,
      });
      if (recovered) return recovered;
      const parent = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
      if (!parent || parent.userId !== req.user.id) {
        try {
          await strictRefundImageCharge(req, 'parent_not_found');
        } catch (err) {
          if (err?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
          if (err?.code === 'REFUND_PENDING') return sendImageRefundPending(req, res);
          throw err;
        }
        return res.status(404).json({ error: 'parent image not found' });
      }
      const factor = data.factor;
      const sizeMatch = (parent.size || '1024x1024').match(SIZE_RE);
      const newSize = sizeMatch
        ? `${Number(sizeMatch[1]) * factor}x${Number(sizeMatch[2]) * factor}`
        : parent.size;
      const charge = req._chargedCredits;
      // Refund the already-charged credits if persistence/generation throws (see /jobs).
      try {
        const dbRow = await prisma.generatedImage.create({
          data: {
            userId: req.user.id,
            chatId: parent.chatId,
            prompt: parent.prompt,
            provider: parent.provider,
            model: parent.model,
            size: newSize,
            n: 1,
            status: 'PENDING',
            costCredits: charge ? BigInt(charge.amount) : BigInt(0),
            kind: 'upscale',
            parentImageId: parent.id,
          },
        });
        const providerSpec = imageProviderSpec(dbRow);
        await attachGeneratedImage(req, dbRow, providerSpec);
        const { row, refunded } = await runGenerationAndPersist(
          req,
          dbRow,
          providerSpec,
          { signal: lease.signal },
        );
        let responseBody = imageResponseBody(req, row);
        if (!refunded) {
          const persisted = await persistSuccessfulChargeResponse(req, 201, responseBody);
          responseBody = persisted?.body || responseBody;
        }
        return res.status(201).json(responseBody);
      } catch (err) {
        if (err?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
        if (err?.code === 'IMAGE_IDEMPOTENCY_RECOVERY_UNAVAILABLE') {
          return imageRecoveryUnavailableResponse(res);
        }
        if (err?.code === 'REFUND_PENDING') return sendImageRefundPending(req, res);
        try {
          await strictRefundImageCharge(req, 'persist_error');
        } catch (refundError) {
          if (refundError?.code === 'LEASE_LOST') return imageLeaseLostResponse(res);
          if (refundError?.code === 'REFUND_PENDING') {
            return sendImageRefundPending(req, res);
          }
          throw refundError;
        }
        throw err;
      }
    } finally {
      await lease.stop();
    }
  },
);

// ── POST /api/images/:id/delete ────────────────────────────────────
router.post('/:id/delete', authenticateToken, async (req, res, next) => {
  try {
    const row = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
    if (!row || row.userId !== req.user.id) {
      return res.status(404).json({ error: 'image not found' });
    }
    const updated = await prisma.generatedImage.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
    res.json({ image: serializeImage(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.GenerateSchema = GenerateSchema;
module.exports.VariationsSchema = VariationsSchema;
module.exports.UpscaleSchema = UpscaleSchema;
module.exports.serializeImage = serializeImage;
module.exports.imageCost = imageCost;
module.exports.imageProviderSpec = imageProviderSpec;
module.exports.runGenerationAndPersist = runGenerationAndPersist;
