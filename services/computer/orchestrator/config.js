'use strict';

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseSwitch(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

function loadConfig(env = process.env) {
  // Idle reclaim is opt-in. The product model is one persistent desktop
  // per member; a 30-minute reaper must not destroy that by default.
  const idleReclaim = parseSwitch(env.COMPUTER_IDLE_RECLAIM) === true;
  const persistWorkspace = parseSwitch(env.COMPUTER_PERSIST_WORKSPACE) !== false;
  const ttlMs = clampInt(env.COMPUTER_TTL_MS, 24 * 60 * 60_000, 1_000, 7 * 24 * 60 * 60_000);
  return {
    port: clampInt(env.COMPUTER_ORCH_PORT, 18080, 1, 65535),
    bind: env.COMPUTER_ORCH_BIND || '127.0.0.1',
    secret: String(env.COMPUTER_ORCH_SECRET || '').trim(),
    image: env.COMPUTER_IMAGE || 'siragpt-computer:latest',
    ttlMs,
    idleReclaim,
    persistWorkspace,
    reaperMs: clampInt(env.COMPUTER_REAPER_MS, 30_000, 5_000, 5 * 60_000),
    novncBaseUrl: String(env.COMPUTER_NOVNC_BASE_URL || '').replace(/\/$/, ''),
    publicHost: env.COMPUTER_PUBLIC_HOST || '127.0.0.1',
    memoryBytes: 2 * 1024 * 1024 * 1024,
    nanoCpus: 2_000_000_000,
    shmSize: 1024 * 1024 * 1024,
    vncPassword: env.COMPUTER_VNC_PASSWORD || '',
    // Max concurrent member desktops on this host (not per-department).
    maxSessions: clampInt(env.COMPUTER_MAX_SESSIONS, 8, 1, 64),
    labelKey: 'siragpt.computer',
    labelValue: 'user-desktop',
    sessionLabel: 'sessionId',
    userLabel: 'userId',
    namePrefix: 'sira-acomp-',
    // Always-on CEO Office webtops — NEVER list/stop/recreate these.
    protectedNamePrefix: 'sira-dpc-',
  };
}

module.exports = { clampInt, parseSwitch, loadConfig };
