'use strict';

const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const {
  createGitHubCodexConnector,
  normalizeGitHubConnectorError,
} = require('../services/github-codex-connector');

const router = express.Router();

router.use(authenticateToken);

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

router.get('/status', (_req, res) => {
  const connector = createGitHubCodexConnector();
  res.json({ github: connector.getStatus() });
});

router.get(
  '/repo',
  [
    query('repo').isString().trim().isLength({ min: 1, max: 240 }),
    query('branch').optional().isString().trim().isLength({ min: 1, max: 160 }),
    query('limit').optional().isInt({ min: 1, max: 20 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createGitHubCodexConnector();
      const context = await connector.getRepositoryContext({
        repository: req.query.repo,
        branch: req.query.branch,
        limit: req.query.limit,
      });
      res.json({ context });
    } catch (error) {
      const normalized = normalizeGitHubConnectorError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

module.exports = router;
