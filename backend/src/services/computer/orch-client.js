'use strict';

/**
 * Thin HTTP client for the per-member agent-computer orchestrator.
 * Session identity is always userId (never a department). DeepSeek-only
 * loops live elsewhere; this module only talks to the orchestrator.
 */

function resolveOrchConfig(env = process.env) {
  const url = String(env.COMPUTER_ORCH_URL || '').replace(/\/$/, '');
  const secret = String(env.COMPUTER_ORCH_SECRET || '').trim();
  return {
    url,
    secret,
    enabled: Boolean(url && secret),
    timeoutMs: Number(env.COMPUTER_ORCH_TIMEOUT_MS) > 0
      ? Number(env.COMPUTER_ORCH_TIMEOUT_MS)
      : 30_000,
  };
}

async function orchFetch(path, { method = 'GET', body, env = process.env, fetchImpl } = {}) {
  const cfg = resolveOrchConfig(env);
  if (!cfg.enabled) {
    const err = new Error('computer orchestrator is not configured');
    err.code = 'ORCH_UNCONFIGURED';
    err.status = 503;
    throw err;
  }
  const fetchFn = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchFn(`${cfg.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `orchestrator HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveOrchConfig,
  orchFetch,
};
