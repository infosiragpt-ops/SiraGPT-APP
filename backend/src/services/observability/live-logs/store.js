'use strict';

/**
 * live-logs/store — where captured log events live.
 *
 *   ring buffer (always)   last N events in memory → instant live backfill
 *   Redis streams (local)  siragpt:logs:all  capped (~hours of history)
 *                          siragpt:logs:err  warn+ only, ~7 days
 *                          siragpt:logs:req:<reqId>  ids of one request's lines
 *
 * Invariants:
 *   - push() is synchronous, O(1) and never throws: a log call must never slow
 *     down or break a request. Redis writes are batched on a timer.
 *   - Redis is shared with BullMQ (noeviction policy): a memory guard pauses
 *     log persistence well before the log keys could crowd out the queues.
 *   - Bursts of the same line within a few seconds collapse into one event
 *     with a `repeat` counter (a ReplyError storm is one row, not a thousand).
 */

const { EventEmitter } = require('events');
const { levelRank, LEVEL_RANK } = require('./classify');

const DEFAULTS = Object.freeze({
  prefix: 'siragpt:logs:',
  ringMax: 5000,
  maxAll: 60_000,
  maxErr: 20_000,
  errRetentionMs: 7 * 24 * 60 * 60 * 1000,
  // The per-request index only needs to outlive the full-line stream
  // (~hours); older errors are still found by scanning the error stream.
  reqRetentionSec: 12 * 60 * 60,
  reqMaxLines: 600,
  pendingMax: 5000,
  flushIntervalMs: 300,
  flushBatch: 500,
  memoryCheckMs: 30_000,
  pauseRatio: 0.6,
  resumeRatio: 0.45,
  absoluteMaxBytes: 256 * 1024 * 1024,
  repeatWindowMs: 3000,
});

function numEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

