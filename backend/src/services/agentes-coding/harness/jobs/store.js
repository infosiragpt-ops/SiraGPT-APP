'use strict';

/**
 * Durable harness-run store (Phase 4c).
 *
 * Default is an in-memory Map (CI / injectable). Redis is optional and
 * only constructed when a client or REDIS_URL is handed in. No Prisma
 * table — job snapshots live next to the session jail, not in the
 * document-sandbox outbox.
 */

const { fail } = require('../../coding-sandbox/errors');

const KEY_PREFIX = 'agentes-coding:harness:';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUNS_PER_SESSION = 16;

function runKey(runId) {
  return `${KEY_PREFIX}run:${runId}`;
}

function sessionKey(sessionId) {
  return `${KEY_PREFIX}session:${sessionId}`;
}

function cloneSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return JSON.parse(JSON.stringify(snapshot));
}

function createMemoryRunStore() {
  const byId = new Map();
  const bySession = new Map();

  function sessionSet(sessionId) {
    const id = String(sessionId || '');
    if (!bySession.has(id)) bySession.set(id, []);
    return bySession.get(id);
  }

  return {
    kind: 'memory',
    async save(snapshot) {
      if (!snapshot || !snapshot.id || !snapshot.sessionId) {
        fail('E_PARAMS', 'Falta el snapshot del turno del harness.');
      }
      const copy = cloneSnapshot(snapshot);
      byId.set(copy.id, copy);
      const list = sessionSet(copy.sessionId);
      const idx = list.indexOf(copy.id);
      if (idx === -1) list.push(copy.id);
      if (list.length > MAX_RUNS_PER_SESSION) {
        const dropped = list.splice(0, list.length - MAX_RUNS_PER_SESSION);
        for (const id of dropped) byId.delete(id);
      }
      return cloneSnapshot(copy);
    },
    async get(runId) {
      const id = String(runId || '').trim();
      if (!id) return null;
      return cloneSnapshot(byId.get(id) || null);
    },
    async list(sessionId) {
      const ids = sessionSet(sessionId);
      return ids.map((id) => cloneSnapshot(byId.get(id))).filter(Boolean);
    },
    async remove(runId) {
      const snap = byId.get(String(runId || ''));
      if (!snap) return false;
      byId.delete(snap.id);
      const list = sessionSet(snap.sessionId);
      const idx = list.indexOf(snap.id);
      if (idx >= 0) list.splice(idx, 1);
      return true;
    },
    async forgetSession(sessionId) {
      const list = sessionSet(sessionId);
      for (const id of list) byId.delete(id);
      bySession.delete(String(sessionId || ''));
    },
  };
}

function createRedisRunStore(redis, opts = {}) {
  if (!redis || typeof redis.get !== 'function' || typeof redis.set !== 'function') {
    fail('E_PARAMS', 'Falta el cliente Redis del store del harness.');
  }
  const ttl = Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0
    ? Math.floor(opts.ttlSeconds)
    : DEFAULT_TTL_SECONDS;

  async function readIds(sessionId) {
    if (typeof redis.smembers === 'function') {
      const raw = await redis.smembers(sessionKey(sessionId));
      return Array.isArray(raw) ? raw.map(String) : [];
    }
    const packed = await redis.get(sessionKey(sessionId));
    if (!packed) return [];
    try {
      const parsed = JSON.parse(packed);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  async function writeIds(sessionId, ids) {
    const trimmed = ids.slice(-MAX_RUNS_PER_SESSION);
    if (typeof redis.del === 'function') await redis.del(sessionKey(sessionId));
    if (typeof redis.sadd === 'function') {
      if (trimmed.length) await redis.sadd(sessionKey(sessionId), ...trimmed);
      if (typeof redis.expire === 'function') await redis.expire(sessionKey(sessionId), ttl);
      return;
    }
    await redis.set(sessionKey(sessionId), JSON.stringify(trimmed), 'EX', ttl);
  }

  return {
    kind: 'redis',
    async save(snapshot) {
      if (!snapshot || !snapshot.id || !snapshot.sessionId) {
        fail('E_PARAMS', 'Falta el snapshot del turno del harness.');
      }
      const copy = cloneSnapshot(snapshot);
      await redis.set(runKey(copy.id), JSON.stringify(copy), 'EX', ttl);
      const ids = await readIds(copy.sessionId);
      if (!ids.includes(copy.id)) ids.push(copy.id);
      const dropped = ids.length > MAX_RUNS_PER_SESSION
        ? ids.splice(0, ids.length - MAX_RUNS_PER_SESSION)
        : [];
      for (const id of dropped) {
        if (typeof redis.del === 'function') await redis.del(runKey(id));
      }
      await writeIds(copy.sessionId, ids);
      return copy;
    },
    async get(runId) {
      const id = String(runId || '').trim();
      if (!id) return null;
      const raw = await redis.get(runKey(id));
      if (!raw) return null;
      try {
        return cloneSnapshot(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async list(sessionId) {
      const ids = await readIds(sessionId);
      const out = [];
      for (const id of ids) {
        const snap = await this.get(id);
        if (snap) out.push(snap);
      }
      return out;
    },
    async remove(runId) {
      const snap = await this.get(runId);
      if (!snap) return false;
      if (typeof redis.del === 'function') await redis.del(runKey(snap.id));
      const ids = (await readIds(snap.sessionId)).filter((id) => id !== snap.id);
      await writeIds(snap.sessionId, ids);
      return true;
    },
    async forgetSession(sessionId) {
      const ids = await readIds(sessionId);
      for (const id of ids) {
        if (typeof redis.del === 'function') await redis.del(runKey(id));
      }
      if (typeof redis.del === 'function') await redis.del(sessionKey(sessionId));
    },
  };
}

function createRunStore(opts = {}) {
  if (opts.store && typeof opts.store.save === 'function') return opts.store;
  if (opts.redis) return createRedisRunStore(opts.redis, opts);
  return createMemoryRunStore();
}

module.exports = {
  KEY_PREFIX,
  DEFAULT_TTL_SECONDS,
  MAX_RUNS_PER_SESSION,
  createMemoryRunStore,
  createRedisRunStore,
  createRunStore,
};
