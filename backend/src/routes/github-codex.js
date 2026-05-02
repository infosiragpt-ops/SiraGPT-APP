'use strict';

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const rag = require('../services/rag-service');
const {
  buildCodeFilesForRag,
  buildGitHubRagCollection,
  createGitHubCodexConnector,
  normalizeGitHubConnectorError,
} = require('../services/github-codex-connector');

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

function createGithubCodexRouter({
  authenticate = authenticateToken,
  ragService = rag,
  createConnector = createGitHubCodexConnector,
  normalizeError = normalizeGitHubConnectorError,
  codeFilesForRag = buildCodeFilesForRag,
  githubRagCollection = buildGitHubRagCollection,
} = {}) {
  const router = express.Router();

  router.use(authenticate);

  router.get('/status', (_req, res) => {
    const connector = createConnector();
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
      const connector = createConnector();
      const context = await connector.getRepositoryContext({
        repository: req.query.repo,
        branch: req.query.branch,
        limit: req.query.limit,
      });
      res.json({ context });
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.get(
  '/actions/runs',
  [
    query('repo').isString().trim().isLength({ min: 1, max: 240 }),
    query('branch').optional().isString().trim().isLength({ min: 1, max: 160 }),
    query('limit').optional().isInt({ min: 1, max: 30 }),
    query('status').optional().isString().trim().isLength({ min: 1, max: 40 }),
    query('event').optional().isString().trim().isLength({ min: 1, max: 80 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const result = await connector.listActionRuns({
        repository: req.query.repo,
        branch: req.query.branch,
        limit: req.query.limit,
        status: req.query.status,
        event: req.query.event,
      });
      res.json(result);
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.get(
  '/actions/runs/:runId/jobs',
  [
    query('repo').isString().trim().isLength({ min: 1, max: 240 }),
    param('runId').isInt({ min: 1 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const result = await connector.listActionJobs({
        repository: req.query.repo,
        runId: req.params.runId,
      });
      res.json(result);
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.get(
  '/actions/runs/:runId',
  [
    query('repo').isString().trim().isLength({ min: 1, max: 240 }),
    param('runId').isInt({ min: 1 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const result = await connector.getActionRun({
        repository: req.query.repo,
        runId: req.params.runId,
      });
      res.json(result);
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.post(
  '/actions/analyze-failure',
  [
    body('repo').isString().trim().isLength({ min: 1, max: 240 }),
    body('runId').isInt({ min: 1 }),
    body('includeLogs').optional().isBoolean(),
    body('maxLogBytes').optional().isInt({ min: 1000, max: 160000 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const result = await connector.analyzeActionFailure({
        repository: req.body.repo,
        runId: req.body.runId,
        includeLogs: req.body.includeLogs,
        maxLogBytes: req.body.maxLogBytes,
      });
      res.json(result);
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.get(
  '/files',
  [
    query('repo').isString().trim().isLength({ min: 1, max: 240 }),
    query('branch').optional().isString().trim().isLength({ min: 1, max: 160 }),
    query('limit').optional().isInt({ min: 1, max: 120 }),
    query('maxBytes').optional().isInt({ min: 1000, max: 120000 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const fileSet = await connector.getRepositoryFiles({
        repository: req.query.repo,
        branch: req.query.branch,
        limit: req.query.limit,
        maxBytes: req.query.maxBytes,
      });
      res.json({ fileSet });
    } catch (error) {
      const normalized = normalizeError(error);
      res.status(normalized.status).json(normalized.body);
    }
  },
);

  router.post(
  '/ingest',
  [
    body('repo').isString().trim().isLength({ min: 1, max: 240 }),
    body('branch').optional().isString().trim().isLength({ min: 1, max: 160 }),
    body('collection').optional().isString().trim().isLength({ min: 1, max: 180 }),
    body('limit').optional().isInt({ min: 1, max: 120 }),
    body('maxBytes').optional().isInt({ min: 1000, max: 120000 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    try {
      const connector = createConnector();
      const fileSet = await connector.getRepositoryFiles({
        repository: req.body.repo,
        branch: req.body.branch,
        limit: req.body.limit,
        maxBytes: req.body.maxBytes,
      });
      const collection = req.body.collection?.trim() || fileSet.collection;
      const files = codeFilesForRag(fileSet.files);
      const result = await ragService.ingestCode(req.user.id, collection, files);
      const bytesIndexed = fileSet.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
      res.json({
        ok: true,
        collection,
        repository: fileSet.repository,
        branch: fileSet.branch,
        filesIndexed: files.length,
        bytesIndexed,
        skipped: fileSet.skipped,
        limits: fileSet.limits,
        ...result,
      });
    } catch (error) {
      if (error?.name === 'GitHubCodexConnectorError' || error?.status) {
        const normalized = normalizeError(error);
        res.status(normalized.status).json(normalized.body);
        return;
      }
      console.error('[github-codex] RAG ingest failed:', error);
      res.status(500).json({ error: error.message || 'GitHub repository ingest failed' });
    }
  },
);

  router.post(
  '/retrieve',
  [
    body('query').isString().trim().isLength({ min: 1, max: 2000 }),
    body('repo').optional().isString().trim().isLength({ min: 1, max: 240 }),
    body('branch').optional().isString().trim().isLength({ min: 1, max: 160 }),
    body('collection').optional().isString().trim().isLength({ min: 1, max: 180 }),
    body('k').optional().isInt({ min: 1, max: 12 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;

    const collection = req.body.collection?.trim()
      || (req.body.repo ? githubRagCollection({ repository: req.body.repo, branch: req.body.branch }) : '');
    if (!collection) {
      res.status(400).json({ error: 'collection or repo is required' });
      return;
    }

    try {
      const k = Math.min(12, Math.max(1, Number.parseInt(req.body.k || 5, 10) || 5));
      const hits = await ragService.retrieve(req.user.id, collection, req.body.query, k, {
        useHybrid: true,
        useMMR: true,
        mmrLambda: 0.72,
      });
      res.json({ ok: true, collection, query: req.body.query, hits });
    } catch (error) {
      console.error('[github-codex] RAG retrieve failed:', error);
      res.status(500).json({ error: error.message || 'GitHub repository retrieve failed' });
    }
  },
);

  return router;
}

module.exports = createGithubCodexRouter();
module.exports.createGithubCodexRouter = createGithubCodexRouter;
