'use strict';

/**
 * Safe autonomous repairs only.
 * Allowed:
 *   - recreate compose service backend|frontend (never down -v)
 *   - retry a retryable BullMQ job once
 *   - restart a dept webtop session via folder-aware ensureDepartmentDesktop
 * Forbidden: pay, rotate secrets, drop DB, iliagpt DNS, OpenRouter, volume wipes.
 */

const path = require('path');
const store = require('./store');
const { runCmd, isRetryableJobError } = require('./collectors');

const COMPOSE_CWD = process.env.SIRAGPT_COMPOSE_CWD || '/opt/siragpt';
const COMPOSE_FILES = Object.freeze([
  path.join(COMPOSE_CWD, 'docker-compose.prod.yml'),
  path.join(COMPOSE_CWD, 'docker-compose.production.override.yml'),
]);
const COMPOSE_ENV = path.join(COMPOSE_CWD, '.env');
const ALLOWED_COMPOSE = new Set(['backend', 'frontend']);
const FORBIDDEN = /down\s+-v|drop\s+(database|schema|table)|rotate.?secret|openrouter|iliagpt|auto-?pay|rm\s+-rf/i;
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

const lastRepairAt = new Map();

function composeArgs(service) {
  return [
    'compose',
    '-f', COMPOSE_FILES[0],
    '-f', COMPOSE_FILES[1],
    '--env-file', COMPOSE_ENV,
    'up', '-d', '--no-deps', '--force-recreate',
    service,
  ];
}

function assertSafe(commandText) {
  if (FORBIDDEN.test(String(commandText || ''))) {
    const err = new Error('repair_forbidden');
    err.detail = 'Acción bloqueada por la política de reparación segura.';
    throw err;
  }
}

async function recreateComposeService(service) {
  const name = String(service || '').trim();
  if (!ALLOWED_COMPOSE.has(name)) {
    const err = new Error('repair_forbidden');
    err.detail = `Servicio no permitido: ${name}`;
    throw err;
  }
  const args = composeArgs(name);
  assertSafe(args.join(' '));
  const result = await runCmd('docker', args, 180_000);
  if (result.code !== 0) {
    const err = new Error('repair_failed');
    err.detail = store.safeText(result.stderr || result.stdout, 500);
    throw err;
  }
  return { ok: true, service: name, stdout: store.safeText(result.stdout, 300) };
}

async function retryBullmqJob(queueName, jobId) {
  const { defaultQueueRegistry: registry } = require('../queues/queue-registry');
  const definition = registry.get(queueName);
  if (!definition) {
    const err = new Error('queue_not_found');
    err.detail = `Cola no encontrada: ${queueName}`;
    throw err;
  }
  const queue = definition.getter();
  if (!queue || typeof queue.getJob !== 'function') {
    const err = new Error('queue_unavailable');
    err.detail = 'La cola no expone getJob().';
    throw err;
  }
  const job = await queue.getJob(String(jobId));
  if (!job) {
    const err = new Error('job_not_found');
    err.detail = `Job ${jobId} ya no existe.`;
    throw err;
  }
  const reason = job.failedReason || '';
  if (!isRetryableJobError(reason)) {
    const err = new Error('not_retryable');
    err.detail = store.safeText(reason, 300) || 'El error no es reintentable.';
    throw err;
  }
  if (typeof job.retry !== 'function') {
    const err = new Error('retry_unavailable');
    err.detail = 'BullMQ no expone retry() en este job.';
    throw err;
  }
  await job.retry();
  return { ok: true, queue: queueName, jobId: String(jobId) };
}

async function restartWebtopSession({ projectId, departmentId }) {
  const desktop = require('../codex/dept-real-pc');
  const pid = String(projectId || '').trim();
  const did = String(departmentId || '').trim();
  if (!pid || !did) {
    const err = new Error('webtop_scope_missing');
    err.detail = 'Falta projectId o departmentId para reiniciar la sesión.';
    throw err;
  }
  const session = await desktop.ensureDepartmentDesktop({
    projectId: pid,
    departmentId: did,
  });
  return {
    ok: true,
    url: session?.url || null,
    container: session?.container || null,
    resumed: Boolean(session?.resumed),
  };
}

function cooldownKey(row) {
  return `${row.repairClass || row.class}:${row.resourceId || row.fingerprint}`;
}

function inCooldown(row) {
  const key = cooldownKey(row);
  const last = lastRepairAt.get(key);
  return Boolean(last && (Date.now() - last) < REPAIR_COOLDOWN_MS);
}

function markCooldown(row) {
  lastRepairAt.set(cooldownKey(row), Date.now());
}

function canAutoRepair(row) {
  if (!row || !row.repairClass) return false;
  if (row.status === 'repaired' || row.status === 'repairing') return false;
  if (row.repairClass === 'bullmq_retry' && Number(row.repairAttempts || 0) >= 1) return false;
  if (row.repairClass === 'container_recreate' && inCooldown(row)) return false;
  return ['container_recreate', 'bullmq_retry', 'webtop_session_start'].includes(row.repairClass);
}

async function attempt(row, { manual = false } = {}) {
  if (!row?.id) throw new Error('missing_error');
  if (!row.repairClass) {
    const err = new Error('no_safe_repair');
    err.detail = 'No hay una reparación automática segura para esta clase.';
    throw err;
  }
  if (!manual && !canAutoRepair(row)) {
    const err = new Error('repair_not_eligible');
    err.detail = 'Esta incidencia ya se intentó o está en espera.';
    throw err;
  }

  const started = await store.setStatus(row.id, 'repairing', {
    touchRepair: true,
    incAttempts: true,
    detail: 'Reparación automática en curso.',
  });
  await store.writeLifecycleAudit(
    'repair_started',
    started,
    `Iniciando reparación segura (${row.repairClass}).`,
    { manual },
  );
  markCooldown(started);

  try {
    let result;
    if (row.repairClass === 'container_recreate') {
      const service = row.metadata?.compose || row.service;
      result = await recreateComposeService(service);
    } else if (row.repairClass === 'bullmq_retry') {
      result = await retryBullmqJob(row.metadata?.queue, row.metadata?.jobId);
    } else if (row.repairClass === 'webtop_session_start') {
      result = await restartWebtopSession({
        projectId: row.metadata?.projectId,
        departmentId: row.metadata?.departmentId,
      });
    } else {
      const err = new Error('repair_forbidden');
      err.detail = 'Clase de reparación no permitida.';
      throw err;
    }

    const ok = await store.setStatus(row.id, 'repaired', {
      detail: 'Reparación automática completada.',
    });
    await store.writeLifecycleAudit(
      'repair_succeeded',
      ok,
      'Reparación automática completada.',
      { result },
    );
    return { ok: true, row: ok, result };
  } catch (err) {
    const nextStatus = row.repairClass === 'bullmq_retry' ? 'needs_attention' : 'needs_attention';
    const failed = await store.setStatus(row.id, nextStatus, {
      detail: store.safeText(err.detail || err.message, 400),
    });
    await store.writeLifecycleAudit(
      'repair_failed',
      failed,
      store.safeText(err.detail || err.message, 400) || 'La reparación automática falló.',
    );
    return { ok: false, row: failed, error: err.detail || err.message };
  }
}

module.exports = {
  ALLOWED_COMPOSE,
  canAutoRepair,
  attempt,
  recreateComposeService,
  retryBullmqJob,
  restartWebtopSession,
};
