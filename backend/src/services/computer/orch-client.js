'use strict';

const ORCH_DOWN_ES = 'No se pudo abrir la computadora. El escritorio no está disponible.';
const FORBIDDEN_PUBLIC_HOST = /computer\.(siragpt|chatagic)\.com/i;

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

function orchUnavailable(cause) {
  const err = new Error(ORCH_DOWN_ES);
  err.status = 503;
  err.code = 'ORCH_UNAVAILABLE';
  err.publicMessage = ORCH_DOWN_ES;
  if (cause) err.cause = cause;
  return err;
}

function isTransportFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || err.cause || '');
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|aborted|network/i.test(msg);
}

async function orchFetch(path, { method = 'GET', body, env = process.env, fetchImpl } = {}) {
  const cfg = resolveOrchConfig(env);
  if (!cfg.enabled) {
    const err = orchUnavailable();
    err.code = 'ORCH_UNCONFIGURED';
    throw err;
  }
  const fetchFn = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.secret) headers.Authorization = `Bearer ${cfg.secret}`;
    let res;
    try {
      res = await fetchFn(`${cfg.url}${path}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw orchUnavailable(err);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const transportish = isTransportFailure({ message: data.message || data.error || '' });
      const err = new Error(transportish ? ORCH_DOWN_ES : (data.message || data.error || `orchestrator HTTP ${res.status}`));
      err.status = res.status >= 500 ? 503 : res.status;
      err.code = data.error || (res.status >= 500 ? 'ORCH_UNAVAILABLE' : 'ORCH_HTTP');
      err.body = data;
      if (transportish || res.status >= 500) err.publicMessage = ORCH_DOWN_ES;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function publicBase(env = process.env) {
  const raw = String(env.AGENT_COMPUTER_PUBLIC_BASE || 'https://siragpt.com').replace(/\/$/, '');
  if (!raw || FORBIDDEN_PUBLIC_HOST.test(raw)) return 'https://siragpt.com';
  return raw;
}

function publicPathPrefix(env = process.env) {
  try {
    const pathname = new URL(publicBase(env)).pathname.replace(/\/$/, '');
    return pathname === '/' ? '' : pathname;
  } catch (_) {
    return '';
  }
}

function rewriteUrls(session, env = process.env) {
  const id = session && session.sessionId;
  if (!id) return session;
  const base = publicBase(env);
  const prefix = publicPathPrefix(env);
  const wsPath = `${prefix ? prefix.replace(/^\//, '') + '/' : ''}sessions/${id}/novnc/websockify`;
  const embedUrl = `${base}/sessions/${id}/novnc/vnc.html?autoconnect=1&resize=scale&path=${wsPath}`;
  return {
    ...session,
    embedUrl,
    novncEmbedUrl: embedUrl,
    novncUrl: embedUrl,
    novncWsUrl: `${base.replace(/^http/, 'ws')}/${wsPath}`,
  };
}

module.exports = {
  resolveOrchConfig,
  orchFetch,
  rewriteUrls,
  publicBase,
  publicPathPrefix,
  ORCH_DOWN_ES,
};
