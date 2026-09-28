'use strict';

/**
 * Cowork run slots. Prod 2026-09-28 22:39: «Your plan allows 12 concurrent
 * Cowork task(s) (activas=12, límite=12)» ×15 in 30 s. A `running` run with
 * no step/heartbeat for 15 min is abandoned and must free its slot; live
 * turns heartbeat through touchRun; the bootstrap warning is debounced.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../src/services/cowork/control-plane');

const ACTIVE = new Set(['queued', 'running', 'paused', 'waiting_approval']);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

function buildPrisma(rows, plan = 'ENTERPRISE') {
  const matches = (cond, row) => {
    const st = cond.status;
    const statusOk = typeof st === 'string' ? row.status === st : st.in.includes(row.status);
    return statusOk && (!cond.updatedAt || row.updatedAt < cond.updatedAt.lt);
  };
  const updates = [];
  const prisma = {
    user: { findUnique: async () => ({ id: 'u1', plan, isAdmin: false, isSuperAdmin: false }) },
    coworkRun: {
      findMany: async ({ where }) => rows.filter((row) => row.userId === where.userId && where.OR.some((cond) => matches(cond, row))),
      updateMany: async ({ where, data }) => {
        updates.push({ where, data });
        let count = 0;
        for (const row of rows) {
          const idOk = where.id && where.id.in ? where.id.in.includes(row.id) : where.id === row.id;
          const statusOk = !where.status || (where.status.in ? where.status.in.includes(row.status) : where.status === row.status);
          if (idOk && statusOk) { Object.assign(row, data); count += 1; }
        }
        return { count };
      },
      count: async ({ where }) => rows.filter((row) => row.userId === where.userId && ACTIVE.has(row.status)).length,
      create: async ({ data }) => ({ id: 'r-new', ...data }),
    },
    agentAuditLog: { create: async () => ({}) },
    $transaction: async (callback) => callback(prisma),
  };
  return { prisma, updates, rows };
}

test('a running run silent for 15 min is reaped; recent, paused and waiting runs survive', async () => {
  const rows = [
    { id: 'dead-20m', userId: 'u1', status: 'running', updatedAt: minutesAgo(20), workspaceId: 'w1' },
    { id: 'live-4m', userId: 'u1', status: 'running', updatedAt: minutesAgo(4), workspaceId: 'w1' },
    { id: 'paused-40m', userId: 'u1', status: 'paused', updatedAt: minutesAgo(40), workspaceId: 'w1' },
    { id: 'approval-40m', userId: 'u1', status: 'waiting_approval', updatedAt: minutesAgo(40), workspaceId: 'w1' },
  ];
  const { prisma } = buildPrisma(rows);
  const reaped = await controlPlane.reapStaleRuns(prisma, { userId: 'u1' });
  assert.deepEqual(reaped.map((r) => r.id), ['dead-20m']);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].lastEvent, controlPlane.STALE_RUN_LAST_EVENT);
  assert.equal(rows[1].status, 'running');
  assert.equal(rows[2].status, 'paused');
  assert.equal(rows[3].status, 'waiting_approval');
});

test('twelve abandoned runs no longer block createRun on the 12-slot ENTERPRISE plan', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `ghost-${i}`, userId: 'u1', status: 'running', updatedAt: minutesAgo(16 + i), workspaceId: 'w1' }));
  const { prisma } = buildPrisma(rows, 'ENTERPRISE');
  const run = await controlPlane.createRun(prisma, { userId: 'u1', prompt: 'hola' });
  assert.equal(run.id, 'r-new');
  assert.ok(rows.every((r) => r.status === 'failed'));
});

test('touchRun bumps updatedAt on live runs only and never throws', async () => {
  const rows = [
    { id: 'live', userId: 'u1', status: 'running', updatedAt: minutesAgo(10) },
    { id: 'done', userId: 'u1', status: 'completed', updatedAt: minutesAgo(10) },
  ];
  const { prisma, updates } = buildPrisma(rows);
  assert.equal(await controlPlane.touchRun(prisma, { runId: 'live', userId: 'u1' }), 1);
  assert.ok(rows[0].updatedAt > minutesAgo(1));
  assert.deepEqual(updates[0].where.status, { in: controlPlane.ACTIVE_STATUSES });
  assert.equal(await controlPlane.touchRun(prisma, { runId: 'done', userId: 'u1' }), 0);
  assert.equal(await controlPlane.touchRun({ coworkRun: { updateMany: async () => { throw new Error('db down'); } } }, { runId: 'live' }), 0);
  assert.equal(await controlPlane.touchRun(null, { runId: 'live' }), 0);
  assert.equal(controlPlane.heartbeatIntervalMs({}), 5 * 60 * 1000);
  assert.equal(controlPlane.heartbeatIntervalMs({ SIRAGPT_COWORK_HEARTBEAT_MS: '30000' }), 30_000);
  assert.equal(controlPlane.heartbeatIntervalMs({ SIRAGPT_COWORK_HEARTBEAT_MS: '5' }), 5 * 60 * 1000, 'too-small values fall back');
});

test('bootstrap failures: one WARN per minute with the count, the rest at info', () => {
  controlPlane.resetBootstrapLogState();
  const lines = [];
  const logger = {
    warn: (...args) => lines.push(['warn', args.join(' ')]),
    info: (...args) => lines.push(['info', args.join(' ')]),
  };
  const error = new controlPlane.CoworkControlError('cowork_concurrency_limit', 'Your plan allows 12 concurrent Cowork task(s).', 429, { concurrency: 12, active: 12, plan: 'ENTERPRISE' });
  const t0 = 1_000_000;
  for (let i = 0; i < 15; i += 1) controlPlane.logBootstrapFailure(error, { now: t0 + i * 2000, logger });
  assert.equal(lines.filter(([level]) => level === 'warn').length, 1);
  assert.equal(lines.filter(([level]) => level === 'info').length, 14);
  assert.match(lines[0][1], /^\[cowork\] run bootstrap failed \(legacy chat continues\): Your plan allows 12 .* \(activas=12, límite=12, plan=ENTERPRISE\)/);
  assert.match(lines[14][1], /\[×15 este minuto\]/);

  const next = controlPlane.logBootstrapFailure(error, { now: t0 + 61_000, logger });
  assert.equal(next.level, 'warn');
  assert.match(lines[15][1], /\[15 en el minuto anterior\]/);
  controlPlane.resetBootstrapLogState();
});
