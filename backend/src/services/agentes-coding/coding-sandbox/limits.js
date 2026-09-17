'use strict';

/**
 * CPU / RAM / PID / timeout stubs for the DEV adapter.
 * Values are recorded on the session and applied as docker-run flags.
 * They are not a production multi-tenant attestation.
 */

const { fail } = require('./errors');

function resourceValue(value, kind, code) {
  if (typeof value !== 'string' && typeof value !== 'number') fail(code, 'Recurso inválido.');
  const text = String(value).trim().toLowerCase();
  const match = kind === 'cpus'
    ? /^(\d+(?:\.\d+)?)$/.exec(text)
    : /^(\d+(?:\.\d+)?)([bkmg])?$/.exec(text);
  if (!match) fail(code, 'Recurso inválido.');
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  const amount = Number(match[1]) * (scale[match[2]] || 1);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER) {
    fail(code, 'Recurso inválido.');
  }
  return { text, amount };
}

function boundedResource(requested, configured, fallback, kind) {
  const ceiling = resourceValue(configured ?? fallback, kind, 'E_PROVIDER');
  const value = resourceValue(requested ?? ceiling.text, kind, 'E_PARAMS');
  if (value.amount > ceiling.amount) fail('E_QUOTA', 'El recurso supera el tope del servidor.');
  return value.text;
}

function resolveExecTimeout(value, limits) {
  if (value == null) return limits.timeoutMs;
  if ((typeof value !== 'number' && typeof value !== 'string')
    || !String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 1) {
    fail('E_PARAMS', 'Tiempo máximo inválido.');
  }
  return Math.min(Math.floor(Number(value)), limits.timeoutMs);
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveLimits(input = {}, env = process.env) {
  const cpus = boundedResource(input.cpus, env.AGENTES_CODING_SANDBOX_CPUS, '1', 'cpus');
  const memory = boundedResource(input.memory, env.AGENTES_CODING_SANDBOX_MEMORY, '512m', 'memory');
  const pids = parsePositiveInt(input.pids || env.AGENTES_CODING_SANDBOX_PIDS, 64, 16, 256);
  const timeoutMs = parsePositiveInt(
    input.timeoutMs || env.AGENTES_CODING_SANDBOX_TIMEOUT_MS,
    30_000,
    100,
    10 * 60_000,
  );
  const ttlMs = parsePositiveInt(
    input.ttlMs || env.AGENTES_CODING_SANDBOX_TTL_MS,
    15 * 60_000,
    1_000,
    2 * 60 * 60_000,
  );
  const maxSessions = parsePositiveInt(env.AGENTES_CODING_SANDBOX_MAX_SESSIONS, 8, 1, 32);
  const maxFileBytes = parsePositiveInt(
    env.AGENTES_CODING_SANDBOX_MAX_FILE_BYTES,
    1 * 1024 * 1024,
    1,
    8 * 1024 * 1024,
  );
  const maxVolumeBytes = parsePositiveInt(
    env.AGENTES_CODING_SANDBOX_MAX_VOLUME_BYTES,
    256 * 1024 * 1024,
    1024,
    1024 * 1024 * 1024,
  );
  const maxVolumeFiles = parsePositiveInt(
    env.AGENTES_CODING_SANDBOX_MAX_VOLUME_FILES,
    500,
    1,
    5_000,
  );
  return Object.freeze({
    cpus,
    memory,
    pids,
    timeoutMs,
    ttlMs,
    maxSessions,
    maxFileBytes,
    maxVolumeBytes,
    maxVolumeFiles,
  });
}

function dockerLimitArgs(limits, opts = {}) {
  const workspace = opts.workspaceBind
    ? ['-v', `${opts.workspaceBind}:/workspace:rw`]
    : ['--tmpfs', '/workspace:rw,exec,uid=10001,gid=10001,size=256m'];
  return [
    '--memory', limits.memory,
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pids),
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--read-only',
    ...workspace,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--user', '10001:10001',
  ];
}

module.exports = {
  resolveLimits,
  dockerLimitArgs,
  parsePositiveInt,
  resolveExecTimeout,
};
