'use strict';

/**
 * Autonomous software-error loop.
 * Collects real sources, upserts rows, and attempts only safe repairs.
 */

const store = require('./store');
const collectors = require('./collectors');
const repair = require('./repair');

const INTERVAL_MS = Number(process.env.SOFTWARE_ERROR_LOOP_MS || 45_000);
const START_DELAY_MS = Number(process.env.SOFTWARE_ERROR_LOOP_START_MS || 12_000);

let timer = null;
let running = false;
let stopped = false;
let lastTickAt = null;
let lastError = null;

async function persistFindings(findings) {
  const upserted = [];
  for (const item of findings) {
    try {
      const result = await store.upsertError(item);
      if (result?.row) upserted.push(result.row);
    } catch (err) {
      console.warn('[software-errors] upsert failed:', err?.message || err);
    }
  }
  return upserted;
}

async function autoRepair(rows) {
  for (const row of rows) {
    if (!repair.canAutoRepair(row)) continue;
    try {
      await repair.attempt(row, { manual: false });
    } catch (err) {
      console.warn('[software-errors] repair skipped:', err?.message || err);
    }
  }
}

async function reconcileHealthyContainers() {
  const open = await store.listOpenByClass('container_unhealthy');
  if (!open.length) return;
  const live = await collectors.collectContainerHealth();
  const stillBad = new Set(live.map((item) => item.resourceId));
  for (const row of open) {
    const container = row.metadata?.container || row.resourceId;
    if (stillBad.has(container)) continue;
    try {
      await store.markRepairedIfGone(row.id, 'El contenedor volvió a estar saludable.');
    } catch {
      /* ignore */
    }
  }
}

async function tick() {
  if (running || stopped) return;
  running = true;
  try {
    await store.ensureTable();
    const findings = await collectors.collectAll();
    const rows = await persistFindings(findings);
    await autoRepair(rows);
    await reconcileHealthyContainers();
    lastTickAt = new Date().toISOString();
    lastError = null;
  } catch (err) {
    lastError = err?.message || String(err);
    console.warn('[software-errors] tick failed:', lastError);
  } finally {
    running = false;
  }
}

function start({ logger } = {}) {
  if (timer || stopped) return false;
  const log = logger || console;
  const kick = () => {
    void tick().finally(() => {
      if (stopped) return;
      timer = setTimeout(kick, INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
  };
  timer = setTimeout(kick, START_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info?.('software_error_worker_started') || log.log?.('[software-errors] worker started');
  return true;
}

function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function status() {
  return {
    running,
    stopped,
    lastTickAt,
    lastError,
    intervalMs: INTERVAL_MS,
  };
}

module.exports = {
  start,
  stop,
  tick,
  status,
};
