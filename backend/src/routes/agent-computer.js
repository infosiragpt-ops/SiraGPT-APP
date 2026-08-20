'use strict';

/**
 * User-facing proxy for the agent-computer orchestrator + agent loop.
 *
 * Hidden unless SIRAGPT_AGENT_COMPUTER=1 or NEXT_PUBLIC_AGENT_COMPUTER=1
 * (explicit). Existing /api/computer-use (Selkies/PNG) is unchanged.
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

router.get('/health', requireFlag, (_req, res) => {
  const orch = resolveOrchConfig();
  res.json({
    ok: true,
    enabled: true,
    orchestrator: orch.enabled,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  });
});

router.post('/sessions', requireFlag, authenticateToken, async (_req, res) => {
  try {
    const created = await orchFetch('/sessions', { method: 'POST' });
    return res.status(201).json(created);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.code || 'create_failed', message: err.message });
  }
});

router.get('/sessions/:id', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
    const session = await orchFetch(`/sessions/${req.params.id}`);
    return res.json(session);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'get_failed', message: err.message });
  }
});

router.post('/sessions/:id/renew', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
    const session = await orchFetch(`/sessions/${req.params.id}/renew`, { method: 'POST' });
    return res.json(session);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'renew_failed', message: err.message });
  }
});

router.delete('/sessions/:id', requireFlag, authenticateToken, param('id').isUUID(), async (req, res) => {
  if (failValidation(req, res)) return;
  try {
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
  async (req, res) => {
    if (failValidation(req, res)) return;
    try {
      const session = await orchFetch(`/sessions/${req.params.id}`);
      const result = await agentLoop({
        goal: req.body.goal,
        agentUrl: session.agentUrl,
        cdpUrl: session.cdpUrl,
        model: resolveComputerModel(req.body.model),
        cdpMode: req.body.cdpMode,
        signal: req.signal,
      });
      return res.json({ sessionId: req.params.id, ...result });
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'run_failed', message: err.message });
    }
  },
);

module.exports = router;
