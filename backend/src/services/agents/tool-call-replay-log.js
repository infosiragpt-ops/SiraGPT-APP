'use strict';

/**
 * tool-call-replay-log — persistencia in-memory de tool calls completados con
 * su salida, indexados por una clave determinista derivada de (toolName, args,
 * scope). Permite reintroducir un replay del resultado sin volver a invocar al
 * LLM ni la herramienta. Entradas con TTL (default 1h) y capacidad limitada
 * (LRU por orden de inserción).
 *
 * Diseño propio (no derivado de openclaw):
 *   - record({ toolName, args, output, scope?, ttlMs?, ok? }) — registra un
 *     resultado exitoso o fallido (ok=false marca el resultado como tal pero
 *     sigue siendo replayable de forma explícita).
 *   - replay({ toolName, args, scope? }) — devuelve { hit, entry } con la
 *     entrada o null si expiró/no existe.
 *   - has(...) / invalidate(...) / size() / stats() / clear() — utilidades.
 *   - sweepExpired(now?) — invocable manualmente; también se ejecuta perezosa-
 *     mente en cada record/replay para acotar memoria.
 *   - buildKey({ toolName, args, scope? }) — exportado para tests y llaves
 *     externas (p.ej. logs cruzados con auditoría).
 *   - createReplayLog(opts) — factory para tests aislados.
 *
 * No hay dependencia de Redis o disco — esto es un caché caliente local pensado
 * para colapsar reintentos dentro de la ventana de una conversación. Si el
 * proceso reinicia, el log se vacía: las llamadas se vuelven a ejecutar.
 */

const { createHash } = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_ENTRIES = 5000;
const KEY_VERSION = 'v1';

function stableStringify(value) {
  if (value === undefined) return 'undef';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'bigint') return `"bigint:${value.toString()}"`;
  if (type === 'function' || type === 'symbol') return JSON.stringify(`<${type}>`);
  if (Array.isArray(value)) {
    const parts = value.map((item) => stableStringify(item));
    return `[${parts.join(',')}]`;
  }
  if (value instanceof Date) return JSON.stringify(`date:${value.toISOString()}`);
  if (value instanceof RegExp) return JSON.stringify(`regex:${value.toString()}`);
  if (Buffer.isBuffer(value)) return JSON.stringify(`buf:${value.toString('base64')}`);
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function buildKey({ toolName, args, scope } = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new TypeError('toolName must be a non-empty string');
  }
  const payload = stableStringify({
    v: KEY_VERSION,
    t: toolName,
    s: scope ?? null,
    a: args ?? null,
  });
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${KEY_VERSION}:${toolName}:${digest}`;
}

function nowMs(clock) {
  if (typeof clock === 'function') return clock();
  return Date.now();
}

function cloneOutput(output) {
  if (output === undefined || output === null) return output;
  const type = typeof output;
  if (type !== 'object') return output;
  if (Buffer.isBuffer(output)) return Buffer.from(output);
  try {
    return structuredClone(output);
  } catch {
    try {
      return JSON.parse(JSON.stringify(output));
    } catch {
      return output;
    }
  }
}

class ToolCallReplayLog {
  constructor(opts = {}) {
    this.defaultTtlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? opts.ttlMs
      : DEFAULT_TTL_MS;
    this.maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
      ? Math.floor(opts.maxEntries)
      : DEFAULT_MAX_ENTRIES;
    this.clock = typeof opts.clock === 'function' ? opts.clock : null;
    this._entries = new Map(); // key -> entry
    this._stats = { hits: 0, misses: 0, expired: 0, evicted: 0, recorded: 0 };
  }

  _now() {
    return nowMs(this.clock);
  }

  record({ toolName, args, output, scope, ttlMs, ok = true, meta } = {}) {
    const key = buildKey({ toolName, args, scope });
    const ts = this._now();
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.defaultTtlMs;
    const entry = {
      key,
      toolName,
      scope: scope ?? null,
      output: cloneOutput(output),
      ok: ok !== false,
      meta: meta ? { ...meta } : null,
      recordedAt: ts,
      expiresAt: ts + ttl,
      hits: 0,
    };
    if (this._entries.has(key)) {
      this._entries.delete(key);
    }
    this._entries.set(key, entry);
    this._stats.recorded += 1;
    this._sweepExpired(ts);
    this._enforceCapacity();
    return key;
  }

  replay({ toolName, args, scope } = {}) {
    const key = buildKey({ toolName, args, scope });
    return this.replayByKey(key);
  }

  replayByKey(key) {
    const ts = this._now();
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses += 1;
      return { hit: false, entry: null };
    }
    if (entry.expiresAt <= ts) {
      this._entries.delete(key);
      this._stats.expired += 1;
      this._stats.misses += 1;
      return { hit: false, entry: null };
    }
    // Refresh recency without resetting TTL — the goal is reuse, not extension.
    this._entries.delete(key);
    this._entries.set(key, entry);
    entry.hits += 1;
    this._stats.hits += 1;
    return {
      hit: true,
      entry: {
        key: entry.key,
        toolName: entry.toolName,
        scope: entry.scope,
        output: cloneOutput(entry.output),
        ok: entry.ok,
        meta: entry.meta ? { ...entry.meta } : null,
        recordedAt: entry.recordedAt,
        expiresAt: entry.expiresAt,
        hits: entry.hits,
      },
    };
  }

  has({ toolName, args, scope } = {}) {
    const key = buildKey({ toolName, args, scope });
    const entry = this._entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this._now()) {
      this._entries.delete(key);
      this._stats.expired += 1;
      return false;
    }
    return true;
  }

  invalidate({ toolName, args, scope } = {}) {
    const key = buildKey({ toolName, args, scope });
    return this.invalidateByKey(key);
  }

  invalidateByKey(key) {
    return this._entries.delete(key);
  }

  invalidateScope(scope) {
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (entry.scope === scope) {
        this._entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  invalidateTool(toolName) {
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (entry.toolName === toolName) {
        this._entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size() {
    return this._entries.size;
  }

  clear() {
    this._entries.clear();
  }

  stats() {
    return {
      ...this._stats,
      size: this._entries.size,
      maxEntries: this.maxEntries,
      defaultTtlMs: this.defaultTtlMs,
    };
  }

  sweepExpired(now) {
    return this._sweepExpired(typeof now === 'number' ? now : this._now());
  }

  _sweepExpired(ts) {
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt <= ts) {
        this._entries.delete(key);
        removed += 1;
      }
    }
    if (removed) this._stats.expired += removed;
    return removed;
  }

  _enforceCapacity() {
    while (this._entries.size > this.maxEntries) {
      const oldestKey = this._entries.keys().next().value;
      if (oldestKey === undefined) break;
      this._entries.delete(oldestKey);
      this._stats.evicted += 1;
    }
  }
}

let _singleton = null;
function getReplayLog() {
  if (!_singleton) _singleton = new ToolCallReplayLog();
  return _singleton;
}

function createReplayLog(opts) {
  return new ToolCallReplayLog(opts);
}

function _resetForTests() {
  _singleton = null;
}

module.exports = {
  ToolCallReplayLog,
  createReplayLog,
  getReplayLog,
  buildKey,
  stableStringify,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  _resetForTests,
};
