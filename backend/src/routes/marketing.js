/**
 * /api/marketing — intelligent agent that schedules social posts.
 *
 * Endpoints (all auth-protected):
 *   POST /generate-image  → { imageUrl, model, prompt, size }
 *   POST /posts           → schedule / save (201 with the row)
 *   GET  /posts           → list the user's posts (most recent first)
 *   GET  /posts/:id       → one post
 *   PATCH /posts/:id      → edit / reschedule / cancel
 *   DELETE /posts/:id     → remove
 *
 * Real distribution to Facebook / Instagram / YouTube / TikTok /
 * LinkedIn is out of scope for this iteration — each platform's
 * OAuth + publishing quirks need their own connector. We persist
 * everything the user would need so a future worker can pick
 * scheduled rows up and publish them.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { generateImage, DEFAULT_IMAGE_MODEL } = require('../services/marketing-service');

const router = express.Router();
router.use(authenticateToken);

const PLATFORMS = new Set(['facebook', 'instagram', 'youtube', 'tiktok', 'linkedin']);
const STATUSES = new Set(['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled']);

function fail(res, errors) {
  return res.status(400).json({ errors: errors.array() });
}

// ─── Image generation ─────────────────────────────────────────────────────

router.post(
  '/generate-image',
  [
    body('prompt').isString().trim().isLength({ min: 3, max: 3000 }),
    body('model').optional().isString(),
    body('orientation').optional().isIn(['cuadrado', 'vertical', 'horizontal']),
    body('color').optional().isString(),
    body('animation').optional().isString(),
    body('price').optional().isString(),
    body('platforms').optional().isArray(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);

    try {
      const result = await generateImage({
        prompt: req.body.prompt,
        model: req.body.model || DEFAULT_IMAGE_MODEL,
        orientation: req.body.orientation,
        color: req.body.color,
        animation: req.body.animation,
        price: req.body.price,
        platforms: (req.body.platforms || []).filter(p => PLATFORMS.has(p)),
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[marketing] image gen error:', err?.message || err);
      res.status(500).json({ error: err?.message || 'Error generando imagen' });
    }
  }
);

// ─── Scheduled-post CRUD ──────────────────────────────────────────────────

router.post(
  '/posts',
  [
    body('prompt').isString().trim().isLength({ min: 3, max: 3000 }),
    body('caption').optional().isString().isLength({ max: 5000 }),
    body('imageUrl').optional().isString().isLength({ max: 4_000_000 }), // data-URL allowed
    body('imageModel').optional().isString(),
    body('platforms').isArray({ min: 1 }),
    body('scheduledAt').optional({ nullable: true }).isISO8601(),
    body('status').optional().isIn([...STATUSES]),
    body('config').optional().isObject(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    const platforms = (req.body.platforms || []).filter(p => PLATFORMS.has(p));
    if (platforms.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos una red social válida' });
    }
    const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    const status = req.body.status
      || (scheduledAt ? 'scheduled' : 'draft');

    try {
      const post = await prisma.scheduledPost.create({
        data: {
          userId: req.user.id,
          prompt: req.body.prompt,
          caption: req.body.caption || null,
          imageUrl: req.body.imageUrl || null,
          imageModel: req.body.imageModel || DEFAULT_IMAGE_MODEL,
          platforms,
          scheduledAt,
          status,
          config: req.body.config || null,
        },
      });
      res.status(201).json({ post });
    } catch (err) {
      console.error('[marketing] create post error:', err?.message);
      res.status(500).json({ error: 'No se pudo guardar el post' });
    }
  }
);

router.get('/posts', async (req, res) => {
  try {
    const posts = await prisma.scheduledPost.findMany({
      where: { userId: req.user.id },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      // The imageUrl can be a huge data URL. We strip it from the list
      // response to keep the payload small; callers can GET /:id to
      // fetch a single post with its image.
      select: {
        id: true, prompt: true, caption: true, imageModel: true,
        platforms: true, scheduledAt: true, status: true,
        publishedAt: true, lastError: true,
        createdAt: true, updatedAt: true,
        imageUrl: true,     // still send it — the UI wants thumbnails
      },
    });
    res.json({ posts });
  } catch (err) {
    console.error('[marketing] list posts error:', err?.message);
    res.status(500).json({ error: 'No se pudo listar los posts' });
  }
});

router.get(
  '/posts/:id',
  [param('id').isString().notEmpty()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    try {
      const post = await prisma.scheduledPost.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!post) return res.status(404).json({ error: 'Post no encontrado' });
      res.json({ post });
    } catch (err) {
      console.error('[marketing] get post error:', err?.message);
      res.status(500).json({ error: 'No se pudo obtener el post' });
    }
  }
);

router.patch(
  '/posts/:id',
  [
    param('id').isString().notEmpty(),
    body('prompt').optional().isString().trim(),
    body('caption').optional({ nullable: true }).isString(),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('imageModel').optional().isString(),
    body('platforms').optional().isArray(),
    body('scheduledAt').optional({ nullable: true }).isISO8601(),
    body('status').optional().isIn([...STATUSES]),
    body('config').optional({ nullable: true }).isObject(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    try {
      const existing = await prisma.scheduledPost.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!existing) return res.status(404).json({ error: 'Post no encontrado' });

      const data = {};
      if (req.body.prompt !== undefined) data.prompt = req.body.prompt;
      if (req.body.caption !== undefined) data.caption = req.body.caption;
      if (req.body.imageUrl !== undefined) data.imageUrl = req.body.imageUrl;
      if (req.body.imageModel !== undefined) data.imageModel = req.body.imageModel;
      if (req.body.platforms !== undefined) {
        const p = (req.body.platforms || []).filter(pl => PLATFORMS.has(pl));
        data.platforms = p;
      }
      if (req.body.scheduledAt !== undefined) {
        data.scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
      }
      if (req.body.status !== undefined) data.status = req.body.status;
      if (req.body.config !== undefined) data.config = req.body.config;

      const post = await prisma.scheduledPost.update({
        where: { id: existing.id },
        data,
      });
      res.json({ post });
    } catch (err) {
      console.error('[marketing] update post error:', err?.message);
      res.status(500).json({ error: 'No se pudo actualizar el post' });
    }
  }
);

router.delete(
  '/posts/:id',
  [param('id').isString().notEmpty()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    try {
      const existing = await prisma.scheduledPost.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!existing) return res.status(404).json({ error: 'Post no encontrado' });
      await prisma.scheduledPost.delete({ where: { id: existing.id } });
      res.json({ success: true });
    } catch (err) {
      console.error('[marketing] delete post error:', err?.message);
      res.status(500).json({ error: 'No se pudo eliminar el post' });
    }
  }
);

module.exports = router;
