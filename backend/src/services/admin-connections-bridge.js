'use strict';

/**
 * admin-connections-bridge — feeds the chat path with API keys
 * configured via /admin/connections without refactoring the
 * provider-routing layer.
 *
 * Strategy: at boot, and after any write to `admin_connections`,
 * the most-recent enabled row per providerKey wins. Its decrypted
 * apiKey is written into `process.env.<PROVIDER>_API_KEY`,
 * overriding whatever the .env file shipped. If no enabled row
 * exists for a provider, the original .env value is restored.
 *
 * Why mutate process.env? The chat path reads provider keys lazily
 * (`process.env.OPENAI_API_KEY` per request), so a runtime swap is
 * picked up immediately on the next call — no PM2 restart needed,
 * no refactor of the 6+ `createProviderClient` call sites.
 *
 * Constraints:
 *   - cluster-mode (PM2 SCALE=true) only updates the worker that
 *     handled the write; other workers stay stale until reload.
 *     The deployment is single-instance today, so this is fine.
 *     A follow-up could broadcast via Redis pub/sub.
 *   - admin_connections.apiKey is stored with the `enc:v1:` prefix
 *     plus an AES-256-CBC ciphertext from utils/encryption.js.
 */

const prisma = require('../config/database');
const { decrypt } = require('../utils/encryption');

const PROVIDER_ENV_MAP = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
});

// providerKey (lowercase, panel form) → provider value in AiModel.provider column
const PROVIDER_CATALOG_MAP = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  mistral: 'Mistral',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  together: 'Together',
  fireworks: 'Fireworks',
});

// providerKey → { url, authHeader: (key) => headers }
const PROVIDER_PROBE = Object.freeze({
  openai:     { url: 'https://api.openai.com/v1/models',                            auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  anthropic:  { url: 'https://api.anthropic.com/v1/models',                         auth: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  mistral:    { url: 'https://api.mistral.ai/v1/models',                            auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  groq:       { url: 'https://api.groq.com/openai/v1/models',                       auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  openrouter: { url: 'https://openrouter.ai/api/v1/auth/key',                       auth: (k) => ({ Authorization: `Bearer ${k}` }) }, // /auth/key requires valid user
  deepseek:   { url: 'https://api.deepseek.com/v1/models',                          auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  xai:        { url: 'https://api.x.ai/v1/models',                                  auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  together:   { url: 'https://api.together.xyz/v1/models',                          auth: (k) => ({ Authorization: `Bearer ${k}` }) },
  fireworks:  { url: 'https://api.fireworks.ai/inference/v1/models',                auth: (k) => ({ Authorization: `Bearer ${k}` }) },
});

const KEY_PREFIX = 'enc:v1:';

function unwrap(stored) {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith(KEY_PREFIX)) return stored;
  try {
    return decrypt(stored.slice(KEY_PREFIX.length));
  } catch (err) {
    console.error('[admin-connections-bridge] decrypt failed:', err.message);
    return null;
  }
}

// Snapshot of the original .env values so we can restore when an
// admin connection is removed/disabled. Captured once, on first apply.
const envSnapshot = {};
let snapshotCaptured = false;

function captureSnapshotOnce() {
  if (snapshotCaptured) return;
  for (const env of Object.values(PROVIDER_ENV_MAP)) {
    envSnapshot[env] = process.env[env] || '';
  }
  snapshotCaptured = true;
}

let applying = false; // simple re-entrancy guard for concurrent calls

async function applyAdminConnections() {
  if (applying) return;
  applying = true;
  try {
    captureSnapshotOnce();

    const rows = await prisma.adminConnection.findMany({
      where: { enabled: true, apiKey: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { providerKey: true, apiKey: true, updatedAt: true },
    });

    // First (most recent) enabled row per provider wins.
    const winners = new Map();
    for (const r of rows) {
      if (!winners.has(r.providerKey)) winners.set(r.providerKey, r);
    }

    const applied = [];
    const restored = [];
    for (const [providerKey, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
      const winner = winners.get(providerKey);
      if (winner) {
        const plain = unwrap(winner.apiKey);
        if (plain) {
          process.env[envVar] = plain;
          applied.push(providerKey);
          continue;
        }
      }
      // No winner — restore original .env value if it changed.
      if (process.env[envVar] !== envSnapshot[envVar]) {
        process.env[envVar] = envSnapshot[envVar];
        restored.push(providerKey);
      }
    }

    if (applied.length || restored.length) {
      console.log(
        '[admin-connections-bridge] applied:',
        applied.join(',') || 'none',
        '· restored:',
        restored.join(',') || 'none'
      );
    }

    // Fire-and-forget provider health reconciliation. This intentionally
    // does not change AiModel.isActive; admins control availability from
    // /admin/models after each sync.
    await reconcileCatalog().catch((e) =>
      console.error('[admin-connections-bridge] reconcileCatalog failed:', e.message)
    );
  } catch (err) {
    console.error('[admin-connections-bridge] applyAdminConnections failed:', err.message);
  } finally {
    applying = false;
  }
}

async function probeKey(providerKey, apiKey) {
  const spec = PROVIDER_PROBE[providerKey];
  if (!spec || !apiKey) return false;
  try {
    const res = await fetch(spec.url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...spec.auth(apiKey) },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * For each provider whose env var is set (either from .env or from a
 * panel row), probe the upstream /models endpoint.
 *
 * Updates the connection row's lastSyncedAt/lastSyncOk so the panel
 * can show a green/red dot per connection without an extra round-trip.
 * AiModel.isActive is never changed here; model availability is an
 * explicit admin choice.
 */
async function reconcileCatalog() {
  const prisma = require('../config/database');
  const results = {};
  for (const [providerKey, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    const key = process.env[envVar];
    if (!key) {
      results[providerKey] = { healthy: false, reason: 'no_key' };
      continue;
    }
    results[providerKey] = { healthy: await probeKey(providerKey, key), reason: 'probed' };
  }

  // Mirror to admin_connections rows so the panel sees the health.
  const conns = await prisma.adminConnection.findMany({ select: { id: true, providerKey: true } });
  for (const c of conns) {
    const r = results[c.providerKey];
    if (!r) continue;
    await prisma.adminConnection.update({
      where: { id: c.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncOk: !!r.healthy,
        lastSyncError: r.healthy ? null : (r.reason === 'no_key' ? 'no key configured' : 'upstream probe failed'),
      },
    }).catch(() => {});
  }

  return results;
}

module.exports = { applyAdminConnections, reconcileCatalog, PROVIDER_ENV_MAP, PROVIDER_CATALOG_MAP };
