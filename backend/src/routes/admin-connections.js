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
 * The bridge applies enabled provider credentials into process.env so
 * runtime paths can pick up admin-managed keys without a server restart.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const prisma = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const { applyAdminConnections, reconcileCatalog } = require('../services/admin-connections-bridge');
const modelSyncService = require('../services/model-sync-service');
const { invalidate: invalidateResponseCache } = require('../middleware/response-cache');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

// Refresh the bridge after a write. Fire-and-forget — the response
// has already gone out; logging the failure is enough.
function refreshBridge() {
  applyAdminConnections().catch((e) =>
    console.error('[admin-connections] bridge refresh failed:', e.message)
  );
}

// Guards against overlapping discoveries for the same connection (rapid
// double-saves) — upserts are idempotent so it's only wasted work, but the
// guard keeps a single in-flight run per connection.
const _discoveryInFlight = new Set();

// Auto-discover the provider's models the moment a key is set and persist
// them (inactive) into the AiModel catalog, so they appear in Admin → Modelos
// without the manual Fetch/Sync dance. Fire-and-forget — never blocks the
// response, never throws. The connection row records the sync verdict.
async function discoverConnectionModels(connId) {
  if (_discoveryInFlight.has(connId)) return;
  _discoveryInFlight.add(connId);
  try {
    const conn = await prisma.adminConnection.findUnique({ where: { id: connId } });
    if (!conn || !conn.enabled) return;
    const apiKey = decryptKey(conn.apiKey);
    if (!apiKey && conn.authType !== 'None') return;

    const result = await modelSyncService.syncConnectionModels({
      providerKey: conn.providerKey,
      providerLabel: conn.providerLabel,
      url: conn.url,
      authType: conn.authType,
      headers: conn.headers,
      modelIds: conn.modelIds,
      apiKey,
    });

    await prisma.adminConnection.update({
      where: { id: conn.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncOk: !!result.ok,
        lastSyncError: result.ok ? null : String(result.error || 'discovery failed').slice(0, 240),
      },
    }).catch(() => {});

    if (result.ok && (result.created || result.updated)) {
      invalidateResponseCache({ namespace: 'ai-models' });
      console.log(`[admin-connections] discovered ${conn.providerKey}: +${result.created} new, ${result.updated} updated`);
    }
  } catch (e) {
    console.error('[admin-connections] discoverConnectionModels failed:', e.message);
  } finally {
    _discoveryInFlight.delete(connId);
  }
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
  'cerebras',
  'zai',
  'kimi',
  'together',
  'fireworks',
  'deepseek',
  'xai',
  'fal',
  'custom',
]);

const DEFAULT_PROVIDER_LABELS = {
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini API',
  mistral: 'Mistral API',
  groq: 'Groq API',
  openrouter: 'OpenRouter API',
  cerebras: 'Cerebras API',
  zai: 'Z.ai (GLM) API',
  kimi: 'Kimi (Moonshot) API',
  together: 'Together AI API',
  fireworks: 'Fireworks AI API',
  deepseek: 'DeepSeek API',
  xai: 'xAI API',
  fal: 'fal.ai Video API',
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
    body('authType').optional().isIn(['Bearer', 'Key', 'None', 'Custom']),
    body('apiType').optional().isIn(['chat_completions', 'responses', 'embeddings', 'video']),
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
          authType: req.body.authType || (safeProvider === 'fal' ? 'Key' : 'Bearer'),
          apiType: req.body.apiType || (safeProvider === 'fal' ? 'video' : 'chat_completions'),
          headers: req.body.headers || null,
          prefixId: req.body.prefixId || null,
          modelIds: Array.isArray(req.body.modelIds) ? req.body.modelIds : [],
          tags: Array.isArray(req.body.tags) ? req.body.tags : [],
          enabled: req.body.enabled !== false,
        },
      });
      res.status(201).json(shapeConnection(created));
      refreshBridge();
      // Auto-populate Admin → Modelos with this provider's models.
      if (created.enabled && created.apiKey) discoverConnectionModels(created.id);
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
    // Read the prior enabled state so we only re-discover on a real off→on
    // transition — not on every save that happens to echo `enabled: true`.
    const prior = await prisma.adminConnection.findUnique({
      where: { id },
      select: { enabled: true },
    });
    const updated = await prisma.adminConnection.update({
      where: { id },
      data,
    });
    res.json(shapeConnection(updated));
    refreshBridge();
    // Re-discover models only when the key or URL actually changed, or the
    // connection was just turned on — a plain toggle, re-save or tag edit
    // must not hit the upstream.
    const keyOrUrlChanged = ('apiKey' in data) || ('url' in data);
    const justEnabled = data.enabled === true && prior && prior.enabled === false;
    if (updated.enabled && updated.apiKey && (keyOrUrlChanged || justEnabled)) {
      discoverConnectionModels(updated.id);
    }
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
    // Deleting a provider's connection can change which models are available,
    // so drop the cached ai-models response (mirrors create/patch/sync paths).
    invalidateResponseCache({ namespace: 'ai-models' });
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

    // Provider-agnostic discovery (handles Anthropic x-api-key auth too) that
    // ALSO persists the models into the catalog — testing a connection now
    // populates Admin → Modelos in one click.
    const result = await modelSyncService.syncConnectionModels({
      providerKey: conn.providerKey,
      providerLabel: conn.providerLabel,
      url: conn.url,
      authType: conn.authType,
      headers: conn.headers,
      modelIds: conn.modelIds,
      apiKey: decryptKey(conn.apiKey),
    });

    await prisma.adminConnection.update({
      where: { id: conn.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncOk: !!result.ok,
        lastSyncError: result.ok ? null : String(result.error || 'probe failed').slice(0, 240),
      },
    }).catch(() => {});

    if (!result.ok) {
      return res.status(502).json({ ok: false, status: result.status || 0, error: String(result.error || 'probe failed').slice(0, 400) });
    }

    if (result.created || result.updated) invalidateResponseCache({ namespace: 'ai-models' });

    res.json({
      ok: true,
      count: result.count,
      imported: result.created + result.updated,
      created: result.created,
      updated: result.updated,
      models: (result.models || []).slice(0, 200).map((m) => ({
        id: m.name, name: m.name, displayName: m.displayName, type: m.type, provider: m.provider,
      })),
    });
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
