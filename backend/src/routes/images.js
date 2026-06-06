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
const { refundLastCharge } = chargeCredits;
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
      const resp = await fetch(src);
      if (!resp.ok) { urls.push(src); continue; }
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

async function runGenerationAndPersist(req, dbRow, spec) {
  // Mark RUNNING, hit provider, persist READY/FAILED/MODERATED.
  try {
    await prisma.generatedImage.update({
      where: { id: dbRow.id },
      data: { status: 'RUNNING' },
    });
    const result = await imageProvider.generate(spec);
    if (!result.ok) {
      const status = result.code === 'MODERATED' ? 'MODERATED' : 'FAILED';
      const row = await prisma.generatedImage.update({
        where: { id: dbRow.id },
        data: { status, errorMessage: result.reason || result.code },
      });
      await refundLastCharge(req, `provider:${result.code}`);
      return { row, refunded: true, providerResult: result };
    }
    const assetUrls = await persistAssetsToR2(dbRow.userId, result.assets || []);
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
    const row = await prisma.generatedImage.update({
      where: { id: dbRow.id },
      data: { status: 'FAILED', errorMessage: err && err.message },
    });
    await refundLastCharge(req, 'provider_throw');
    return { row, refunded: true, providerResult: { ok: false, code: 'PROVIDER_ERROR', reason: err.message } };
  }
}

// ── POST /api/images/jobs ──────────────────────────────────────────
router.post(
  '/jobs',
  authenticateToken,
  requirePaidPlan({ feature: 'image_generation' }),
  chargeCredits({ feature: 'image_generation', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const parse = GenerateSchema.safeParse(req.body);
    if (!parse.success) {
      await refundLastCharge(req, 'invalid_payload');
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = parse.data;
    const charge = req._chargedCredits;
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
    // Drive the provider call inline. For real prod we'd push to BullMQ.
    const { row } = await runGenerationAndPersist(req, dbRow, data);
    res.status(201).json({ image: serializeImage(row), charge: charge ? { amount: String(charge.amount), transactionId: charge.txn?.id } : null });
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
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
  chargeCredits({ feature: 'image_variation', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const parse = VariationsSchema.safeParse(req.body);
    if (!parse.success) {
      await refundLastCharge(req, 'invalid_payload');
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const parent = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
    if (!parent || parent.userId !== req.user.id) {
      await refundLastCharge(req, 'parent_not_found');
      return res.status(404).json({ error: 'parent image not found' });
    }
    const charge = req._chargedCredits;
    const dbRow = await prisma.generatedImage.create({
      data: {
        userId: req.user.id,
        chatId: parent.chatId,
        prompt: parent.prompt,
        provider: parent.provider,
        model: parent.model,
        size: parent.size,
        n: parse.data.n,
        status: 'PENDING',
        costCredits: charge ? BigInt(charge.amount) : BigInt(0),
        kind: 'variation',
        parentImageId: parent.id,
      },
    });
    const { row } = await runGenerationAndPersist(req, dbRow, {
      prompt: parent.prompt,
      n: parse.data.n,
      size: parent.size,
      provider: parent.provider,
      model: parent.model,
    });
    res.status(201).json({ image: serializeImage(row) });
  },
);

// ── POST /api/images/:id/upscale ───────────────────────────────────
router.post(
  '/:id/upscale',
  authenticateToken,
  requirePaidPlan({ feature: 'image_upscale' }),
  chargeCredits({ feature: 'image_upscale', cost: imageCost(), allowFreeIaFallback: false }),
  async (req, res) => {
    const parse = UpscaleSchema.safeParse(req.body);
    if (!parse.success) {
      await refundLastCharge(req, 'invalid_payload');
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const parent = await prisma.generatedImage.findUnique({ where: { id: req.params.id } });
    if (!parent || parent.userId !== req.user.id) {
      await refundLastCharge(req, 'parent_not_found');
      return res.status(404).json({ error: 'parent image not found' });
    }
    const factor = parse.data.factor;
    const sizeMatch = (parent.size || '1024x1024').match(SIZE_RE);
    const newSize = sizeMatch
      ? `${Number(sizeMatch[1]) * factor}x${Number(sizeMatch[2]) * factor}`
      : parent.size;
    const charge = req._chargedCredits;
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
    const { row } = await runGenerationAndPersist(req, dbRow, {
      prompt: parent.prompt,
      n: 1,
      size: newSize,
      provider: parent.provider,
      model: parent.model,
    });
    res.status(201).json({ image: serializeImage(row) });
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
