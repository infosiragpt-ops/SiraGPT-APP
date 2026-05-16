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
  } catch (err) {
    console.error('[admin-connections-bridge] applyAdminConnections failed:', err.message);
  } finally {
    applying = false;
  }
}

module.exports = { applyAdminConnections, PROVIDER_ENV_MAP };
