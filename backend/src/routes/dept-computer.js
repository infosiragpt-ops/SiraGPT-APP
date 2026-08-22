'use strict';

/**
 * Department Linux PC session + Caddy forward_auth.
 *
 *   GET|POST /api/departments/:id/computer/session?projectId=
 *   GET      /api/departments/:id/computer/auth?projectId=&ticket=
 *   POST     /api/departments/:id/computer/exec
 *   GET      /api/departments/:id/computer/frame
 *   GET      /api/departments/:id/computer/files
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const departments = require('../services/codex/company-departments');
const desktop = require('../services/codex/dept-real-pc');

const router = express.Router();

function setDesktopCookie(req, res, extraToken, ticket) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = extraToken || bearer || req.cookies?.token || req.cookies?.sira_dpc || '';
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  };
  if (token) {
    // Path=/ so Safari accepts the cookie from an /api response and then
    // sends it on /dept-os iframe + websocket + asset requests.
    res.cookie('sira_dpc', token, cookieOpts);
  }
  const pass = String(ticket || '').trim();
  if (pass) {
    res.cookie('sira_dpc_ticket', pass, cookieOpts);
  }
}

async function loadDesktopScope(req, res, projectId) {
  const scope = await desktop.ensureDesktopScope({
    prisma,
    userId: req.user?.id,
    projectId,
  });
  if (!scope.ok) {
    if (scope.error === 'project_not_found' || Number(scope.status) >= 500) {
      try {
        require('../services/software-errors/store').recordWebtopFailure({
          error: scope.error,
          message: scope.message,
          status: scope.status,
          projectId,
          departmentId: null,
        });
      } catch (_) { /* ignore */ }
    }
    res.status(scope.status).json({ error: scope.error, message: scope.message });
    return null;
  }
  return scope;
}

function departmentExists(scope, departmentId) {
  const rows = departments.readDepartments(scope);
  return rows.some((row) => row.id === departmentId);
}

function acceptForwardAuthCookie(req, _res, next) {
  if (!req.cookies?.token && req.cookies?.sira_dpc) {
    req.cookies.token = req.cookies.sira_dpc;
  }
  return next();
}

function ticketAllows(req, departmentId) {
  const ticket = String(req.query.ticket || req.headers['x-sira-dpc-ticket'] || req.cookies?.sira_dpc_ticket || '').trim();
  if (!ticket) return null;
  const granted = desktop.readDesktopTicket(ticket);
  if (!granted) return null;
  if (granted.departmentId && granted.departmentId !== departmentId) return null;
  const projectId = String(req.query.projectId || '').trim();
  if (projectId && granted.projectId && granted.projectId !== projectId) return null;
  return granted;
}

router.get('/:id/computer/auth', acceptForwardAuthCookie, async (req, res) => {
  try {
    const departmentId = String(req.params.id || '').trim();
    const granted = ticketAllows(req, departmentId);
    if (granted) {
      if (req.cookies?.sira_dpc) setDesktopCookie(req, res, req.cookies.sira_dpc);
      return res.status(204).end();
    }
    return authenticateToken(req, res, async () => {
      const scope = await loadDesktopScope(req, res, req.query.projectId);
      if (!scope) return undefined;
      if (!desktop.ID_RE.test(departmentId) || !departmentExists(scope, departmentId)) {
        return res.status(404).json({ error: 'department_not_found' });
      }
      setDesktopCookie(req, res);
      return res.status(204).end();
    });
  } catch (err) {
    return res.status(500).json({ error: 'department_computer_auth_failed', message: err.message });
  }
});

