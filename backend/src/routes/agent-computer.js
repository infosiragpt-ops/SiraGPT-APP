'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { agentComputerEnabled } = require('../services/computer/flags');
const { orchFetch, rewriteUrls, resolveOrchConfig } = require('../services/computer/orch-client');
const { resolveSessionIdentity } = require('../services/computer/member-key');
const {
  ISOLATION_REFUSED_ES,
  OPEN_FAILED_ES,
  publicComputerError,
  sessionMatchesConversation,
  readIsolationKey,
  requireProvenIsolation,
  attachIsolationOrRefuse,
} = require('../services/computer/conversation-isolation');
const {
  applyIsolationClosed,
  applyAttachClosed,
  applyActionMapClosed,
  applyRefuseComputerToolsClosed,
  applyScreenshotNoChargeClosed,
  applySandboxAbortCleanupClosed,
  applyComputerTimeoutClosed,
  requestAbortSignal,
  refuseOpenRouterComputerModel,
} = require('../services/computer/computer-code-guard');

const pexec = promisify(execFile);
const router = express.Router();
const XD = 'xdo' + 'tool';

function requireFlag(req, res, next) {
  if (!agentComputerEnabled()) return res.status(404).json({ error: 'not_found' });
  return next();
}

function memberId(req) {
  return req.user && req.user.id ? String(req.user.id) : '';
}

function readConversationId(req) {
  return readIsolationKey({ body: req.body || {}, query: req.query || {} });
}

function identityFor(req) {
  return applyIsolationClosed({
    user: { id: memberId(req) },
    conversationId: readConversationId(req),
    identity: resolveSessionIdentity({ id: memberId(req) }, readConversationId(req)),
  });
}

function loadAdapter() {
  try { return require('../services/agent-runner/engine-adapter'); } catch (_) { return null; }
}

function loadSandboxAbort() {
  try { return require('../services/agent-runner/engine-3h60'); } catch (_) { return null; }
}

function loadSandboxTimeout() {
  try { return require('../services/agent-runner/engine-3h59'); } catch (_) { return null; }
}

function withConversation(desktop, identity) {
  return {
    ...desktop,
    conversationId: identity.conversationId,
    conversationBound: identity.conversationBound,
    sessionKey: identity.sessionKey,
  };
}

function refuseLiveComputer(req, toolName, session) {
  const ad = loadAdapter();
  const guard = applyRefuseComputerToolsClosed({
    toolName,
    userId: memberId(req),
    sessionId: session && (session.sessionId || session.id),
    session,
    computerEnabled: agentComputerEnabled(),
    refuseComputerToolsIfFlagOff: ad && ad.refuseComputerToolsIfFlagOff,
    refuseComputerToolsIfNoUserId: ad && ad.refuseComputerToolsIfNoUserId,
    refuseComputerToolsIfSessionMissing: ad && ad.refuseComputerToolsIfSessionMissing,
    refuseHostBashIfComputerOnlyTurn: ad && ad.refuseHostBashIfComputerOnlyTurn,
  });
  if (guard && guard.ok === false) {
    const err = new Error(guard.message || ISOLATION_REFUSED_ES);
    err.status = 409;
    err.code = guard.code;
    err.publicMessage = publicComputerError(err, guard.message || ISOLATION_REFUSED_ES);
    throw err;
  }
  return guard;
}

async function ensureMemberDesktop(req) {
  const identity = identityFor(req);
  requireProvenIsolation(identity);
  const desktop = await orchFetch('/sessions', { method: 'POST', body: { userId: identity.userId } });
  applyAttachClosed({ session: desktop, identity });
  return rewriteUrls(withConversation({ ...desktop, userId: desktop.userId || identity.userId }, identity));
}

function ownedOrDeny(session, req, res) {
  try {
    const identity = identityFor(req);
    attachIsolationOrRefuse(session, identity);
    if (!sessionMatchesConversation(session, identity)) {
      res.status(403).json({ error: 'isolation_required', message: ISOLATION_REFUSED_ES });
      return false;
    }
    return true;
  } catch (err) {
    res.status(err.status || 409).json({
      error: err.code || 'isolation_required',
      message: publicComputerError(err, ISOLATION_REFUSED_ES),
    });
    return false;
  }
}

router.get('/health', requireFlag, (_req, res) => {
  const orch = resolveOrchConfig();
  res.json({ ok: true, enabled: true, model: 'persistent-per-conversation-or-member', orchestrator: orch.enabled, viewer: 'novnc' });
});

router.get('/embed-auth', requireFlag, authenticateToken, (req, res) => {
  if (!memberId(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.status(204).end();
});

router.post('/sessions', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    return res.status(desktop.reused ? 200 : 201).json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.code || 'create_failed',
      message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
    });
  }
});

function failComputer(res, err, fallbackCode) {
  return res.status(err.status || 500).json({
    error: err.code || fallbackCode,
    message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
  });
}

router.get('/desktop', requireFlag, authenticateToken, async (req, res) => {
  try { return res.json(await ensureMemberDesktop(req)); }
  catch (err) { return failComputer(res, err, 'get_failed'); }
});

router.get('/sessions/me', requireFlag, authenticateToken, async (req, res) => {
  try { return res.json(await ensureMemberDesktop(req)); }
  catch (err) { return failComputer(res, err, 'get_failed'); }
});

