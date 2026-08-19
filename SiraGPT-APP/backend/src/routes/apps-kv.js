'use strict';

/**
 * /api/apps-kv — persistent key-value store for GENERATED apps (SiraGPT Apps).
 *
 * Apps built by the /code agent run unauthenticated inside the preview and have
 * no backend of their own. This tiny public store lets them persist real data —
 * journals, trackers, leaderboards, saved settings — via the starter's
 * `src/lib/storage.ts` helper. Two scopes per app:
 *   · personal → ownerKey is a per-device uid the app keeps in localStorage
 *   · shared   → ownerKey is '_shared' (all visitors of the app)
 *
 * Safety posture (public endpoint, zero auth by design — same as /api/apps-ai):
 *   - Per-IP sliding-window rate limit.
 *   - Hard caps: value size, key/owner/namespace lengths, keys-per-owner.
 *   - `namespace` isolates one app's data; it is a loose bucket, not a secret,
 *     so this is a low-stakes shared store — never put anything sensitive here.
 *   - Prisma is injectable for offline tests.
 */

const express = require('express');
const { slidingWindowRateLimitMiddleware } = require('../utils/sliding-window-rate-limiter');

const MAX_VALUE_BYTES = 100 * 1024; // 100 KB per entry
const MAX_KEY_LEN = 200;
const MAX_OWNER_LEN = 128;
const MAX_NAMESPACE_LEN = 128;
const MAX_KEYS_PER_OWNER = 500;
const SEGMENT_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function defaultPrisma() {
  try { return require('../config/database'); } catch { return null; }
}

function validSegment(v, max) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && SEGMENT_RE.test(v);
}

/**
 * @param {object} [deps] injectable for offline tests: { prisma, env }
 */
function buildAppsKvRouter(deps = {}) {
  const env = deps.env || process.env;
  // Respect an explicit prisma (even `null`, for the unconfigured-store test);
  // only fall back to the real client when the key is absent. `|| defaultPrisma`
  // would defeat a `null` and try to dial the real DB.
  const prisma = Object.prototype.hasOwnProperty.call(deps, 'prisma') ? deps.prisma : defaultPrisma();
  const router = express.Router();

  router.use(
    slidingWindowRateLimitMiddleware({
      windowMs: 60_000,
      max: Number(env.APPS_KV_RATE_LIMIT_PER_MIN) || 120,
      identifier: (req) => `apps-kv:${req.ip || 'anon'}`,
    }),
  );

  router.get('/health', (_req, res) => {
    res.json({ ok: true, configured: Boolean(prisma && prisma.appKvEntry) });
  });

  // Guard shared by every data route: validate path segments + store availability.
  function resolve(req, res) {
    if (!prisma || !prisma.appKvEntry) {
      res.status(503).json({ ok: false, error: 'kv_unavailable' });
      return null;
    }
    const namespace = String(req.params.namespace || '');
    const owner = String(req.params.owner || '');
    if (!validSegment(namespace, MAX_NAMESPACE_LEN) || !validSegment(owner, MAX_OWNER_LEN)) {
      res.status(400).json({ ok: false, error: 'invalid_scope' });
      return null;
    }
    return { namespace, owner };
  }

  // List keys for an owner (kept small: keys + updatedAt, not values — a
  // tracker lists items then fetches each; avoids dumping a huge payload).
  router.get('/:namespace/:owner', async (req, res) => {
    const ctx = resolve(req, res);
    if (!ctx) return undefined;
    try {
      const rows = await prisma.appKvEntry.findMany({
        where: { namespace: ctx.namespace, ownerKey: ctx.owner },
        select: { key: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_KEYS_PER_OWNER,
      });
      return res.json({ ok: true, keys: rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'kv_error', message: String(err?.message || err).slice(0, 200) });
    }
  });

  router.get('/:namespace/:owner/:key', async (req, res) => {
    const ctx = resolve(req, res);
    if (!ctx) return undefined;
    if (!validSegment(String(req.params.key || ''), MAX_KEY_LEN)) {
      return res.status(400).json({ ok: false, error: 'invalid_key' });
    }
    try {
      const row = await prisma.appKvEntry.findUnique({
        where: { namespace_ownerKey_key: { namespace: ctx.namespace, ownerKey: ctx.owner, key: req.params.key } },
      });
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true, value: parseValue(row.value), updatedAt: row.updatedAt });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'kv_error', message: String(err?.message || err).slice(0, 200) });
    }
  });

  router.put('/:namespace/:owner/:key', async (req, res) => {
    const ctx = resolve(req, res);
    if (!ctx) return undefined;
    if (!validSegment(String(req.params.key || ''), MAX_KEY_LEN)) {
      return res.status(400).json({ ok: false, error: 'invalid_key' });
    }
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'value')) {
      return res.status(400).json({ ok: false, error: 'value_required' });
    }
    let serialized;
    try {
      serialized = JSON.stringify(req.body.value);
    } catch {
      return res.status(400).json({ ok: false, error: 'value_not_serializable' });
    }
    if (serialized === undefined) serialized = 'null';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
      return res.status(413).json({ ok: false, error: 'value_too_large' });
    }
    try {
      const existing = await prisma.appKvEntry.findUnique({
        where: { namespace_ownerKey_key: { namespace: ctx.namespace, ownerKey: ctx.owner, key: req.params.key } },
        select: { id: true },
      });
      // Per-owner key cap: only enforced when creating a NEW key so updates to
      // existing keys never get locked out once at the ceiling.
      if (!existing) {
        const count = await prisma.appKvEntry.count({ where: { namespace: ctx.namespace, ownerKey: ctx.owner } });
        if (count >= MAX_KEYS_PER_OWNER) {
          return res.status(429).json({ ok: false, error: 'too_many_keys' });
        }
      }
      const row = await prisma.appKvEntry.upsert({
        where: { namespace_ownerKey_key: { namespace: ctx.namespace, ownerKey: ctx.owner, key: req.params.key } },
        create: { namespace: ctx.namespace, ownerKey: ctx.owner, key: req.params.key, value: serialized },
        update: { value: serialized },
      });
      return res.json({ ok: true, updatedAt: row.updatedAt });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'kv_error', message: String(err?.message || err).slice(0, 200) });
    }
  });

  router.delete('/:namespace/:owner/:key', async (req, res) => {
    const ctx = resolve(req, res);
    if (!ctx) return undefined;
    if (!validSegment(String(req.params.key || ''), MAX_KEY_LEN)) {
      return res.status(400).json({ ok: false, error: 'invalid_key' });
    }
    try {
      await prisma.appKvEntry.deleteMany({
        where: { namespace: ctx.namespace, ownerKey: ctx.owner, key: req.params.key },
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'kv_error', message: String(err?.message || err).slice(0, 200) });
    }
  });

  return router;
}

function parseValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

module.exports = {
  buildAppsKvRouter,
  validSegment,
  MAX_VALUE_BYTES,
  MAX_KEYS_PER_OWNER,
  MAX_KEY_LEN,
};
