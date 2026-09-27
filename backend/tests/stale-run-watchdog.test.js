'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const alertingPath = require.resolve('../src/services/alerting');

const watchdog = require('../src/jobs/stale-run-watchdog');

const originalEnv = {
  STALE_RUN_WATCHDOG_DISABLED: process.env.STALE_RUN_WATCHDOG_DISABLED,
  STALE_RUN_WARN_MINUTES: process.env.STALE_RUN_WARN_MINUTES,
  STALE_RUN_CRITICAL_MINUTES: process.env.STALE_RUN_CRITICAL_MINUTES,
  STALE_RUN_ALERT_COOLDOWN_MINUTES: process.env.STALE_RUN_ALERT_COOLDOWN_MINUTES,
  STALE_RUN_ABANDON_HOURS: process.env.STALE_RUN_ABANDON_HOURS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  watchdog._resetForTests();
});

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function fakePrisma({ agentTaskRows = [], codexRunRows = [], createdNotifications = [] } = {}) {
  const notificationsCreated = [];
  const prisma = {
    agentTask: {
      findMany: async ({ where }) => {
        if (!where || !where.status) return agentTaskRows;
        // Mirror Prisma: only real operators are accepted (`nin` is not one).
        const ops = Object.keys(where.status);
        const invalid = ops.filter((op) => !['in', 'notIn', 'equals', 'not'].includes(op));
        if (invalid.length) throw new Error(`Unknown argument \`${invalid[0]}\``);
        if (where.status.notIn) return agentTaskRows.filter((r) => !where.status.notIn.includes(r.status));
        if (where.status.in) return agentTaskRows.filter((r) => where.status.in.includes(r.status));
        return agentTaskRows;
      },
    },
    codexRun: {
      findMany: async ({ where }) => {
        if (!where || !where.status) return codexRunRows;
        if (where.status.in) return codexRunRows.filter((r) => where.status.in.includes(r.status));
        return codexRunRows;
      },
    },
    notification: {
      findFirst: async () => null,
      create: async ({ data }) => {
        notificationsCreated.push(data);
        return { id: `notif-${notificationsCreated.length}` };
      },
    },
  };
  return { prisma, notificationsCreated };
}

function captureAlerts() {
  const alerts = [];
  const alerting = {
    sendAlert: async (payload) => {
      alerts.push(payload);
      return { ok: true };
    },
  };
  require.cache[alertingPath] = {
    id: alertingPath,
    filename: alertingPath,
    loaded: true,
    exports: alerting,
  };
  return { alerts, unload: () => delete require.cache[alertingPath] };
}

test('thresholds default to 15m warn / 45m critical and honor env overrides', () => {
  const defaults = watchdog.thresholds({});
  assert.equal(defaults.warnMs, 15 * 60000);
  assert.equal(defaults.criticalMs, 45 * 60000);

  const custom = watchdog.thresholds({ STALE_RUN_WARN_MINUTES: '5', STALE_RUN_CRITICAL_MINUTES: '10' });
  assert.equal(custom.warnMs, 5 * 60000);
  assert.equal(custom.criticalMs, 10 * 60000);

  // Critical never below warn.
  const inverted = watchdog.thresholds({ STALE_RUN_WARN_MINUTES: '40', STALE_RUN_CRITICAL_MINUTES: '5' });
  assert.equal(inverted.criticalMs, 40 * 60000);
});

test('severity escalates warn -> critical and stays silent below warn', () => {
  const t = watchdog.thresholds({});
  assert.equal(watchdog.severityFor(14 * 60000, t), null);
  assert.equal(watchdog.severityFor(16 * 60000, t), 'warn');
  assert.equal(watchdog.severityFor(50 * 60000, t), 'critical');
});

