'use strict';

/**
 * Live collectors for the software-error stream.
 * Prefer DB + health + queue failed jobs. Docker inspect is available
 * because the backend already mounts docker.sock. No invented rows.
 */

const { spawn } = require('child_process');
const store = require('./store');

const WATCHED_CONTAINERS = Object.freeze([
  { container: 'siragpt-backend-1', service: 'backend', compose: 'backend' },
  { container: 'siragpt-frontend-1', service: 'frontend', compose: 'frontend' },
]);

function runCmd(bin, args, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: err.message || 'spawn_failed' });
    });
  });
}

async function collectContainerHealth() {
  const found = [];
  for (const spec of WATCHED_CONTAINERS) {
    const inspected = await runCmd('docker', [
      'inspect',
      '-f',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} {{.State.Status}} {{.State.Running}}',
      spec.container,
    ], 8_000);
    if (inspected.code !== 0) {
      found.push({
        class: 'container_unhealthy',
        source: 'docker_health',
        service: spec.service,
        severity: 'critical',
        title: `${spec.container} ausente o ilegible`,
        detail: store.safeText(inspected.stderr || inspected.stdout, 400),
        repairClass: 'container_recreate',
        resourceId: spec.container,
        metadata: { container: spec.container, compose: spec.compose, inspectFailed: true },
        fingerprint: store.fingerprintOf(['container_unhealthy', spec.container]),
      });
      continue;
    }
    const [health, status, running] = inspected.stdout.split(/\s+/);
    const bad = health === 'unhealthy' || running === 'false' || status === 'exited' || status === 'dead';
    if (!bad) continue;
    found.push({
      class: 'container_unhealthy',
      source: 'docker_health',
      service: spec.service,
      severity: 'critical',
      title: `${spec.container} ${health || status || 'unhealthy'}`,
      detail: `health=${health || 'n/a'} status=${status || 'n/a'} running=${running || 'n/a'}`,
      repairClass: 'container_recreate',
      resourceId: spec.container,
      metadata: {
        container: spec.container,
        compose: spec.compose,
        health: health || null,
        status: status || null,
        running: running || null,
      },
      fingerprint: store.fingerprintOf(['container_unhealthy', spec.container]),
    });
  }
  return found;
}

function isRetryableJobError(message) {
  const text = String(message || '');
  return /timeout|etimedout|econnreset|econnrefused|enotfound|429|503|502|rate.?limit|temporar|eai_again|socket hang up|network/i.test(text);
}

async function collectBullmqFailed() {
  const found = [];
  if (!process.env.REDIS_URL) return found;
  let registry;
  try {
    ({ defaultQueueRegistry: registry } = require('../queues/queue-registry'));
  } catch {
    return found;
  }
  const definitions = typeof registry?.list === 'function' ? registry.list() : [];
  for (const definition of definitions) {
    let queue;
    try {
      queue = definition.getter();
    } catch {
      continue;
    }
    if (!queue || typeof queue.getFailed !== 'function') continue;
    let jobs = [];
    try {
      jobs = await queue.getFailed(0, 24);
    } catch {
      continue;
    }
    for (const job of jobs || []) {
      const failedReason = job?.failedReason || job?.stacktrace?.[0] || 'job_failed';
      const jobId = String(job?.id || '');
      if (!jobId) continue;
      found.push({
        class: 'bullmq_failed',
        source: 'bullmq',
        service: 'queue',
        severity: isRetryableJobError(failedReason) ? 'error' : 'warning',
        title: `Job fallido · ${definition.name} #${jobId}`,
        detail: store.safeText(failedReason, 600),
        repairClass: isRetryableJobError(failedReason) ? 'bullmq_retry' : null,
        resourceId: `${definition.name}:${jobId}`,
        metadata: {
          queue: definition.name,
          queueId: definition.id,
          jobId,
          attemptsMade: job?.attemptsMade ?? null,
          retryable: isRetryableJobError(failedReason),
        },
        fingerprint: store.fingerprintOf(['bullmq_failed', definition.name, jobId]),
      });
    }
  }
  return found;
}

async function collectHttpBuffer() {
  const events = store.drainHttpBuffer();
  return events.map((event) => {
    const uncaught = Boolean(event.uncaught);
    return {
      class: uncaught ? 'uncaught' : 'http_5xx',
      source: uncaught ? 'process' : 'http',
      service: 'backend',
      severity: uncaught ? 'critical' : 'error',
      title: uncaught
        ? `Excepción no capturada · ${event.kind || 'uncaught'}`
        : `${event.method} ${event.path} → ${event.status}`,
      detail: event.message,
      repairClass: null,
      resourceId: event.path,
      metadata: {
        method: event.method,
        path: event.path,
        status: event.status,
        requestId: event.requestId,
        kind: event.kind || null,
      },
      fingerprint: store.fingerprintOf([
        uncaught ? 'uncaught' : 'http_5xx',
        event.method,
        event.path,
        event.status,
        String(event.message || '').slice(0, 80),
      ]),
    };
  });
}