function parseId(id) {
  const m = /^(\d+)-(\d+)$/.exec(String(id || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** a > b for stream ids "ms-seq". */
function idGreater(a, b) {
  const pa = parseId(a);
  const pb = parseId(b);
  if (!pa) return false;
  if (!pb) return true;
  return pa[0] > pb[0] || (pa[0] === pb[0] && pa[1] > pb[1]);
}

function normalizeFilter(filter = {}) {
  const f = filter || {};
  const minLevel = f.minLevel && LEVEL_RANK[f.minLevel] != null ? f.minLevel : null;
  const lower = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
  return {
    minRank: minLevel ? LEVEL_RANK[minLevel] : null,
    source: lower(f.source),
    q: lower(f.q),
    user: lower(f.user),
    reqId: typeof f.reqId === 'string' && f.reqId.trim() ? f.reqId.trim() : null,
    chatId: typeof f.chatId === 'string' && f.chatId.trim() ? f.chatId.trim() : null,
    from: Number.isFinite(Number(f.from)) && Number(f.from) > 0 ? Number(f.from) : null,
    to: Number.isFinite(Number(f.to)) && Number(f.to) > 0 ? Number(f.to) : null,
  };
}

function matches(event, nf) {
  if (!event) return false;
  if (nf.minRank != null && levelRank(event.level) < nf.minRank) return false;
  if (nf.source) {
    const src = String(event.source || '').toLowerCase();
    if (!(src === nf.source || src.startsWith(`${nf.source}:`) || src.startsWith(nf.source))) return false;
  }
  if (nf.reqId && event.reqId !== nf.reqId) return false;
  if (nf.chatId && event.chatId !== nf.chatId) return false;
  if (nf.from && event.ts < nf.from) return false;
  if (nf.to && event.ts > nf.to) return false;
  if (nf.user) {
    const hay = `${event.email || ''} ${event.userId || ''}`.toLowerCase();
    if (!hay.includes(nf.user)) return false;
  }
  if (nf.q) {
    const hay = `${event.msg || ''}\n${event.body || ''}\n${event.tag || ''}\n${event.route || ''}\n${event.email || ''}\n${event.reqId || ''}`.toLowerCase();
    if (!hay.includes(nf.q)) return false;
  }
  return true;
}

function repeatKey(e) {
  return `${e.level}|${e.source}|${e.tag || ''}|${String(e.msg || '').replace(/\d+/g, '#').slice(0, 200)}`;
}

class LiveLogStore {
  constructor({ env = process.env, redisFactory = null, now = () => Date.now() } = {}) {
    this.env = env;
    this.now = now;
    this.redisFactory = redisFactory;
    this.opts = {
      ...DEFAULTS,
      prefix: env.SIRAGPT_LIVE_LOGS_REDIS_PREFIX || DEFAULTS.prefix,
      ringMax: numEnv(env, 'SIRAGPT_LIVE_LOGS_RING', DEFAULTS.ringMax, { min: 100, max: 50_000 }),
      maxAll: numEnv(env, 'SIRAGPT_LIVE_LOGS_MAX_LINES', DEFAULTS.maxAll, { min: 1000, max: 500_000 }),
      maxErr: numEnv(env, 'SIRAGPT_LIVE_LOGS_MAX_ERRORS', DEFAULTS.maxErr, { min: 500, max: 200_000 }),
      errRetentionMs: numEnv(env, 'SIRAGPT_LIVE_LOGS_ERROR_DAYS', 7, { min: 1, max: 30 }) * 24 * 60 * 60 * 1000,
      absoluteMaxBytes: numEnv(env, 'SIRAGPT_LIVE_LOGS_REDIS_MAX_MB', 256, { min: 16, max: 4096 }) * 1024 * 1024,
      reqRetentionSec: numEnv(env, 'SIRAGPT_LIVE_LOGS_REQUEST_HOURS', 12, { min: 1, max: 168 }) * 60 * 60,
    };
    this.keys = {
      all: `${this.opts.prefix}all`,
      err: `${this.opts.prefix}err`,
      req: (reqId) => `${this.opts.prefix}req:${reqId}`,
    };
    this.ring = new Array(this.opts.ringMax);
    this.ringHead = 0;
    this.ringSize = 0;
    this.pending = [];
    this.pendingIndex = new Map(); // id → event still waiting for Redis
    this.lastMs = 0;
    this.seq = 0;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
    this.client = null;
    this.redisReady = false;
    this.paused = false;
    this.flushing = false;
    this.timers = [];
    this.stats = { captured: 0, collapsed: 0, dropped: 0, persisted: 0, redisErrors: 0, pausedByMemory: 0 };
    this.lastEvent = null;
    this.internalNote = () => {};
  }

  nextId(ts) {
    let ms = Math.max(ts, this.lastMs);
    if (ms === this.lastMs) this.seq += 1;
    else this.seq = 0;
    this.lastMs = ms;
    return `${ms}-${this.seq}`;
  }

  /** Synchronous, never throws. Returns the stored event (or the collapsed one). */
  push(input) {
    try {
      const ts = Number.isFinite(input.ts) ? input.ts : this.now();
      const last = this.lastEvent;
      if (
        last
        // Only collapse into an event that has not been persisted yet.
        && (!this.client || this.pendingIndex.has(last.id))
        && ts - (last.lastTs || last.ts) <= this.opts.repeatWindowMs
        && repeatKey(last) === repeatKey(input)
        && (last.reqId || null) === (input.reqId || null)
      ) {
        last.repeat = (last.repeat || 1) + 1;
        last.lastTs = ts;
        this.stats.collapsed += 1;
        this.bus.emit('repeat', { id: last.id, repeat: last.repeat, lastTs: ts });
        return last;
      }
      const event = { ...input, ts, id: this.nextId(ts) };
      for (const k of Object.keys(event)) {
        if (event[k] === null || event[k] === undefined || event[k] === '') delete event[k];
      }
      this.ring[this.ringHead] = event;
      this.ringHead = (this.ringHead + 1) % this.opts.ringMax;
      if (this.ringSize < this.opts.ringMax) this.ringSize += 1;
      this.lastEvent = event;
      this.stats.captured += 1;
      if (this.client) {
        if (this.pending.length >= this.opts.pendingMax) {
          const dropped = this.pending.shift();
          if (dropped) this.pendingIndex.delete(dropped.id);
          this.stats.dropped += 1;
        }
        this.pending.push(event);
        this.pendingIndex.set(event.id, event);
      }
      this.bus.emit('line', event);
      return event;
    } catch (_) {
      return null;
    }
  }

  /** Newest-last list of ring events matching `filter`, optionally only after `afterId`. */
  recent(filter = {}, { limit = 200, afterId = null } = {}) {
    const nf = normalizeFilter(filter);
    const out = [];
    for (let i = 0; i < this.ringSize && out.length < limit; i += 1) {
      const idx = (this.ringHead - 1 - i + this.opts.ringMax) % this.opts.ringMax;
      const e = this.ring[idx];
      if (!e) continue;
      if (afterId && !idGreater(e.id, afterId)) break;
      if (matches(e, nf)) out.push(e);
    }
    return out.reverse();
  }

  matcher(filter) {
    const nf = normalizeFilter(filter);
    return (e) => matches(e, nf);
  }

  // ── Redis ────────────────────────────────────────────────────────────

  start() {
    if (this.started) return;
    this.started = true;
    const url = this.env.REDIS_URL || this.env.REDIS_CONNECTION_URL || '';
    if (this.env.SIRAGPT_LIVE_LOGS_REDIS === '0') return;
    try {
      if (this.redisFactory) this.client = this.redisFactory();
      else if (url) {
        // eslint-disable-next-line global-require
        const Redis = require('ioredis');
        this.client = new Redis(url, {
          lazyConnect: false,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          connectionName: 'siragpt-live-logs',
          retryStrategy: (times) => Math.min(1000 * times, 15_000),
        });
      }
    } catch (_) {
      this.client = null;
    }
    if (!this.client) return;
    if (typeof this.client.on === 'function') {
      this.client.on('ready', () => { this.redisReady = true; });
      this.client.on('end', () => { this.redisReady = false; });
      this.client.on('close', () => { this.redisReady = false; });
      this.client.on('error', (err) => {
        this.redisReady = false;
        this.stats.redisErrors += 1;
        this.internalNote(`redis error: ${err && err.message ? err.message : err}`);
      });
    } else {
      this.redisReady = true;
    }
    // Events captured before the client existed (boot logs) go to Redis too.
    const early = this.recent({}, { limit: this.opts.flushBatch * 2 });
    for (const e of early) {
      if (!this.pendingIndex.has(e.id)) {
        this.pending.push(e);
        this.pendingIndex.set(e.id, e);
      }
    }
    const every = (ms, fn) => {
      const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms);
      if (typeof t.unref === 'function') t.unref();
      this.timers.push(t);
    };
    every(this.opts.flushIntervalMs, () => this.flush());
    every(this.opts.memoryCheckMs, () => this.checkMemory());
    every(10 * 60 * 1000, () => this.trimErrors());
    setTimeout(() => { this.checkMemory().catch(() => {}); }, 2000).unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
    try { if (this.client && typeof this.client.disconnect === 'function') this.client.disconnect(); } catch (_) { /* ignore */ }
    this.client = null;
  }

  async flush() {
    if (this.flushing || !this.client || !this.redisReady || this.paused || this.pending.length === 0) return 0;
    this.flushing = true;
    const batch = this.pending.splice(0, this.opts.flushBatch);
    try {
      const pipe = this.client.pipeline();
      const warnRank = LEVEL_RANK.warn;
      for (const e of batch) {
        const data = JSON.stringify(e);
        pipe.xadd(this.keys.all, 'MAXLEN', '~', this.opts.maxAll, e.id, 'd', data);
        if (levelRank(e.level) >= warnRank) {
          pipe.xadd(this.keys.err, 'MAXLEN', '~', this.opts.maxErr, e.id, 'd', data);
        }
        if (e.reqId) {
          const key = this.keys.req(e.reqId);
          pipe.rpush(key, e.id);
          pipe.ltrim(key, -this.opts.reqMaxLines, -1);
          pipe.expire(key, this.opts.reqRetentionSec);
        }
      }
      const results = await pipe.exec();
      let failed = 0;
      let idClash = false;
      for (const [err] of results || []) {
        if (!err) continue;
        failed += 1;
        if (/equal or smaller/i.test(String(err.message || err))) idClash = true;
      }
      if (idClash) {
        // Another writer (e.g. the old container during a deploy overlap) is
        // ahead of our clock: let Redis assign ids for this batch.
        const retry = this.client.pipeline();
        for (const e of batch) {
          const data = JSON.stringify(e);
          retry.xadd(this.keys.all, 'MAXLEN', '~', this.opts.maxAll, '*', 'd', data);
          if (levelRank(e.level) >= warnRank) retry.xadd(this.keys.err, 'MAXLEN', '~', this.opts.maxErr, '*', 'd', data);
        }
        await retry.exec().catch(() => {});
        this.lastMs = Math.max(this.lastMs, this.now());
      }
      if (failed && !idClash) {
        this.stats.redisErrors += failed;
        this.internalNote(`${failed} redis writes failed in the last flush`);
      }
      this.stats.persisted += batch.length;
      for (const e of batch) this.pendingIndex.delete(e.id);
      return batch.length;
    } catch (err) {
      // Put the batch back (bounded) — Redis blips must not lose recent errors.
      this.stats.redisErrors += 1;
      const room = Math.max(0, this.opts.pendingMax - this.pending.length);
      const back = batch.slice(-room);
      this.pending.unshift(...back);
      this.stats.dropped += batch.length - back.length;
      for (const e of batch.slice(0, batch.length - back.length)) this.pendingIndex.delete(e.id);
      this.internalNote(`flush failed: ${err && err.message ? err.message : err}`);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  async checkMemory() {
    if (!this.client || !this.redisReady || typeof this.client.info !== 'function') return null;
    const info = await this.client.info('memory');
    const num = (name) => {
      const m = new RegExp(`^${name}:(\\d+)`, 'm').exec(String(info || ''));
      return m ? Number(m[1]) : 0;
    };
    const used = num('used_memory');
    const max = num('maxmemory');
    const ratio = max > 0 ? used / max : used / this.opts.absoluteMaxBytes;
    if (!this.paused && ratio >= this.opts.pauseRatio) {
      this.paused = true;
      this.stats.pausedByMemory += 1;
      this.internalNote(`paused: redis memory at ${(ratio * 100).toFixed(0)}% — trimming log streams`);
      try { await this.client.xtrim(this.keys.all, 'MAXLEN', '~', 5000); } catch (_) { /* ignore */ }
    } else if (this.paused && ratio <= this.opts.resumeRatio) {
      this.paused = false;
      this.internalNote('resumed: redis memory back to normal');
    }
    return { used, max, ratio, paused: this.paused };
  }

  async trimErrors() {
    if (!this.client || !this.redisReady) return;
    const minId = `${this.now() - this.opts.errRetentionMs}-0`;
    try { await this.client.xtrim(this.keys.err, 'MINID', '~', minId); } catch (_) { /* ignore */ }
  }

  static parseEntries(entries) {
    const out = [];
    for (const entry of entries || []) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const fields = entry[1] || [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i] !== 'd') continue;
        try {
          const e = JSON.parse(fields[i + 1]);
          if (e && typeof e === 'object') {
            if (!e.id) e.id = entry[0];
            out.push(e);
          }
        } catch (_) { /* skip corrupt entry */ }
      }
    }
    return out;
  }

  /**
   * History search, newest first. Uses the error stream when only warn+ is
   * requested (7-day retention), otherwise the full stream (recent hours).
   */
  async search(filter = {}, { limit = 200, before = null, maxScan = 30_000 } = {}) {
    const nf = normalizeFilter(filter);
    const cap = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const useErr = nf.minRank != null && nf.minRank >= LEVEL_RANK.warn;
    if (!this.client || !this.redisReady || typeof this.client.xrevrange !== 'function') {
      const lines = this.recent(filter, { limit: this.opts.ringMax }).reverse()
        .filter((e) => !before || idGreater(before, e.id))
        .slice(0, cap);
      return { lines, nextBefore: lines.length === cap ? lines[lines.length - 1].id : null, scanned: this.ringSize, stream: 'memory' };
    }
    const key = useErr ? this.keys.err : this.keys.all;
    const lines = [];
    let end = before ? `(${before}` : '+';
    const start = nf.from ? `${nf.from}-0` : '-';
    let scanned = 0;
    while (lines.length < cap && scanned < maxScan) {
      // eslint-disable-next-line no-await-in-loop
      const entries = await this.client.xrevrange(key, end, start, 'COUNT', 1000);
      if (!entries || entries.length === 0) break;
      scanned += entries.length;
      for (const e of LiveLogStore.parseEntries(entries)) {
        if (matches(e, nf)) {
          lines.push(e);
          if (lines.length >= cap) break;
        }
      }
      end = `(${entries[entries.length - 1][0]}`;
      if (entries.length < 1000) break;
    }
    return {
      lines,
      nextBefore: lines.length >= cap ? lines[lines.length - 1].id : null,
      scanned,
      stream: useErr ? 'errors' : 'all',
    };
  }

  /** Every stored line of one request/turn, oldest first. */
  async requestLines(reqId, { limit = 600 } = {}) {
    const id = String(reqId || '').trim();
    const byId = new Map();
    for (const e of this.recent({ reqId: id }, { limit: this.opts.ringMax })) byId.set(e.id, e);
    if (this.client && this.redisReady && typeof this.client.lrange === 'function') {
      try {
        const ids = await this.client.lrange(this.keys.req(id), 0, -1);
        if ((!ids || ids.length === 0) && typeof this.client.xrevrange === 'function') {
          // Index expired (older turn): scan the streams for that request.
          const [all, errs] = await Promise.all([
            this.search({ reqId: id }, { limit: 600, maxScan: 20_000 }).catch(() => ({ lines: [] })),
            this.search({ reqId: id, minLevel: 'warn' }, { limit: 600, maxScan: 20_000 }).catch(() => ({ lines: [] })),
          ]);
          for (const e of [...all.lines, ...errs.lines]) if (e && e.id) byId.set(e.id, e);
        }
        const missing = (ids || []).filter((x) => !byId.has(x));
        if (missing.length) {
          const pipe = this.client.pipeline();
          for (const x of missing) pipe.xrange(this.keys.all, x, x);
          const res = await pipe.exec();
          const stillMissing = [];
          missing.forEach((x, i) => {
            const [err, entries] = res[i] || [];
            const parsed = err ? [] : LiveLogStore.parseEntries(entries);
            if (parsed.length) byId.set(x, parsed[0]);
            else stillMissing.push(x);
          });
          if (stillMissing.length) {
            const pipe2 = this.client.pipeline();
            for (const x of stillMissing) pipe2.xrange(this.keys.err, x, x);
            const res2 = await pipe2.exec();
            stillMissing.forEach((x, i) => {
              const [err, entries] = res2[i] || [];
              const parsed = err ? [] : LiveLogStore.parseEntries(entries);
              if (parsed.length) byId.set(x, parsed[0]);
            });
          }
        }
      } catch (_) { /* memory-only answer */ }
    }
    const lines = [...byId.values()].sort((a, b) => (idGreater(a.id, b.id) ? 1 : -1));
    return lines.slice(-Math.max(1, Math.min(Number(limit) || 600, 2000)));
  }

  snapshot() {
    return {
      ringSize: this.ringSize,
      pending: this.pending.length,
      redis: this.client ? (this.redisReady ? 'ready' : 'down') : 'disabled',
      paused: this.paused,
      ...this.stats,
    };
  }
}

module.exports = {
  LiveLogStore,
  normalizeFilter,
  matches,
  idGreater,
  DEFAULTS,
};
