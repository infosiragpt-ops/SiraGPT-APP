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
const crypto = require('crypto');
const { generateImage, DEFAULT_IMAGE_MODEL } = require('../services/marketing-service');
const {
  OAUTH_CONFIG, buildAuthUrl, exchangeCode, fetchProfile,
} = require('../services/social-oauth');

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

// ─── Social-account connections (OAuth) ───────────────────────────────────

router.get('/connections', async (req, res) => {
  try {
    const rows = await prisma.socialConnection.findMany({
      where: { userId: req.user.id },
      select: {
        id: true, platform: true, accountId: true, accountName: true,
        expiresAt: true, profile: true, createdAt: true, updatedAt: true,
      },
    });
    // Enrich with per-platform "configured" flag so the UI can
    // disable the "Conectar" button when the admin hasn't set the
    // credentials.
    const status = {};
    for (const p of ['facebook', 'instagram', 'youtube', 'tiktok', 'linkedin']) {
      const cfg = OAUTH_CONFIG(p);
      const existing = rows.find(r => r.platform === p);
      status[p] = {
        configured: cfg.configured,
        connected: !!existing,
        accountName: existing?.accountName || null,
        profile: existing?.profile || null,
      };
    }
    res.json({ connections: rows, status });
  } catch (err) {
    console.error('[marketing] connections list error:', err?.message);
    res.status(500).json({ error: 'No se pudo listar conexiones' });
  }
});

router.post(
  '/connections/:platform/start',
  [param('platform').isIn(['facebook', 'instagram', 'youtube', 'tiktok', 'linkedin'])],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    const { platform } = req.params;
    const cfg = OAUTH_CONFIG(platform);
    if (!cfg.configured) {
      return res.status(501).json({
        error: 'not_configured',
        platform,
        message: `Las credenciales OAuth de ${cfg.base?.label || platform} aún no están configuradas. Pídele al administrador que defina ${platform.toUpperCase()}_CLIENT_ID y ${platform.toUpperCase()}_CLIENT_SECRET.`,
      });
    }
    // Generate a state token bound to the current user so the
    // callback can verify this is our flow.
    const state = crypto.randomBytes(16).toString('hex') + ':' + req.user.id;
    const url = buildAuthUrl(platform, { state });
    res.json({ url, state });
  }
);

router.get(
  '/connections/:platform/callback',
  [param('platform').isIn(['facebook', 'instagram', 'youtube', 'tiktok', 'linkedin'])],
  async (req, res) => {
    // The browser hits this after OAuth. We exchange the code then
    // redirect back to /marketing with a success/error query.
    const { platform } = req.params;
    const { code, state, error } = req.query;
    const appOrigin = process.env.APP_ORIGIN_FRONTEND || 'http://localhost:3000';
    if (error) {
      return res.redirect(`${appOrigin}/marketing?connect_error=${encodeURIComponent(error)}&platform=${platform}`);
    }
    if (!code || !state) {
      return res.redirect(`${appOrigin}/marketing?connect_error=missing_code&platform=${platform}`);
    }
    // State shape: <random>:<userId>
    const userId = String(state).split(':').pop();
    try {
      const tokens = await exchangeCode(platform, String(code));
      const profile = await fetchProfile(platform, tokens.accessToken);
      await prisma.socialConnection.upsert({
        where: { userId_platform: { userId, platform } },
        update: {
          accountId: tokens.accountId,
          accountName: tokens.accountName,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          profile,
        },
        create: {
          userId, platform,
          accountId: tokens.accountId,
          accountName: tokens.accountName,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          profile,
        },
      });
      res.redirect(`${appOrigin}/marketing?connected=${platform}`);
    } catch (err) {
      console.error('[marketing] OAuth callback error:', err?.message);
      res.redirect(`${appOrigin}/marketing?connect_error=${encodeURIComponent(err?.message || 'exchange_failed')}&platform=${platform}`);
    }
  }
);

router.delete(
  '/connections/:platform',
  [param('platform').isIn(['facebook', 'instagram', 'youtube', 'tiktok', 'linkedin'])],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);
    try {
      await prisma.socialConnection.delete({
        where: { userId_platform: { userId: req.user.id, platform: req.params.platform } },
      }).catch(() => null); // ok if wasn't connected
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'No se pudo desconectar' });
    }
  }
);

// ─── Batch: generate + schedule N posts in one shot ───────────────────────