async function handleSession(req, res) {
  try {
    const departmentId = String(req.params.id || req.body?.departmentId || '').trim();
    const projectId = req.query.projectId || req.body?.projectId;
    const scope = await loadDesktopScope(req, res, projectId);
    if (!scope) return undefined;
    if (!desktop.ID_RE.test(departmentId) || !departmentExists(scope, departmentId)) {
      try {
        require('../services/software-errors/store').recordWebtopFailure({
          error: 'department_not_found',
          message: 'No se encontró el departamento.',
          status: 404,
          projectId,
          departmentId,
        });
      } catch (_) { /* ignore */ }
      return res.status(404).json({
        error: 'department_not_found',
        message: 'No se encontró el departamento.',
      });
    }
    const session = await desktop.ensureDepartmentDesktop({
      projectId: scope.id,
      departmentId,
    });
    const wantPrepare = String(req.method || '').toUpperCase() === 'POST' && !session.resumed;
    if (wantPrepare) {
      try {
        await desktop.prepareFullDesktop({
          projectId: scope.id,
          departmentId,
        });
      } catch (_) { /* windows are best-effort on first boot only */ }
    }
    const ticket = desktop.issueDesktopTicket({
      userId: req.user?.id,
      projectId: scope.id,
      departmentId,
    });
    setDesktopCookie(req, res, null, ticket);
    const url = session.url.includes('?')
      ? `${session.url}&ticket=${encodeURIComponent(ticket)}`
      : `${session.url}?ticket=${encodeURIComponent(ticket)}`;
    return res.json({
      url,
      ticket,
      projectId: scope.id,
      source: scope.source,
      created: Boolean(scope.created),
      container: session.container,
      persist: session.persist,
      resumed: session.resumed,
      image: session.image,
      runtime: session.runtime,
    });
  } catch (err) {
    try {
      require('../services/software-errors/store').recordWebtopFailure({
        error: err.message,
        message: err.detail || err.message,
        status: 500,
        projectId: req.query.projectId || req.body?.projectId,
        departmentId: req.params.id || req.body?.departmentId,
      });
    } catch (_) { /* ignore */ }
    const known = {
      department_computer_unavailable: 400,
      department_computer_start_failed: 502,
      department_computer_not_ready: 503,
    };
    const status = known[err?.message] || 500;
    const spanish = {
      department_computer_unavailable: 'No se pudo preparar la computadora del departamento.',
      department_computer_start_failed: 'No se pudo encender la computadora del departamento.',
      department_computer_not_ready: 'La computadora tardó demasiado en encender.',
    };
    return res.status(status).json({
      error: err.message || 'department_computer_failed',
      message: spanish[err?.message] || 'No se pudo encender la computadora del departamento.',
      detail: err.detail || undefined,
    });
  }
}

router.get('/:id/computer/session', authenticateToken, handleSession);
router.post('/:id/computer/session', authenticateToken, handleSession);

router.post('/:id/computer/exec', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || req.body?.departmentId || '').trim();
    const projectId = req.query.projectId || req.body?.projectId;
    const scope = await loadDesktopScope(req, res, projectId);
    if (!scope) return undefined;
    if (!desktop.ID_RE.test(departmentId) || !departmentExists(scope, departmentId)) {
      return res.status(404).json({ error: 'department_not_found', message: 'No se encontró el departamento.' });
    }
    const result = await desktop.execInDesktop({
      projectId: scope.id,
      departmentId,
      command: req.body?.command,
    });
    return res.json(result);
  } catch (err) {
    const known = {
      department_computer_unavailable: 400,
      department_computer_not_ready: 503,
    };
    const status = known[err?.message] || 500;
    return res.status(status).json({
      error: err.message || 'department_computer_exec_failed',
      message: err.detail || 'No se pudo ejecutar el comando en la computadora.',
    });
  }
});

router.post('/:id/computer/navigate', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || req.body?.departmentId || 'ceo-office').trim() || 'ceo-office';
    const projectId = req.query.projectId || req.body?.projectId;
    let scope = null;
    if (projectId) {
      scope = await loadDesktopScope(req, res, projectId);
      if (!scope) return undefined;
    }
    const result = await desktop.navigateDesktop({
      projectId: (scope && scope.id) || projectId,
      departmentId,
      url: req.body?.url,
    });
    return res.status(200).json(result);
  } catch (err) {
    const known = {
      department_computer_unavailable: 400,
      department_computer_not_ready: 503,
    };
    const status = err.status || known[err?.message] || 500;
    return res.status(status).json({
      error: err.message || 'department_computer_navigate_failed',
      message: err.detail || 'No se pudo abrir la URL en la computadora.',
    });
  }
});


router.get('/:id/computer/frame', acceptForwardAuthCookie, async (req, res) => {
  const departmentId = String(req.params.id || req.query.departmentId || 'ceo-office').trim() || 'ceo-office';
  const sendFrame = async () => {
    try {
      const projectId = req.query.projectId || (granted && granted.projectId) || req.body?.projectId;
      let scope = null;
      if (projectId && req.user) {
        scope = await loadDesktopScope(req, res, projectId);
        if (!scope) return undefined;
      }
      const result = await desktop.captureDesktopPng({
        projectId: (scope && scope.id) || projectId,
        departmentId,
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Sira-Computer-Container', result.container || '');
      res.setHeader('X-Sira-Computer-Bytes', String(result.bytes || result.png.length));
      if (Buffer.isBuffer(result.png) && result.png.length >= 24) {
        res.setHeader('X-Sira-Computer-Width', String(result.png.readUInt32BE(16)));
        res.setHeader('X-Sira-Computer-Height', String(result.png.readUInt32BE(20)));
      }
      return res.status(200).send(result.png);
    } catch (err) {
      const status = err.status || (err?.message === 'department_computer_not_ready' ? 503 : 500);
      return res.status(status).json({
        error: err.message || 'department_computer_frame_failed',
        message: err.detail || 'No se pudo capturar la pantalla.',
      });
    }
  };
  const granted = ticketAllows(req, departmentId);
  if (granted) {
    if (granted.userId && !req.user) req.user = { id: granted.userId };
    return sendFrame();
  }
  return authenticateToken(req, res, sendFrame);
});

router.post('/:id/computer/screenshot', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || req.body?.departmentId || 'ceo-office').trim() || 'ceo-office';
    const projectId = req.query.projectId || req.body?.projectId;
    let scope = null;
    if (projectId) {
      scope = await loadDesktopScope(req, res, projectId);
      if (!scope) return undefined;
    }
    const result = await desktop.screenshotDesktop({
      projectId: (scope && scope.id) || projectId,
      departmentId,
    });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || (err?.message === 'department_computer_not_ready' ? 503 : 500);
    return res.status(status).json({
      error: err.message || 'department_computer_screenshot_failed',
      message: err.detail || 'No se pudo capturar la pantalla.',
    });
  }
});