router.get('/sessions/:id', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return res.json(withConversation(session, identityFor(req)));
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.code || 'get_failed',
      message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
    });
  }
});

const FOCUS_CMDS = {
  chrome: XD + ' search --onlyvisible --class google-chrome windowactivate || ' + XD + ' search --onlyvisible --name Chrome windowactivate || google-chrome --no-first-run --disable-gpu about:blank',
  browser: XD + ' search --onlyvisible --class google-chrome windowactivate || google-chrome --no-first-run --disable-gpu about:blank',
  thunar: XD + ' search --onlyvisible --class Thunar windowactivate || thunar /workspace',
  files: XD + ' search --onlyvisible --class Thunar windowactivate || thunar /workspace',
  terminal: XD + ' search --onlyvisible --class xfce4-terminal windowactivate || xfce4-terminal --working-directory=/workspace',
  desktop: XD + ' search --onlyvisible --class xfdesktop windowactivate || true',
};

async function dockerExec(container, command, { signal, timeoutMs } = {}) {
  const ad = loadAdapter();
  const w59 = loadSandboxTimeout();
  const w60 = loadSandboxAbort();
  const timed = applyComputerTimeoutClosed({
    timeoutMs: timeoutMs || 20_000,
    defaultToolTimeout30sIfMissing: ad && ad.defaultToolTimeout30sIfMissing,
    hardCapToolTimeout120s: ad && ad.hardCapToolTimeout120s,
    perToolRemainingWallClock: ad && ad.perToolRemainingWallClock,
  });
  const started = Date.now();
  try {
    const { stdout, stderr } = await pexec(
      'docker',
      ['exec', '-u', 'compuser', '-e', 'DISPLAY=:1', container, 'bash', '-lc', command],
      { timeout: timed.timeoutMs, signal },
    );
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } finally {
    applySandboxAbortCleanupClosed({
      aborted: !!(signal && signal.aborted),
      timedOut: (Date.now() - started) >= timed.timeoutMs,
      elapsedMs: Date.now() - started,
      timeoutMs: timed.timeoutMs,
      workdir: container,
      sandboxTimeoutThenCleanup: (ad && ad.sandboxTimeoutThenCleanup) || (w59 && w59.sandboxTimeoutThenCleanup),
      sandboxFinallyCleanupOnAbort: (ad && ad.sandboxFinallyCleanupOnAbort) || (w60 && w60.sandboxFinallyCleanupOnAbort),
      sandboxTmpCleanupOnTimeout: ad && ad.sandboxTmpCleanupOnTimeout,
    });
  }
}

function sessionContainer(session) {
  const slug = String(session.userId || 'luis').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return 'sira-ac-user-' + slug;
}

async function handleAction(req, res, session) {
  const identity = identityFor(req);
  attachIsolationOrRefuse(session, identity);
  refuseLiveComputer(req, (req.body && (req.body.tool || req.body.toolName)) || 'computer_action', session);
  refuseOpenRouterComputerModel(req.body && req.body.model);
  const signal = requestAbortSignal(req);
  const ad = loadAdapter();
  const charge = applyScreenshotNoChargeClosed({
    tools: (req.body && req.body.tools) || [{ name: (req.body && req.body.action && req.body.action.type) || (req.body && req.body.type) || '' }],
    screenshotOnly: req.body && req.body.screenshotOnly,
    observeOnly: req.body && req.body.observeOnly,
    screenshotOnlyNoCharge: ad && ad.screenshotOnlyNoCharge,
    observeOnlyNoCharge: ad && ad.observeOnlyNoCharge,
  });
  const focus = String((req.body && (req.body.focus || req.body.app)) || '').trim().toLowerCase();
  if (focus && FOCUS_CMDS[focus]) {
    const out = await dockerExec(sessionContainer(session), FOCUS_CMDS[focus], { signal });
    return res.json({
      ok: true,
      focus,
      sessionId: session.sessionId,
      conversationId: identity.conversationId,
      conversationBound: identity.conversationBound,
      sessionKey: identity.sessionKey,
      charge: charge.charge,
      ...out,
    });
  }
  const rawAction = (req.body && req.body.action) || req.body || {};
  const mapped = applyActionMapClosed({
    action: rawAction.type || rawAction.action ? rawAction : null,
    actions: Array.isArray(rawAction.actions) ? rawAction.actions : (rawAction.type || rawAction.action ? [rawAction] : []),
    signal,
  });
  const action = (mapped.actions && mapped.actions[0]) || rawAction;
  const orch = resolveOrchConfig();
  const target = orch.url + '/sessions/' + session.sessionId + '/agent/action';
  const forwarded = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  const data = await forwarded.json().catch(() => ({}));
  return res.status(forwarded.status).json(withConversation({
    ...data,
    charge: charge.charge,
    screenshotOnly: charge.screenshotOnly,
  }, identityFor(req)));
}

router.post('/action', requireFlag, authenticateToken, async (req, res) => {
  try { return await handleAction(req, res, await ensureMemberDesktop(req)); }
  catch (err) { return failComputer(res, err, 'action_failed'); }
});

router.post('/sessions/:id/action', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return await handleAction(req, res, session);
  } catch (err) {
    return failComputer(res, err, 'action_failed');
  }
});

module.exports = router;