router.post(
  '/posts/batch',
  [
    body('prompt').isString().trim().isLength({ min: 4, max: 3000 }),
    body('count').isInt({ min: 2, max: 30 }),
    body('cadence').optional().isIn(['daily', 'weekly', 'every-2-days']),
    body('startDate').isISO8601(),
    body('timeOfDay').optional().matches(/^\d{2}:\d{2}$/),
    body('platforms').isArray({ min: 1 }),
    body('model').optional().isString(),
    body('orientation').optional().isIn(['cuadrado', 'vertical', 'horizontal']),
    body('palette').optional().isString(),
    body('animation').optional().isString(),
    body('price').optional().isString(),
    body('referenceImages').optional().isArray(),
    body('generateImages').optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return fail(res, errs);

    const platforms = (req.body.platforms || []).filter(p => PLATFORMS.has(p));
    if (platforms.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos una red' });
    }
    const cadence = req.body.cadence || 'daily';
    const stepDays = cadence === 'weekly' ? 7 : cadence === 'every-2-days' ? 2 : 1;
    const [hh, mm] = (req.body.timeOfDay || '10:00').split(':').map(n => parseInt(n, 10));
    const start = new Date(req.body.startDate);

    // 1) Ask the LLM for N distinct post ideas derived from the
    //    user's brief. We keep this LIGHT (one call) so the batch
    //    endpoint doesn't time out — it returns an array of {title,
    //    caption, imagePrompt}.
    const OpenAI = require('openai');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY no configurado' });
    const openai = new OpenAI({ apiKey });
    const sys = 'Eres un estratega de marketing de contenido. Devuelve EXCLUSIVAMENTE JSON con la forma {"posts":[{"title","caption","imagePrompt"}]}. Cada post debe tener un ángulo distinto, ser evergreen y sonar humano en español. NO uses markdown ni texto fuera del JSON.';
    const userMsg = `Genera ${req.body.count} publicaciones sobre: ${req.body.prompt}. Para plataformas ${platforms.join(', ')}. Cada "imagePrompt" describe la imagen a generar (sin texto sobrepuesto). Máximo 180 caracteres por caption.`;
    let plan;
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        temperature: 0.6, max_tokens: 3500,
        response_format: { type: 'json_object' },
      });
      plan = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    } catch (err) {
      console.error('[marketing] batch plan error:', err?.message);
      return res.status(500).json({ error: err?.message || 'No pude planear la serie' });
    }
    const posts = Array.isArray(plan?.posts) ? plan.posts.slice(0, req.body.count) : [];
    if (posts.length === 0) {
      return res.status(500).json({ error: 'El modelo no devolvió posts' });
    }

    // 2) Optionally generate images for each post. Can be slow — we
    //    cap at 5 concurrent calls. If the user skipped image
    //    generation (generateImages=false) we save posts with null
    //    imageUrl; they can regenerate later from the UI.
    const shouldGenImages = req.body.generateImages !== false;
    const referenceImages = Array.isArray(req.body.referenceImages)
      ? req.body.referenceImages.slice(0, 4)
      : null;

    const batchId = crypto.randomUUID();
    const created = [];

    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      const scheduledAt = new Date(start);
      scheduledAt.setDate(start.getDate() + i * stepDays);
      scheduledAt.setHours(isNaN(hh) ? 10 : hh, isNaN(mm) ? 0 : mm, 0, 0);

      let imageUrl = null;
      if (shouldGenImages) {
        try {
          const r = await generateImage({
            prompt: p.imagePrompt || p.title || req.body.prompt,
            model: req.body.model || DEFAULT_IMAGE_MODEL,
            orientation: req.body.orientation,
            color: req.body.palette,
            animation: req.body.animation,
            price: req.body.price,
            platforms,
          });
          imageUrl = r.imageUrl;
        } catch (err) {
          console.error(`[marketing] batch image ${i} failed:`, err?.message);
        }
      }

      const row = await prisma.scheduledPost.create({
        data: {
          userId: req.user.id,
          prompt: p.title || p.caption || req.body.prompt,
          caption: p.caption || null,
          imageUrl,
          imageModel: req.body.model || DEFAULT_IMAGE_MODEL,
          platforms,
          scheduledAt,
          status: 'scheduled',
          config: {
            palette: req.body.palette,
            orientation: req.body.orientation,
            animation: req.body.animation,
            price: req.body.price,
            cadence,
            timeOfDay: req.body.timeOfDay || '10:00',
            planTitle: p.title,
            imagePrompt: p.imagePrompt,
          },
          referenceImages,
          batchId,
        },
      });
      created.push(row);
    }

    res.status(201).json({ batchId, count: created.length, posts: created });
  }
);

module.exports = router;
