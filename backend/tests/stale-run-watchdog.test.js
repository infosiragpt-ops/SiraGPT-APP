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
        if (where.status.nin) return agentTaskRows.filter((r) => !where.status.nin.includes(r.status));
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
