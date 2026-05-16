'use strict';

/**
 * /api/admin/connections — CRUD for admin-curated upstream AI API
 * connections (OpenAI, Anthropic, Gemini, OpenRouter, custom, ...).
 *
 * Mounted under `/api/admin/connections` so the existing
 * `authenticateToken + requireAdmin` chain in `admin.js` does NOT
 * apply automatically. We re-apply it here at the router level so
 * the route file stays self-contained.
 *
 * The chat path (backend/src/routes/ai.js) still reads provider
 * credentials from env vars today. This module records the admin's
 * preferred upstream config but does not yet redirect provider
 * traffic to the DB-stored connection. That swap is a follow-up:
 * the connection row is the contract the swap will read from.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const prisma = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const { applyAdminConnections, reconcileCatalog } = require('../services/admin-connections-bridge');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

// Refresh the bridge after a write. Fire-and-forget — the response
// has already gone out; logging the failure is enough.
function refreshBridge() {
  applyAdminConnections().catch((e) =>
    console.error('[admin-connections] bridge refresh failed:', e.message)
  );
}

// API keys are stored encrypted at rest. The `enc:v1:` prefix is a
// version marker so future format changes (e.g. switching to GCM or
// rotating keys) can coexist with already-encrypted rows. The prefix
// also acts as a discriminator against legacy plaintext rows — real
// provider keys start with `sk-`, `sk-ant-`, etc., never `enc:v1:`.
const KEY_PREFIX = 'enc:v1:';

function encryptKey(plain) {
  if (!plain || typeof plain !== 'string') return null;
  if (plain.startsWith(KEY_PREFIX)) return plain; // idempotent
  return KEY_PREFIX + encrypt(plain);
}

function decryptKey(stored) {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith(KEY_PREFIX)) return stored; // legacy plaintext
  try {
    return decrypt(stored.slice(KEY_PREFIX.length));
  } catch (err) {
    console.error('[admin-connections] decryptKey failed:', err.message);
    return null;
  }
}

// Known provider keys — used to normalise UI grouping. The "custom"
// catch-all lets admins point at anything OpenAI-compatible (e.g.
// Ollama, LM Studio, vLLM) without us pre-blessing the URL.
const KNOWN_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'groq',
  'openrouter',
  'together',
  'fireworks',
  'deepseek',
  'xai',
  'custom',
]);

const DEFAULT_PROVIDER_LABELS = {
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini API',
  mistral: 'Mistral API',
  groq: 'Groq API',
  openrouter: 'OpenRouter API',
  together: 'Together AI API',
  fireworks: 'Fireworks AI API',
  deepseek: 'DeepSeek API',
  xai: 'xAI API',
  custom: 'Custom API',
};

/** Mask sensitive fields before returning a connection row to the client. */
function shapeConnection(c, { revealKey = false } = {}) {
  const plain = decryptKey(c.apiKey);
  return {
    id: c.id,
    url: c.url,
    providerKey: c.providerKey,
    providerLabel: c.providerLabel || DEFAULT_PROVIDER_LABELS[c.providerKey] || c.providerKey,
    apiKey: revealKey
      ? plain
      : (plain ? `${plain.slice(0, 4)}…${plain.slice(-4)}` : null),
    apiKeySet: !!c.apiKey,
    authType: c.authType,
    apiType: c.apiType,
    headers: c.headers || null,
    prefixId: c.prefixId,
    modelIds: c.modelIds || [],
    tags: c.tags || [],
    enabled: c.enabled,
    lastSyncedAt: c.lastSyncedAt,
    lastSyncOk: c.lastSyncOk,
    lastSyncError: c.lastSyncError,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ─── GET /api/admin/connections ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await prisma.adminConnection.findMany({
      orderBy: [{ providerKey: 'asc' }, { createdAt: 'asc' }],
    });
    const grouped = {};
    for (const r of rows) {
      const k = r.providerKey;
      if (!grouped[k]) {
        grouped[k] = {
          providerKey: k,
          providerLabel: DEFAULT_PROVIDER_LABELS[k] || k,
          // group enabled = any enabled row for this provider
          enabled: false,
          connections: [],
        };
      }
      const shaped = shapeConnection(r);
      grouped[k].connections.push(shaped);
      if (shaped.enabled) grouped[k].enabled = true;
    }
    res.json({ providers: Object.values(grouped), total: rows.length });
  } catch (err) {
    console.error('[admin-connections] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/connections ────────────────────────────────────
router.post(
  '/',
  [
    body('url').isURL({ require_tld: false, require_protocol: true }).withMessage('URL must be a full URL with protocol'),
    body('providerKey').isString().isLength({ min: 2, max: 40 }),
    body('apiKey').optional({ nullable: true }).isString().isLength({ min: 0, max: 400 }),
    body('authType').optional().isIn(['Bearer', 'None', 'Custom']),
    body('apiType').optional().isIn(['chat_completions', 'responses', 'embeddings']),
    body('headers').optional({ nullable: true }),
    body('prefixId').optional({ nullable: true }).isString().isLength({ max: 80 }),
    body('modelIds').optional().isArray(),
    body('tags').optional().isArray(),
    body('enabled').optional().isBoolean(),
    body('providerLabel').optional({ nullable: true }).isString().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      const providerKey = (req.body.providerKey || 'custom').toLowerCase().trim();
      const safeProvider = KNOWN_PROVIDERS.has(providerKey) ? providerKey : 'custom';
      const created = await prisma.adminConnection.create({
        data: {
          url: req.body.url.trim(),
          providerKey: safeProvider,
          providerLabel: req.body.providerLabel || DEFAULT_PROVIDER_LABELS[safeProvider] || null,
          apiKey: encryptKey(req.body.apiKey || null),
          authType: req.body.authType || 'Bearer',
          apiType: req.body.apiType || 'chat_completions',
          headers: req.body.headers || null,
          prefixId: req.body.prefixId || null,
          modelIds: Array.isArray(req.body.modelIds) ? req.body.modelIds : [],
          tags: Array.isArray(req.body.tags) ? req.body.tags : [],
          enabled: req.body.enabled !== false,
        },
      });
      res.status(201).json(shapeConnection(created));
      refreshBridge();
    } catch (err) {
      console.error('[admin-connections] create failed:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── PATCH /api/admin/connections/:id ───────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const allowed = ['url', 'providerKey', 'providerLabel', 'apiKey', 'authType', 'apiType', 'headers', 'prefixId', 'modelIds', 'tags', 'enabled'];
    const data = {};
    for (const k of allowed) {
      if (k in req.body) data[k] = req.body[k];
    }
    // Empty string apiKey means "do not change". Use `null` to clear.
    if (data.apiKey === '') delete data.apiKey;
    else if ('apiKey' in data) data.apiKey = encryptKey(data.apiKey);
    if (data.providerKey) {
      const lc = String(data.providerKey).toLowerCase().trim();
      data.providerKey = KNOWN_PROVIDERS.has(lc) ? lc : 'custom';
    }
    const updated = await prisma.adminConnection.update({
      where: { id },
      data,
    });
    res.json(shapeConnection(updated));
    refreshBridge();
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Connection not found' });
    }
    console.error('[admin-connections] update failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/admin/connections/:id ──────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await prisma.adminConnection.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
    refreshBridge();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Connection not found' });
    console.error('[admin-connections] delete failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/connections/health-check ───────────────────────
// Runs reconcileCatalog: probes every configured provider key, updates
// AiModel.isActive en masse, and writes lastSyncOk on each row. The
// panel calls this from the "Probar todas" button.
router.post('/health-check', async (req, res) => {
  try {
    const results = await reconcileCatalog();
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[admin-connections] health-check failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/admin/connections/:id/test ───────────────────────────
// Calls the upstream /models endpoint and stores the success/failure
// on the row. Returns the model list so the UI can preview.
router.post('/:id/test', async (req, res) => {
  let conn;
  try {
    conn = await prisma.adminConnection.findUnique({ where: { id: req.params.id } });
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const baseUrl = conn.url.replace(/\/+$/, '');
    const target = `${baseUrl}/models`;
    const headers = { 'Accept': 'application/json' };
    const plainKey = decryptKey(conn.apiKey);
    if (conn.authType === 'Bearer' && plainKey) headers['Authorization'] = `Bearer ${plainKey}`;
    if (conn.headers && typeof conn.headers === 'object') Object.assign(headers, conn.headers);

    const r = await fetch(target, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      await prisma.adminConnection.update({
        where: { id: conn.id },
        data: { lastSyncedAt: new Date(), lastSyncOk: false, lastSyncError: `HTTP ${r.status} ${txt.slice(0, 160)}` },
      });
      return res.status(502).json({ ok: false, status: r.status, error: txt.slice(0, 400) });
    }
    const body = await r.json();
    // OpenAI-shape: { data: [{ id, ... }] }. Anthropic-shape varies.
    const list = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
      : Array.isArray(body) ? body
      : [];
    await prisma.adminConnection.update({
      where: { id: conn.id },
      data: { lastSyncedAt: new Date(), lastSyncOk: true, lastSyncError: null },
    });
    res.json({ ok: true, count: list.length, models: list.slice(0, 200) });
  } catch (err) {
    console.error('[admin-connections] test failed:', err);
    try {
      if (conn) {
        await prisma.adminConnection.update({
          where: { id: conn.id },
          data: { lastSyncedAt: new Date(), lastSyncOk: false, lastSyncError: err.message.slice(0, 240) },
        });
      }
    } catch (_) { /* noop */ }
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
