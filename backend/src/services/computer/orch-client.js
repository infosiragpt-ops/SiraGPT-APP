'use strict';

function resolveOrchConfig(env = process.env) {
  const url = String(
    env.AGENT_COMPUTER_ORCHESTRATOR_URL
    || env.COMPUTER_ORCH_URL
    || 'http://siragpt-computer-orchestrator:8090',
  ).replace(/\/$/, '');
  const secret = String(env.AGENT_COMPUTER_API_KEY || env.COMPUTER_ORCH_SECRET || '').trim();
  return {
    url,
    secret,
    enabled: Boolean(url),
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
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.secret) headers.Authorization = `Bearer ${cfg.secret}`;
    const res = await fetchFn(`${cfg.url}${path}`, {
      method,
      headers,
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

function publicBase(env = process.env) {
  return String(env.AGENT_COMPUTER_PUBLIC_BASE || 'https://computer.siragpt.com').replace(/\/$/, '');
}

function rewriteUrls(session, env = process.env) {
  const id = session && session.sessionId;
  if (!id) return session;
  const wsPath = 'sessions/' + id + '/novnc/websockify';
  const embedUrl = publicBase(env) + '/sessions/' + id + '/novnc/vnc.html?autoconnect=1&resize=scale&path=' + wsPath;
  return {
    ...session,
    embedUrl,
    novncEmbedUrl: embedUrl,
    novncUrl: embedUrl,
    novncWsUrl: publicBase(env).replace(/^http/, 'ws') + '/' + wsPath,
  };
}

module.exports = {
  resolveOrchConfig,
  orchFetch,
  rewriteUrls,
};
