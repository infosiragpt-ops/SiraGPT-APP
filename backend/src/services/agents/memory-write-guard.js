'use strict';

/**
 * Hermes memory write guard — per-fact size cap + per-user write rate-limit.
 *
 * Adapted from NousResearch/hermes-agent (MIT) tools/memory_tool.py:
 *   https://github.com/NousResearch/hermes-agent
 *   MEMORY.md / USER.md character limits (~2200 / ~1375).
 *
 * Pattern adopted (not a dump of the Python module):
 *   - One fact cannot exceed FACT_MAX_CHARS
 *   - One user cannot flood remember / curated add / replace
 *   - Fail closed with Spanish errors and AGENTS.md §16 codes
 *   - Isolation: every counter is keyed by userId
 */

const FACT_MAX_CHARS = 2000;
const WRITE_MAX_PER_WINDOW = 20;
const WRITE_WINDOW_MS = 60_000;

const writeLog = new Map();

class MemoryWriteError extends Error {
  constructor({ code, error, status = 400, retryAfterMs = null, used = null, limit = null }) {
    super(error);
    this.name = 'MemoryWriteError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.used = used;
    this.limit = limit;
    this.ok = false;
  }

  toJSON() {
    const payload = {
      ok: false,
      success: false,
      code: this.code,
      error: this.message,
    };
    if (this.retryAfterMs != null) payload.retryAfterMs = this.retryAfterMs;
    if (this.used != null) payload.used = this.used;
    if (this.limit != null) payload.limit = this.limit;
    return payload;
  }
}

function isMemoryWriteError(err) {
  return Boolean(err && (err instanceof MemoryWriteError || err.name === 'MemoryWriteError'));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function checkFactSize(fact, opts = {}) {
  const maxChars = positiveInt(opts.maxChars, FACT_MAX_CHARS);
  const used = String(fact ?? '').length;
  if (used > maxChars) {
    return {
      ok: false,
      success: false,
      code: 'E_PARAMS',
      status: 400,
      used,
      limit: maxChars,
      error: `El dato supera el límite de ${maxChars} caracteres. Acórtalo o sustituye una entrada existente.`,
    };
  }
  return { ok: true, used, limit: maxChars };
}

function storeOverflowError({ current, limit, added }) {
  return {
    ok: false,
    success: false,
    code: 'E_PARAMS',
    status: 400,
    used: current,
    limit,
    error: `La memoria está en ${current}/${limit} caracteres. Añadir esta entrada (${added} caracteres) la superaría. Sustituye o elimina una entrada primero.`,
  };
}

function checkWriteRate(userId, opts = {}) {
  const id = String(userId || '').trim();
  if (!id) {
    return {
      ok: false,
      success: false,
      code: 'E_PARAMS',
      status: 400,
      error: 'Falta el usuario para guardar memoria.',
    };
  }

  const now = Number.isFinite(opts.now) && opts.now > 0 ? opts.now : Date.now();
  const maxWrites = positiveInt(opts.maxWrites, WRITE_MAX_PER_WINDOW);
  const windowMs = positiveInt(opts.windowMs, WRITE_WINDOW_MS);
  const stamps = (writeLog.get(id) || []).filter((ts) => now - ts < windowMs);

  if (stamps.length >= maxWrites) {
    const retryAfterMs = Math.max(1, windowMs - (now - stamps[0]));
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return {
      ok: false,
      success: false,
      code: 'E_QUOTA',
      status: 429,
      retryAfterMs,
      used: stamps.length,
      limit: maxWrites,
      error: `Has escrito en memoria demasiadas veces este minuto. Espera unos ${secs} segundos y reintenta.`,
    };
  }

  if (opts.record !== false) {
    stamps.push(now);
    writeLog.set(id, stamps);
  }

  return {
    ok: true,
    used: stamps.length,
    limit: maxWrites,
    remaining: Math.max(0, maxWrites - stamps.length),
  };
}

function checkMemoryWrite(userId, fact, opts = {}) {
  const size = checkFactSize(fact, opts);
  if (!size.ok) return size;
  if (opts.rateLimit === false) return size;
  const rate = checkWriteRate(userId, opts);
  if (!rate.ok) return rate;
  return { ok: true, used: size.used, limit: size.limit, remaining: rate.remaining };
}

function assertMemoryWrite(userId, fact, opts = {}) {
  const result = checkMemoryWrite(userId, fact, opts);
  if (!result.ok) throw new MemoryWriteError(result);
  return result;
}

function resetMemoryWriteGuardForTests() {
  writeLog.clear();
}

module.exports = {
  FACT_MAX_CHARS,
  WRITE_MAX_PER_WINDOW,
  WRITE_WINDOW_MS,
  MemoryWriteError,
  isMemoryWriteError,
  checkFactSize,
  checkWriteRate,
  checkMemoryWrite,
  assertMemoryWrite,
  storeOverflowError,
  resetMemoryWriteGuardForTests,
};