router.get('/:id/computer/files', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || '').trim();
    const projectId = req.query.projectId || req.body?.projectId;
    const scope = await loadDesktopScope(req, res, projectId);
    if (!scope) return undefined;
    if (!desktop.ID_RE.test(departmentId) || !departmentExists(scope, departmentId)) {
      return res.status(404).json({ error: 'department_not_found', message: 'No se encontró el departamento.' });
    }
    const result = await desktop.listDesktopFiles({
      projectId: scope.id,
      departmentId,
      rel: req.query.path,
    });
    return res.json(result);
  } catch (err) {
    const status = err?.message === 'department_computer_not_ready' ? 503 : 500;
    return res.status(status).json({
      error: err.message || 'department_computer_files_failed',
      message: err.detail || 'No se pudieron listar los archivos.',
    });
  }
});

router.delete('/:id/computer/session', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || '').trim();
    const projectId = req.query.projectId || (req.body && req.body.projectId);
    const scope = await loadDesktopScope(req, res, projectId);
    if (!scope) return undefined;
    // Shared CEO webtop stays up. Closing the pane must not stop it.
    return res.json({ ok: true, destroyed: false, skipped: true, reason: 'shared_always_on' });
  } catch (err) {
    return res.status(500).json({ error: 'department_computer_abort_failed', message: err.message });
  }
});


router.get('/:id/computer/status', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || req.query.departmentId || 'ceo-office').trim() || 'ceo-office';
    const projectId = req.query.projectId || req.body?.projectId;
    let scope = null;
    if (projectId) {
      scope = await loadDesktopScope(req, res, projectId);
      if (!scope) return undefined;
    }
    const result = await desktop.desktopStatus({
      projectId: (scope && scope.id) || projectId,
      departmentId,
    });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || (err?.message === 'department_computer_not_ready' ? 503 : 500);
    return res.status(status).json({
      error: err.message || 'department_computer_status_failed',
      message: err.detail || 'No se pudo leer el estado de la computadora.',
    });
  }
});

router.post('/:id/computer/apps', authenticateToken, async (req, res) => {
  try {
    const departmentId = String(req.params.id || req.body?.departmentId || 'ceo-office').trim() || 'ceo-office';
    const projectId = req.query.projectId || req.body?.projectId;
    let scope = null;
    if (projectId) {
      scope = await loadDesktopScope(req, res, projectId);
      if (!scope) return undefined;
    }
    const result = await desktop.openDesktopApp({
      projectId: (scope && scope.id) || projectId,
      departmentId,
      app: req.body?.app,
      mode: req.body?.mode,
    });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || knownStatus(err);
    return res.status(status).json({
      error: err.message || 'department_computer_apps_failed',
      message: err.detail || 'No se pudo abrir la aplicación en el escritorio.',
    });
  }
});

router.post('/:id/computer/input', acceptForwardAuthCookie, async (req, res) => {
  const departmentId = String(req.params.id || req.body?.departmentId || 'ceo-office').trim() || 'ceo-office';
  const run = async () => {
    try {
      const granted = ticketAllows(req, departmentId);
      const projectId = req.query.projectId || (granted && granted.projectId) || req.body?.projectId;
      let scope = null;
      if (projectId && req.user) {
        scope = await loadDesktopScope(req, res, projectId);
        if (!scope) return undefined;
      }
      const result = await desktop.inputDesktop({
        projectId: (scope && scope.id) || projectId,
        departmentId,
        action: req.body?.action,
        x: req.body?.x,
        y: req.body?.y,
        button: req.body?.button,
        dy: req.body?.dy,
        text: req.body?.text,
        key: req.body?.key,
      });
      return res.status(200).json(result);
    } catch (err) {
      const status = err.status || knownStatus(err);
      return res.status(status).json({
        error: err.message || 'department_computer_input_failed',
        message: err.detail || 'No se pudo enviar la entrada al escritorio.',
      });
    }
  };
  const granted = ticketAllows(req, departmentId);
  if (granted) {
    if (granted.userId && !req.user) req.user = { id: granted.userId };
    return run();
  }
  return authenticateToken(req, res, run);
});

function knownStatus(err) {
  const known = {
    department_computer_unavailable: 400,
    department_computer_not_ready: 503,
  };
  return known[err?.message] || 500;
}

module.exports = router;

