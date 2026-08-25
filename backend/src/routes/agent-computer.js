'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { agentComputerEnabled } = require('../services/computer/flags');
const { orchFetch, rewriteUrls, resolveOrchConfig } = require('../services/computer/orch-client');
const { memberKey, resolveSessionIdentity } = require('../services/computer/member-key');
const {
  ISOLATION_REFUSED_ES,
  OPEN_FAILED_ES,
  publicComputerError,
  isolationError,
  sessionMatchesConversation,
} = require('../services/computer/conversation-isolation');

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
  const body = req.body || {};
  const query = req.query || {};
  return String(
    body.conversationId || body.chatId || query.conversationId || query.chatId || '',
  ).trim();
}

function identityFor(req) {
  return resolveSessionIdentity({ id: memberId(req) }, readConversationId(req));
}

function withConversation(desktop, identity) {
  const orchUser = String((desktop && desktop.userId) || identity.userId);
  const bound = Boolean(identity.conversationId) && orchUser === identity.userId;
  return {
    ...desktop,
    userId: orchUser,
    conversationId: identity.conversationId,
    conversationBound: bound,
    sessionKey: identity.sessionKey,
  };
}

async function ensureMemberDesktop(req) {
  const identity = identityFor(req);
  if (identity.conversationId && !identity.conversationBound) {
    throw isolationError();
  }
  const desktop = await orchFetch('/sessions', { method: 'POST', body: { userId: identity.userId } });
  const orchUser = String((desktop && desktop.userId) || identity.userId);
  if (identity.conversationBound && orchUser !== String(identity.userId)) {
    throw isolationError();
  }
  return rewriteUrls(withConversation({ ...desktop, userId: desktop.userId || identity.userId }, identity));
}

function ownedOrDeny(session, req, res) {
  const identity = identityFor(req);
  if (identity.conversationBound) {
    if (!sessionMatchesConversation(session, identity)) {
      res.status(403).json({ error: 'isolation_required', message: ISOLATION_REFUSED_ES });
      return false;
    }
    return true;
  }
  const want = identity.userId || memberKey({ id: memberId(req) });
  if (!session || (session.userId && String(session.userId) !== String(want))) {
    res.status(403).json({ error: 'forbidden', message: OPEN_FAILED_ES });
    return false;
  }
  return true;
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

async function dockerExec(container, command) {
  const { stdout, stderr } = await pexec('docker', ['exec', '-u', 'compuser', '-e', 'DISPLAY=:1', container, 'bash', '-lc', command], { timeout: 20_000 });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

function sessionContainer(session) {
  const slug = String(session.userId || 'luis').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return 'sira-ac-user-' + slug;
}

async function handleAction(req, res, session) {
  const identity = identityFor(req);
  if (identity.conversationBound && !sessionMatchesConversation(session, identity)) {
    throw isolationError();
  }
  const focus = String((req.body && (req.body.focus || req.body.app)) || '').trim().toLowerCase();
  if (focus && FOCUS_CMDS[focus]) {
    const out = await dockerExec(sessionContainer(session), FOCUS_CMDS[focus]);
    return res.json({
      ok: true,
      focus,
      sessionId: session.sessionId,
      conversationId: identity.conversationId,
      conversationBound: identity.conversationBound,
      sessionKey: identity.sessionKey,
      ...out,
    });
  }
  const action = (req.body && req.body.action) || req.body || {};
  const orch = resolveOrchConfig();
  const target = orch.url + '/sessions/' + session.sessionId + '/agent/action';
  const forwarded = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  const data = await forwarded.json().catch(() => ({}));
  return res.status(forwarded.status).json(withConversation(data, identityFor(req)));
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