test('scan alerts stale non-terminal tasks and notifies the owner', async () => {
  const { prisma, notificationsCreated } = fakePrisma({
    agentTaskRows: [
      { id: 'task-stale-1', userId: 'user-1', status: 'running', updatedAt: isoAgo(20), createdAt: isoAgo(25) },
      { id: 'task-fresh', userId: 'user-1', status: 'running', updatedAt: isoAgo(2), createdAt: isoAgo(3) },
      { id: 'task-terminal-excluded', userId: 'user-2', status: 'completed', updatedAt: isoAgo(500), createdAt: isoAgo(600) },
    ],
    codexRunRows: [
      { id: 'run-stale-1', userId: 'user-3', status: 'running', updatedAt: isoAgo(60), createdAt: isoAgo(70) },
      { id: 'run-queued-not-watched', userId: 'user-3', status: 'queued', updatedAt: isoAgo(90), createdAt: isoAgo(100) },
    ],
  });
  const captured = captureAlerts();

  try {
    const summary = await watchdog.scanStaleRuns({ prisma });

    assert.equal(summary.scanned, 2, 'fresh + terminal rows are excluded');
    assert.equal(summary.alerted, 2);
    assert.equal(summary.notifiedUsers, 2);
    assert.equal(notificationsCreated.length, 2);
    assert.ok(notificationsCreated.every((n) => n.type === 'run_stalled'));

    const taskAlert = captured.alerts.find((a) => a.context.runId === 'task-stale-1');
    const runAlert = captured.alerts.find((a) => a.context.runId === 'run-stale-1');
    assert.ok(taskAlert, 'stale agent task alerted');
    assert.equal(taskAlert.severity, 'warn');
    assert.equal(taskAlert.context.domain, 'stale-run-watchdog');
    assert.ok(runAlert, 'stale codex run alerted');
    assert.equal(runAlert.severity, 'critical', '60m-old run crosses the 45m critical line');
  } finally {
    captured.unload();
  }
});

test('per-run cooldown suppresses repeat alerts within the window', async () => {
  const { prisma } = fakePrisma({
    agentTaskRows: [
      { id: 'task-cooldown', userId: 'user-1', status: 'running', updatedAt: isoAgo(20), createdAt: isoAgo(30) },
    ],
  });
  const captured = captureAlerts();
  try {
    const first = await watchdog.scanStaleRuns({ prisma });
    assert.equal(first.alerted, 1);

    // Row ages further; still inside the cooldown window.
    const second = await watchdog.scanStaleRuns({ prisma });
    assert.equal(second.alerted, 0);
    assert.equal(second.suppressedByCooldown, 1);
    assert.equal(captured.alerts.length, 1, 'no duplicate channel POSTs');
  } finally {
    captured.unload();
  }
});

test('degrades to no-op without prisma or when disabled', async () => {
  const noPrisma = await watchdog.scanStaleRuns({ prisma: null });
  assert.equal(noPrisma.skipped, 'no_prisma');
  assert.equal(noPrisma.alerted, 0);

  const disabled = await watchdog.scanStaleRuns({
    env: { ...process.env, STALE_RUN_WATCHDOG_DISABLED: '1' },
    prisma: fakePrisma().prisma,
  });
  assert.equal(disabled.skipped, 'disabled');

  // Prisma without either table also skips cleanly.
  const bare = await watchdog.scanStaleRuns({ prisma: {} });
  assert.equal(bare.skipped, 'no_prisma');
});

test('owner notification is suppressed when one was already sent inside the cooldown', async () => {
  const { prisma, notificationsCreated } = fakePrisma({
    agentTaskRows: [
      { id: 'task-owner-dedup', userId: 'user-9', status: 'running', updatedAt: isoAgo(20), createdAt: isoAgo(20) },
    ],
  });
  let recentExists = false;
  prisma.notification.findFirst = async () => (recentExists ? { id: 'recent' } : null);

  await watchdog.scanStaleRuns({ prisma });
  assert.equal(notificationsCreated.length, 1);

  recentExists = true;
  watchdog._resetForTests();
  await watchdog.scanStaleRuns({ prisma });
  assert.equal(notificationsCreated.length, 1, 'no second inbox row for the same user+cooldown');
});

// ── Zombie runs (prod 2026-09-26: a codex-run silent > 2000 h and an agent
// task 478 h re-alerted `critical` on every sweep — ~25 red lines per restart).

function auditLogStore() {
  const rows = [];
  return {
    rows,
    auditLog: {
      findMany: async ({ where }) => rows.filter((r) => r.action === where.action
        && (!where.resourceType || r.resourceType === where.resourceType)
        && (!where.resourceId || !where.resourceId.in || where.resourceId.in.includes(r.resourceId))),
      create: async ({ data }) => { rows.push({ id: `al-${rows.length + 1}`, ...data }); return rows[rows.length - 1]; },
    },
  };
}

function withUpdateMany(model, rows) {
  model.updateMany = async ({ where, data }) => {
    let count = 0;
    for (const row of rows) {
      if (row.id !== where.id || row.status !== where.status) continue;
      if (where.updatedAt && Date.parse(row.updatedAt) !== new Date(where.updatedAt).getTime()) continue;
      Object.assign(row, data);
      count += 1;
    }
    return { count };
  };
}

