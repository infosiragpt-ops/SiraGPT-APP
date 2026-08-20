'use strict';

/**
 * User-facing proxy for the agent-computer orchestrator + agent loop.
 *
 * Hidden unless SIRAGPT_AGENT_COMPUTER=1 or NEXT_PUBLIC_AGENT_COMPUTER=1
 * (explicit). Existing /api/computer-use (Selkies/PNG) is unchanged.
 *
 * One persistent desktop per authenticated member. Department is not a
 * security boundary — every department agent of that user shares the same
 * XFCE session. Human viewer is noVNC; PNGs stay in the agent loop.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { agentComputerEnabled, resolveComputerModel } = require('../services/computer/flags');
const { orchFetch, resolveOrchConfig } = require('../services/computer/orch-client');
const { agentLoop } = require('../services/computer/agent-loop');

const router = express.Router();

function requireFlag(req, res, next) {
  if (!agentComputerEnabled()) {
    return res.status(404).json({ error: 'not_found' });
  }
  return next();
}

function failValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return true;
  }
  return false;
}

function memberId(req) {
  return req.user && req.user.id ? String(req.user.id) : '';
}

function ownedOrDeny(session, userId, res) {
  if (!session || !session.userId || String(session.userId) !== String(userId)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

async function ensureMemberDesktop(req) {
  return orchFetch('/sessions', {
    method: 'POST',
    body: { userId: memberId(req) },
  });
}

router.get('/health', requireFlag, (_req, res) => {
  const orch = resolveOrchConfig();
  res.json({
    ok: true,
    enabled: true,
    model: 'persistent-per-member',
    orchestrator: orch.enabled,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    viewer: 'novnc',
    note: 'PNG screenshots are for the agent loop only. Humans use noVNC.',
  });
});

router.post('/sessions', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    return res.status(desktop.created ? 201 : 200).json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.code || 'create_failed', message: err.message });
  }
});

router.get('/desktop', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    return res.json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'get_failed', message: err.message });
  }
});

router.get('/sessions/me', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    return res.json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'get_failed', message: err.message });
  }
});

router.get('/sessions/:id', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
    const session = await orchFetch(`/sessions/${req.params.id}`);
    if (!ownedOrDeny(session, memberId(req), res)) return;
    return res.json(session);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'get_failed', message: err.message });
  }
});

router.post('/sessions/:id/renew', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
    const session = await orchFetch(`/sessions/${req.params.id}`);
    if (!ownedOrDeny(session, memberId(req), res)) return;
    const renewed = await orchFetch(`/sessions/${req.params.id}/renew`, { method: 'POST' });
    return res.json(renewed);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'renew_failed', message: err.message });
  }
});

router.delete('/sessions/:id', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
    const session = await orchFetch(`/sessions/${req.params.id}`);
    if (!ownedOrDeny(session, memberId(req), res)) return;
    const result = await orchFetch(`/sessions/${req.params.id}`, { method: 'DELETE' });
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'destroy_failed', message: err.message });
  }
});

router.post(
  '/sessions/:id/run',
  requireFlag,
  authenticateToken,
  param('id').isUUID(),
  body('goal').isString().trim().isLength({ min: 1, max: 4000 }),
  body('model').optional().isString().isLength({ max: 64 }),
  body('cdpMode').optional().isBoolean(),
  body('taskId').optional().isString().matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  async (req, res) => {
    if (failValidation(req, res)) return;
    try {
      const session = await orchFetch(`/sessions/${req.params.id}`);
      if (!ownedOrDeny(session, memberId(req), res)) return;
      const result = await agentLoop({
        goal: req.body.goal,
        taskId: req.body.taskId,
        agentUrl: session.agentUrl,
        cdpUrl: session.cdpUrl,
        model: resolveComputerModel(req.body.model),
        cdpMode: req.body.cdpMode,
        signal: req.signal,
      });
      return res.json({ sessionId: req.params.id, userId: session.userId, ...result });
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'run_failed', message: err.message });
    }
  },
);

router.post(
  '/desktop/run',
  requireFlag,
  authenticateToken,
  body('goal').isString().trim().isLength({ min: 1, max: 4000 }),
  body('model').optional().isString().isLength({ max: 64 }),
  body('cdpMode').optional().isBoolean(),
  body('taskId').optional().isString().matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  async (req, res) => {
    if (failValidation(req, res)) return;
    try {
      const session = await ensureMemberDesktop(req);
      const result = await agentLoop({
        goal: req.body.goal,
        taskId: req.body.taskId,
        agentUrl: session.agentUrl,
        cdpUrl: session.cdpUrl,
        model: resolveComputerModel(req.body.model),
        cdpMode: req.body.cdpMode,
        signal: req.signal,
      });
      return res.json({ sessionId: session.sessionId, userId: session.userId, ...result });
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'run_failed', message: err.message });
    }
  },
);

module.exports = router;
