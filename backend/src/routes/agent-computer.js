'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { agentComputerEnabled } = require('../services/computer/flags');
const { orchFetch, rewriteUrls, resolveOrchConfig } = require('../services/computer/orch-client');
const { memberKey } = require('../services/computer/member-key');

const pexec = promisify(execFile);
const router = express.Router();
const XD = 'xdo' + 'tool';

function requireFlag(req, res, next) {
  if (!agentComputerEnabled()) return res.status(404).json({ error: 'not_found' });
  return next();
}

function setAgentComputerCookie(req, res) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = bearer || (req.cookies && req.cookies.token) || (req.cookies && req.cookies.sira_ac) || '';
  if (!token) return;
  res.cookie('sira_ac', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  });
  // Also refresh canonical session cookie so forward_auth sees req.cookies.token
  if (!(req.cookies && req.cookies.token)) {
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    });
  }
}

function acceptForwardAuthCookie(req, _res, next) {
  if (!(req.cookies && req.cookies.token) && req.cookies && req.cookies.sira_ac) {
    req.cookies.token = req.cookies.sira_ac;
  }
  return next();
}


function memberId(req) {
  return req.user && req.user.id ? String(req.user.id) : '';
}

async function ensureMemberDesktop(req) {
  const userId = memberKey({ id: memberId(req) });
  const desktop = await orchFetch('/sessions', { method: 'POST', body: { userId } });
  return rewriteUrls({ ...desktop, userId: desktop.userId || userId });
}

function ownedOrDeny(session, req, res) {
  const want = memberKey({ id: memberId(req) });
  if (!session || (session.userId && String(session.userId) !== String(want))) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

router.get('/health', requireFlag, (_req, res) => {
  const orch = resolveOrchConfig();
  res.json({ ok: true, enabled: true, model: 'persistent-per-member', orchestrator: orch.enabled, viewer: 'novnc' });
});

router.get('/embed-auth', requireFlag, acceptForwardAuthCookie, authenticateToken, (req, res) => {
  if (!memberId(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.status(204).end();
});

router.post('/sessions', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    setAgentComputerCookie(req, res);
    return res.status(desktop.reused ? 200 : 201).json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.code || 'create_failed', message: err.message });
  }
});

router.get('/desktop', requireFlag, authenticateToken, async (req, res) => {
  try { const desktop = await ensureMemberDesktop(req); setAgentComputerCookie(req, res); return res.json(desktop); }
  catch (err) { return res.status(err.status || 500).json({ error: 'get_failed', message: err.message }); }
});

router.get('/sessions/me', requireFlag, authenticateToken, async (req, res) => {
  try { const desktop = await ensureMemberDesktop(req); setAgentComputerCookie(req, res); return res.json(desktop); }
  catch (err) { return res.status(err.status || 500).json({ error: 'get_failed', message: err.message }); }
});

router.get('/sessions/:id', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return res.json(session);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'get_failed', message: err.message });
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
  const focus = String((req.body && (req.body.focus || req.body.app)) || '').trim().toLowerCase();
  if (focus && FOCUS_CMDS[focus]) {
    const out = await dockerExec(sessionContainer(session), FOCUS_CMDS[focus]);
    return res.json({ ok: true, focus, sessionId: session.sessionId, ...out });
  }
  const action = (req.body && req.body.action) || req.body || {};
  const orch = resolveOrchConfig();
  const target = orch.url + '/sessions/' + session.sessionId + '/agent/action';
  const forwarded = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  const data = await forwarded.json().catch(() => ({}));
  return res.status(forwarded.status).json(data);
}

router.post('/action', requireFlag, authenticateToken, async (req, res) => {
  try { return await handleAction(req, res, await ensureMemberDesktop(req)); }
  catch (err) { return res.status(err.status || 500).json({ error: 'action_failed', message: err.message }); }
});

router.post('/sessions/:id/action', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return await handleAction(req, res, session);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'action_failed', message: err.message });
  }
});

module.exports = router;

