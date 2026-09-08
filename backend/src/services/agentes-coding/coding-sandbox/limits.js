'use strict';

/**
 * CPU / RAM / PID / timeout stubs for the DEV adapter.
 * Values are recorded on the session and applied as docker-run flags.
 * They are not a production multi-tenant attestation.
 */

function parsePositiveInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveLimits(input = {}, env = process.env) {
  const cpus = String(input.cpus || env.AGENTES_CODING_SANDBOX_CPUS || '1').trim() || '1';
  const memory = String(input.memory || env.AGENTES_CODING_SANDBOX_MEMORY || '512m').trim() || '512m';
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
  return Object.freeze({
    cpus,
    memory,
    pids,
    timeoutMs,
    ttlMs,
    maxSessions,
    maxFileBytes,
  });
}

function dockerLimitArgs(limits) {
  return [
    '--memory', limits.memory,
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pids),
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--read-only',
    '--tmpfs', '/workspace:rw,exec,uid=10001,gid=10001,size=256m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--user', '10001:10001',
  ];
}

module.exports = {
  resolveLimits,
  dockerLimitArgs,
  parsePositiveInt,
};