async function collectHealthProbes() {
  const found = [];
  let runFullHealthCheck;
  try {
    ({ runFullHealthCheck } = require('../observability/health-check'));
  } catch {
    return found;
  }
  if (typeof runFullHealthCheck !== 'function') return found;
  let snapshot;
  try {
    snapshot = await runFullHealthCheck({ env: process.env });
  } catch {
    return found;
  }
  const checks = Array.isArray(snapshot?.checks) ? snapshot.checks : [];
  for (const check of checks) {
    const name = String(check?.name || '');
    if (name !== 'generate_path' && name !== 'deepseek') continue;
    if (check.status === 'healthy' || check.status === 'skipped') continue;
    found.push({
      class: name === 'generate_path' ? 'generate_path' : 'deepseek',
      source: 'health',
      service: name,
      severity: check.status === 'unhealthy' ? 'error' : 'warning',
      title: `${name} ${check.status}`,
      detail: store.safeText(check.error || JSON.stringify(check.details || {}), 400),
      repairClass: null,
      resourceId: name,
      metadata: { status: check.status, details: check.details || null },
      fingerprint: store.fingerprintOf([name, check.status]),
    });
  }
  return found;
}


async function collectAuditErrors() {
  const found = [];
  const prisma = require('../../config/database');
  if (typeof prisma?.auditLog?.findMany !== 'function') return found;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const actions = [
    'api_error_reported',
    'render_error_reported',
    'rbac_bootstrap_not_ready',
  ];
  let rows = [];
  try {
    rows = await prisma.auditLog.findMany({
      where: {
        action: { in: actions },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    });
  } catch {
    return found;
  }
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
    if (row.action === 'api_error_reported' && tags.includes('warn') && !tags.includes('server-error') && !tags.includes('error')) {
      continue;
    }
    const page = meta.page || row.resourceType || '';
    const message = meta.message || meta.action || meta.error || row.action;
    found.push({
      class: row.action === 'render_error_reported' ? 'uncaught' : (row.action === 'rbac_bootstrap_not_ready' ? 'http_5xx' : 'http_5xx'),
      source: 'audit',
      service: 'backend',
      severity: tags.includes('server-error') || row.action === 'rbac_bootstrap_not_ready' ? 'error' : 'warning',
      title: store.safeText(`${row.action} ${page}`, 200) || row.action,
      detail: store.safeText(typeof message === 'string' ? message : JSON.stringify(message), 400),
      repairClass: null,
      resourceId: row.id,
      metadata: {
        auditId: row.id,
        page: page || null,
        tags,
      },
      fingerprint: store.fingerprintOf(['audit', row.action, row.id]),
    });
  }
  return found;
}

async function collectOauthBroken() {
  const found = [];
  const prisma = require('../../config/database');
  if (typeof prisma?.connectorAccount?.findMany !== 'function') return found;
  let rows = [];
  try {
    rows = await prisma.connectorAccount.findMany({
      where: {
        OR: [
          { status: 'broken' },
          { lastError: { not: null } },
        ],
      },
      select: {
        id: true,
        provider: true,
        status: true,
        lastError: true,
        lastHealthAt: true,
        updatedAt: true,
      },
      take: 40,
    });
  } catch {
    return found;
  }
  for (const row of rows) {
    if (!row.lastError && row.status !== 'broken') continue;
    found.push({
      class: 'oauth_connect',
      source: 'oauth',
      service: 'oauth',
      severity: 'error',
      title: `OAuth ${row.provider || 'connector'} ${row.status || 'broken'}`,
      detail: store.safeText(row.lastError, 400),
      repairClass: null,
      resourceId: row.id,
      metadata: {
        provider: row.provider,
        status: row.status,
        lastHealthAt: row.lastHealthAt,
      },
      fingerprint: store.fingerprintOf(['oauth_connect', row.provider, row.id]),
    });
  }
  return found;
}

async function collectAll() {
  const groups = await Promise.allSettled([
    collectContainerHealth(),
    collectBullmqFailed(),
    collectHttpBuffer(),
    collectHealthProbes(),
    collectOauthBroken(),
    collectAuditErrors(),
  ]);
  const found = [];
  for (const group of groups) {
    if (group.status === 'fulfilled' && Array.isArray(group.value)) {
      found.push(...group.value);
    }
  }
  return found;
}

module.exports = {
  WATCHED_CONTAINERS,
  collectAll,
  collectContainerHealth,
  collectBullmqFailed,
  collectHttpBuffer,
  collectHealthProbes,
  collectOauthBroken,
  collectAuditErrors,
  isRetryableJobError,
  runCmd,
};
