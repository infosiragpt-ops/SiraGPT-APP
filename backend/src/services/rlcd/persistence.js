'use strict';

/**
 * RLCD ledger persistence — survives backend recreates without a migration.
 *
 * The durable part of the ledger (reliability bins + counters) is written as
 * JSON into the existing `system_settings` table (key `rlcd.ledger.v2`):
 *  - restored once at boot (before the first decision is taken),
 *  - flushed every SIRAGPT_RLCD_PERSIST_INTERVAL_MS (default 5 min) when
 *    something changed,
 *  - flushed on graceful shutdown (shutdown registry step).
 * Fail-open everywhere: a DB hiccup never blocks a chat turn.
 */

const ledger = require('./decision-ledger');
const config = require('./config');

const state = {
  started: false,
  timer: null,
  lastSaveAt: null,
  lastRestoreAt: null,
  lastError: null,
  saves: 0,
  restored: false,
  restoredDecisions: 0,
};

function storageKey(env = process.env) {
  return config.describe(env).persistence.key;
}

async function restore({ prisma, env = process.env } = {}) {
  if (!prisma || !prisma.systemSettings) return { ok: false, reason: 'no_prisma' };
  if (!config.flagOn(env, 'SIRAGPT_RLCD_PERSIST', true)) return { ok: false, reason: 'disabled' };
  try {
    const row = await prisma.systemSettings.findUnique({ where: { key: storageKey(env) } });
    if (!row || !row.value) return { ok: true, reason: 'empty' };
    const obj = JSON.parse(row.value);
    const ok = ledger.load(obj);
    state.restored = ok;
    state.lastRestoreAt = Date.now();
    state.restoredDecisions = ok && obj.counters ? Number(obj.counters.decisions) || 0 : 0;
    return { ok, reason: ok ? 'restored' : 'invalid', savedAt: obj.savedAt || null };
  } catch (err) {
    state.lastError = `restore: ${err && err.message}`;
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

async function save({ prisma, env = process.env, force = false } = {}) {
  if (!prisma || !prisma.systemSettings) return { ok: false, reason: 'no_prisma' };
  if (!config.flagOn(env, 'SIRAGPT_RLCD_PERSIST', true)) return { ok: false, reason: 'disabled' };
  if (!force && !ledger.isDirty()) return { ok: true, reason: 'clean' };
  try {
    const payload = ledger.persistable();
    const value = JSON.stringify(payload);
    const key = storageKey(env);
    await prisma.systemSettings.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    ledger.markClean();
    state.saves += 1;
    state.lastSaveAt = Date.now();
    state.lastError = null;
    return { ok: true, reason: 'saved', bytes: value.length, decisions: payload.counters.decisions };
  } catch (err) {
    state.lastError = `save: ${err && err.message}`;
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

/**
 * Boot wiring: restore, schedule periodic flushes, register the shutdown
 * flush. Idempotent.
 */
async function start({ prisma, env = process.env, shutdownRegistry = null, logger = console } = {}) {
  if (state.started) return state;
  state.started = true;
  const r = await restore({ prisma, env });
  if (r.ok && r.reason === 'restored') {
    logger.info?.(`[rlcd] ledger restored from system_settings (${state.restoredDecisions} decisions, saved ${r.savedAt ? new Date(r.savedAt).toISOString() : '?'})`);
  }
  const interval = config.describe(env).persistence.intervalMs;
  if (config.flagOn(env, 'SIRAGPT_RLCD_PERSIST', true)) {
    state.timer = setInterval(() => { save({ prisma, env }).catch(() => {}); }, interval);
    if (state.timer.unref) state.timer.unref();
    if (shutdownRegistry && typeof shutdownRegistry.register === 'function') {
      shutdownRegistry.register('rlcd_ledger_flush', () => save({ prisma, env, force: true }), 5000);
    }
  }
  return state;
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
}

function status() {
  return {
    enabled: config.flagOn(process.env, 'SIRAGPT_RLCD_PERSIST', true),
    started: state.started,
    restored: state.restored,
    restoredDecisions: state.restoredDecisions,
    saves: state.saves,
    lastSaveAt: state.lastSaveAt,
    lastRestoreAt: state.lastRestoreAt,
    lastError: state.lastError,
    dirty: ledger.isDirty(),
  };
}

function resetForTests() {
  stop();
  Object.assign(state, { lastSaveAt: null, lastRestoreAt: null, lastError: null, saves: 0, restored: false, restoredDecisions: 0 });
}

module.exports = { restore, save, start, stop, status, storageKey, resetForTests };
