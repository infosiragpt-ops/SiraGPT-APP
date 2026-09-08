'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { memberKey, resolveSessionIdentity } = require('./member-key');
const { orchFetch, resolveOrchConfig } = require('./orch-client');
const { agentComputerEnabled, resolveObservationMode } = require('./flags');
const { requireProvenIsolation } = require('./conversation-isolation');
const loginHandoff = require('./login-handoff');
const {
  applyIsolationClosed,
  applySandboxAbortCleanupClosed,
  applyComputerTimeoutClosed,
  applyRefuseComputerToolsClosed,
  applyScreenshotNoChargeClosed,
} = require('./computer-code-guard');

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

function loadAdapter() {
  try { return require('../agent-runner/engine-adapter'); } catch (_) { return null; }
}

function computerToolsAvailable({ userId, env = process.env } = {}) {
  if (!userId) return false;
  const ad = loadAdapter();
  const refused = applyRefuseComputerToolsClosed({
    toolName: 'computer_observe',
    userId,
    computerEnabled: agentComputerEnabled(env) || isConfigured(env),
    refuseComputerToolsIfFlagOff: ad && ad.refuseComputerToolsIfFlagOff,
    refuseComputerToolsIfNoUserId: ad && ad.refuseComputerToolsIfNoUserId,
  });
  if (refused && refused.ok === false) return false;
  return agentComputerEnabled(env) || isConfigured(env);
}

async function ensureSession(userId, env = process.env, extra = {}) {
  const opts = (userId && typeof userId === 'object') ? userId : { userId, ...extra };
  const id = String((opts.userId || opts.id || (typeof userId === 'string' ? userId : '')) || '').trim();
  const conversationId = String(opts.conversationId || opts.workspaceId || extra.conversationId || '').trim();
  const identity = applyIsolationClosed({
    user: { id },
    conversationId,
    identity: resolveSessionIdentity({ id }, conversationId, opts.env || env),
  });
  requireProvenIsolation(identity);
  const desktop = await orchFetch('/sessions', { method: 'POST', body: { userId: identity.userId }, env: opts.env || env });
  return {
    ...desktop,
    userId: desktop.userId || identity.userId,
    conversationId: identity.conversationId,
    conversationBound: identity.conversationBound,
    sessionKey: identity.sessionKey,
    memberKey: identity.memberKey || memberKey({ id }, opts.env || env),
  };
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

async function dockerExec(session, command, { signal, timeoutMs } = {}) {
  const ad = loadAdapter();
  const timed = applyComputerTimeoutClosed({
    timeoutMs: timeoutMs || 25_000,
    defaultToolTimeout30sIfMissing: ad && ad.defaultToolTimeout30sIfMissing,
    hardCapToolTimeout120s: ad && ad.hardCapToolTimeout120s,
    perToolRemainingWallClock: ad && ad.perToolRemainingWallClock,
  });
  const started = Date.now();
  try {
    const { stdout, stderr } = await pexec(
      'docker',
      ['exec', '-u', 'compuser', '-e', 'DISPLAY=:1', containerName(session), 'bash', '-lc', String(command || '')],
      { timeout: timed.timeoutMs, signal },
    );
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || ''), container: containerName(session) };
  } finally {
    applySandboxAbortCleanupClosed({
      aborted: !!(signal && signal.aborted),
      timedOut: (Date.now() - started) >= timed.timeoutMs,
      elapsedMs: Date.now() - started,
      timeoutMs: timed.timeoutMs,
      workdir: containerName(session),
      sandboxTimeoutThenCleanup: ad && ad.sandboxTimeoutThenCleanup,
      sandboxFinallyCleanupOnAbort: ad && ad.sandboxFinallyCleanupOnAbort,
      sandboxTmpCleanupOnTimeout: ad && ad.sandboxTmpCleanupOnTimeout,
    });
  }
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
        return loginHandoff.applyObserveHandoff(session, {
          mode: 'cdp',
          backend: 'persistent',
          session,
          url: tree.url || null,
          title: tree.title || '',
          text: capObserveText(tree.text || '(empty)'),
          ok: true,
        }, { conversationId: session.conversationId, identity: session });
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
      return loginHandoff.applyObserveHandoff(session, {
        mode: 'cdp',
        backend: 'persistent',
        session,
        url: tree && tree.url || null,
        title: tree && tree.title || '',
        text: capObserveText((tree && tree.text) || '(empty)'),
        ok: true,
      }, { conversationId: session.conversationId, identity: session });
    }
    const shot = await agentGet(session, '/screenshot', env);
    const ad = loadAdapter();
    const charge = applyScreenshotNoChargeClosed({
      tools: [{ name: 'computer_screenshot' }],
      screenshotOnly: true,
      screenshotOnlyNoCharge: ad && ad.screenshotOnlyNoCharge,
      observeOnlyNoCharge: ad && ad.observeOnlyNoCharge,
    });
    let peek = { url: null, title: '', text: '' };
    try { peek = await peekPage(session, env); } catch (_) { /* URL peek is best-effort */ }
    return loginHandoff.applyObserveHandoff(session, {
      mode: 'screenshot',
      backend: 'persistent',
      session,
      shot,
      png: shot.pngBase64,
      mediaType: shot.mime || 'image/png',
      bytes: shot.bytes,
      charge: charge.charge,
      screenshotOnly: true,
      url: peek.url || null,
      title: peek.title || '',
      text: capObserveText(peek.text || ''),
      ok: true,
    }, { conversationId: session.conversationId, identity: session });
  } catch (err) {
    return observeErrorResult(err, session);
  }
}

async function peekPage(session, env = process.env) {
  const cdp = require('./cdp-client');
  try {
    return await cdp.peekPageContext(cdpUrl(session, env), { timeoutMs: 4000 });
  } catch (_) {
    try {
      return await cdp.peekViaDocker(containerName(session));
    } catch (__) {
      return { url: null, title: '', text: '' };
    }
  }
}

async function peekExisting(identity, env = process.env) {
  if (!identity) return { url: null, title: '', text: '' };
  try {
    const cdp = require('./cdp-client');
    return await cdp.peekViaDocker(containerName({ userId: identity.userId || identity.memberKey }));
  } catch (_) {
    return loginHandoff.getLastObserve(identity) || { url: null, title: '', text: '' };
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
  peekPage,
  peekExisting,
  logStep,
  capObserveText,
  OBSERVE_TEXT_CAP,
};
