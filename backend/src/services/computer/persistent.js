'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { memberKey } = require('./member-key');
const { orchFetch, resolveOrchConfig } = require('./orch-client');
const { agentComputerEnabled, resolveObservationMode } = require('./flags');

const pexec = promisify(execFile);

const OBSERVE_TEXT_CAP = 8192;

function capObserveText(text, cap = OBSERVE_TEXT_CAP) {
  const raw = text == null ? '' : String(text);
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : OBSERVE_TEXT_CAP;
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit) + `\n...[observe truncated ${raw.length} -> ${limit} chars]`;
}

function enabled(env = process.env) {
  return agentComputerEnabled(env);
}

function isConfigured(env = process.env) {
  return resolveOrchConfig(env).enabled;
}

function computerToolsAvailable({ userId, env = process.env } = {}) {
  if (!userId) return false;
  return agentComputerEnabled(env) || isConfigured(env);
}

async function ensureSession(userId, env = process.env) {
  const key = memberKey({ id: userId }, env);
  const desktop = await orchFetch('/sessions', { method: 'POST', body: { userId: key }, env });
  return { ...desktop, userId: desktop.userId || key };
}

function agentUrl(session, suffix, env = process.env) {
  const cfg = resolveOrchConfig(env);
  return cfg.url + '/sessions/' + session.sessionId + '/agent' + suffix;
}

function cdpUrl(session, env = process.env) {
  if (session && session.cdpUrl && String(session.cdpUrl).includes('/sessions/')) {
    try {
      const cfg = resolveOrchConfig(env);
      const publicHost = new URL(session.cdpUrl);
      const internal = new URL(cfg.url);
      if (publicHost.hostname !== internal.hostname) {
        return cfg.url + '/sessions/' + session.sessionId + '/cdp';
      }
    } catch (_) { /* fall through */ }
  }
  const cfg = resolveOrchConfig(env);
  return cfg.url + '/sessions/' + session.sessionId + '/cdp';
}

async function agentGet(session, suffix, env = process.env) {
  const res = await fetch(agentUrl(session, suffix, env), { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'agent_get_failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

async function agentPost(session, suffix, body, env = process.env) {
  const res = await fetch(agentUrl(session, suffix, env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'agent_post_failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function containerName(session) {
  const slug = String(session.userId || 'luis').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return 'sira-ac-user-' + slug;
}

async function dockerExec(session, command) {
  const { stdout, stderr } = await pexec(
    'docker',
    ['exec', '-u', 'compuser', '-e', 'DISPLAY=:1', containerName(session), 'bash', '-lc', String(command || '')],
    { timeout: 25_000 },
  );
  return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || ''), container: containerName(session) };
}

function logStep(payload) {
  try {
    require('./control-loop').logStep(payload);
  } catch (_) {
    try { console.log(JSON.stringify({ evt: 'computer_step', ts: new Date().toISOString(), ...payload })); }
    catch (__) { /* ignore */ }
  }
}

function observeErrorResult(err, session) {
  const message = err && (err.detail || err.message) ? String(err.detail || err.message) : String(err || 'observe_failed');
  return {
    mode: 'cdp',
    backend: 'persistent',
    session: session || null,
    url: null,
    title: '',
    text: capObserveText('ERROR: computer_observe ' + message),
    error: message,
    ok: false,
  };
}

/**
 * Observe the member desktop. Models without vision (DeepSeek default)
 * get the Chrome CDP accessibility tree (text). Pixel PNGs are only used
 * when the model is listed in COMPUTER_VISION_MODELS.
 * Never throws: a CDP/screenshot failure becomes a tool-result error string.
 * CDP text is capped at ~8KiB so it cannot blow the next model call or SSE.
 */
async function observe(sessionOrUserId, opts = {}) {
  let session = null;
  try {
    const env = opts.env || process.env;
    session = (sessionOrUserId && typeof sessionOrUserId === 'object' && sessionOrUserId.sessionId)
      ? sessionOrUserId
      : await ensureSession(sessionOrUserId, env);
    const mode = resolveObservationMode({
      cdpMode: opts.cdpMode,
      model: opts.model,
      env,
    });
    logStep({ kind: 'observe', mode, sessionId: session.sessionId, model: opts.model || null });
    if (mode === 'cdp') {
      if (typeof opts.cdpConnect === 'function' || typeof opts.cdpSnapshot === 'function') {
        const snap = opts.cdpSnapshot || require('./cdp-client').snapshotAccessibility;
        const tree = await snap(cdpUrl(session, env), {
          playwrightImpl: opts.playwrightImpl,
          connect: opts.cdpConnect,
        });
        return {
          mode: 'cdp',
          backend: 'persistent',
          session,
          url: tree.url || null,
          title: tree.title || '',
          text: capObserveText(tree.text || '(empty)'),
          ok: true,
        };
      }
      const cdp = require('./cdp-client');
      let tree;
      try {
        tree = await cdp.snapshotViaDocker(containerName(session));
      } catch (dockerErr) {
        try {
          tree = await cdp.snapshotAccessibility(cdpUrl(session, env), {
            playwrightImpl: opts.playwrightImpl,
          });
        } catch (_) {
          return observeErrorResult(dockerErr, session);
        }
      }
      return {
        mode: 'cdp',
        backend: 'persistent',
        session,
        url: tree && tree.url || null,
        title: tree && tree.title || '',
        text: capObserveText((tree && tree.text) || '(empty)'),
        ok: true,
      };
    }
    const shot = await agentGet(session, '/screenshot', env);
    return {
      mode: 'screenshot',
      backend: 'persistent',
      session,
      shot,
      png: shot.pngBase64,
      mediaType: shot.mime || 'image/png',
      bytes: shot.bytes,
      ok: true,
    };
  } catch (err) {
    return observeErrorResult(err, session);
  }
}

module.exports = {
  enabled,
  isConfigured,
  computerToolsAvailable,
  ensureSession,
  agentGet,
  agentPost,
  dockerExec,
  containerName,
  cdpUrl,
  observe,
  logStep,
  capObserveText,
  OBSERVE_TEXT_CAP,
};