test('zombie runs are closed as «abandonado» once, recorded, and never alerted', async () => {
  const agentTaskRows = [
    { id: 'task-zombie', userId: 'user-1', status: 'running', updatedAt: isoAgo(478 * 60), createdAt: isoAgo(480 * 60) },
    { id: 'task-stale', userId: 'user-2', status: 'running', updatedAt: isoAgo(50), createdAt: isoAgo(55) },
  ];
  const codexRunRows = [
    { id: 'run-zombie', userId: 'user-3', status: 'running', updatedAt: isoAgo(2000 * 60), createdAt: isoAgo(2001 * 60) },
  ];
  const { prisma } = fakePrisma({ agentTaskRows, codexRunRows });
  withUpdateMany(prisma.agentTask, agentTaskRows);
  withUpdateMany(prisma.codexRun, codexRunRows);
  const audit = auditLogStore();
  prisma.auditLog = audit.auditLog;
  const captured = captureAlerts();
  try {
    const first = await watchdog.scanStaleRuns({ prisma });
    assert.equal(first.abandoned, 2);
    assert.equal(first.alerted, 1, 'only the genuinely stale (not zombie) task alerts');
    assert.deepEqual(captured.alerts.map((a) => a.context.runId), ['task-stale']);
    assert.equal(agentTaskRows[0].status, 'cancelled');
    assert.ok(agentTaskRows[0].cancelledAt instanceof Date);
    assert.equal(codexRunRows[0].status, 'cancelled');
    assert.match(codexRunRows[0].error, /^abandonado: sin actividad desde hace 2000 h/);
    const abandoned = audit.rows.filter((r) => r.action === watchdog.ABANDONED_ACTION).map((r) => r.resourceId).sort();
    assert.deepEqual(abandoned, ['agent_task:task-zombie', 'codex_run:run-zombie']);

    // A restart forgets the in-memory cooldown: the persisted record still
    // prevents a second alert, and the closed zombies are no longer scanned.
    watchdog._resetForTests();
    const second = await watchdog.scanStaleRuns({ prisma });
    assert.equal(second.abandoned, 0);
    assert.equal(second.alerted, 0);
    assert.equal(second.alreadyAlerted, 1);
    assert.equal(captured.alerts.length, 1);
  } finally {
    captured.unload();
  }
});

test('one alert per run and severity (persisted); the owner hears once', async () => {
  const agentTaskRows = [
    { id: 'task-escalating', userId: 'user-7', status: 'running', updatedAt: isoAgo(20), createdAt: isoAgo(25) },
  ];
  const { prisma, notificationsCreated } = fakePrisma({ agentTaskRows });
  const audit = auditLogStore();
  prisma.auditLog = audit.auditLog;
  const captured = captureAlerts();
  try {
    await watchdog.scanStaleRuns({ prisma });
    watchdog._resetForTests();
    await watchdog.scanStaleRuns({ prisma });
    assert.equal(captured.alerts.length, 1, 'same severity after a restart: no second alert');

    // It keeps stalling past the critical line: exactly one escalation.
    agentTaskRows[0].updatedAt = isoAgo(60);
    watchdog._resetForTests();
    await watchdog.scanStaleRuns({ prisma });
    watchdog._resetForTests();
    await watchdog.scanStaleRuns({ prisma });
    assert.deepEqual(captured.alerts.map((a) => a.severity), ['warn', 'critical']);
    assert.equal(notificationsCreated.length, 1, 'the owner is notified on the first alert only');
  } finally {
    captured.unload();
  }
});

test('a zombie that moved since the scan is not closed; abandonment can be turned off', async () => {
  const agentTaskRows = [
    { id: 'task-racing', userId: 'user-1', status: 'running', updatedAt: isoAgo(30 * 60), createdAt: isoAgo(31 * 60) },
  ];
  const { prisma } = fakePrisma({ agentTaskRows });
  prisma.agentTask.updateMany = async () => ({ count: 0 }); // it progressed meanwhile
  const captured = captureAlerts();
  try {
    const res = await watchdog.scanStaleRuns({ prisma });
    assert.equal(res.abandoned, 0);
    assert.equal(agentTaskRows[0].status, 'running');
    assert.equal(watchdog.abandonMs({ STALE_RUN_ABANDON_HOURS: '0' }), 0);
    assert.equal(watchdog.abandonMs({}), 24 * 3600 * 1000);
    assert.equal(watchdog.abandonMs({ STALE_RUN_ABANDON_HOURS: '72' }), 72 * 3600 * 1000);
    watchdog._resetForTests();
    const off = await watchdog.scanStaleRuns({ prisma, env: { ...process.env, STALE_RUN_ABANDON_HOURS: '0' } });
    assert.equal(off.abandoned, 0);
  } finally {
    captured.unload();
  }
});
