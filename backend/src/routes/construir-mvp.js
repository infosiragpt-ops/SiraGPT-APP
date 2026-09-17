'use strict';

/**
 * CONSTRUIR coding MVP HTTP surface.
 *
 *   GET  /api/construir-mvp/health  → always 200, no AGENTES_CODING_V2 required
 *   POST /api/construir-mvp         → scaffold + artifacts (+ optional GitHub)
 *   POST /api/construir-mvp/repo/*  → open owned repo, edit in jail, open PR
 *
 * Flag AGENTES_CODING_V2 stays OFF. This path uses create_artifact storage
 * and the existing GitHub OAuth account.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');
const mvp = require('../services/construir-mvp');

function createConstruirMvpRouter(deps = {}) {
  const router = express.Router();
  const deliver = deps.deliver || mvp.deliverConstruirProject;
  const publishLast = deps.publishLast || mvp.publishLastProject;
  const openRepo = deps.openRepo || mvp.openRepo;
  const listRepoFiles = deps.listRepoFiles || mvp.listRepoFiles;
  const readRepoFile = deps.readRepoFile || mvp.readRepoFile;
  const writeRepoFile = deps.writeRepoFile || mvp.writeRepoFile;
  const execRepo = deps.execRepo || mvp.execRepo;
  const openPullRequest = deps.openPullRequest || mvp.openPullRequest;

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      enabled: true,
      flagRequired: false,
      agentesCodingV2: isAgentesCodingV2Enabled(deps.env || process.env),
      brandAliases: ['Sira Rápido', 'Sira Pro'],
      githubPrFlow: true,
      tools: [
        'github_open_repo',
        'github_repo_list',
        'github_repo_read',
        'github_repo_write',
        'github_repo_exec',
        'github_open_pull_request',
      ],
    });
  });

  router.post(
    '/',
    authenticateToken,
    [
      body('prompt').isString().trim().isLength({ min: 1, max: 4000 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('title').optional().isString().trim().isLength({ max: 72 }),
      body('modelAlias').optional().isString().trim().isLength({ max: 80 }),
      body('publishGithub').optional().isBoolean(),
      body('approved').optional().isBoolean(),
      body('repoName').optional().isString().trim().isLength({ max: 100 }),
      body('branch').optional().isString().trim().isLength({ max: 80 }),
      body('html').optional().isString().isLength({ max: 300_000 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await deliver({
          prompt: req.body.prompt,
          title: req.body.title,
          html: req.body.html,
          chatId: req.body.chatId,
          userId: req.user && req.user.id,
          modelAlias: req.body.modelAlias || req.body.model,
          publishGithub: req.body.publishGithub === true,
          approved: req.body.approved === true,
          repoName: req.body.repoName,
          branch: req.body.branch,
          saveArtifact: deps.saveArtifact,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
          env: deps.env || process.env,
        });
        return res.json(out);
      } catch (err) {
        console.error('[construir-mvp]', err && err.message);
        return res.status(500).json({ error: 'construir_failed' });
      }
    },
  );

  router.post(
    '/github',
    authenticateToken,
    [
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('repoName').optional().isString().trim().isLength({ max: 100 }),
      body('branch').optional().isString().trim().isLength({ max: 80 }),
      body('approved').isBoolean(),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await publishLast({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          repoName: req.body.repoName,
          branch: req.body.branch,
          approved: req.body.approved === true,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
        });
        const status = out.ok ? 200 : (out.code === 'E_GITHUB_CONNECT' ? 409 : 400);
        return res.status(status).json(out);
      } catch (err) {
        console.error('[construir-mvp] github', err && err.message);
        return res.status(500).json({ error: 'github_publish_failed' });
      }
    },
  );

  function sendMvpResult(res, out) {
    const status = out && out.ok
      ? 200
      : (out && out.code === 'E_GITHUB_CONNECT' ? 409 : 400);
    return res.status(status).json(out);
  }

  router.post(
    '/repo/open',
    authenticateToken,
    [
      body('owner').optional().isString().trim().isLength({ max: 100 }),
      body('repo').optional().isString().trim().isLength({ max: 200 }),
      body('fullName').optional().isString().trim().isLength({ max: 200 }),
      body('ref').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('modelAlias').optional().isString().trim().isLength({ max: 80 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await openRepo({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          owner: req.body.owner,
          repo: req.body.repo,
          fullName: req.body.fullName,
          ref: req.body.ref,
          modelAlias: req.body.modelAlias || req.body.model,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
          sandbox: deps.sandbox,
          execImpl: deps.execImpl,
          env: deps.env || process.env,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/open', err && err.message);
        return res.status(500).json({ error: 'github_repo_open_failed' });
      }
    },
  );

  router.post(
    '/repo/list',
    authenticateToken,
    [
      body('workspaceId').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('path').optional().isString().trim().isLength({ max: 400 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await listRepoFiles({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          workspaceId: req.body.workspaceId,
          path: req.body.path,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/list', err && err.message);
        return res.status(500).json({ error: 'github_repo_list_failed' });
      }
    },
  );

  router.post(
    '/repo/read',
    authenticateToken,
    [
      body('path').isString().trim().isLength({ min: 1, max: 400 }),
      body('workspaceId').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await readRepoFile({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          workspaceId: req.body.workspaceId,
          path: req.body.path,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/read', err && err.message);
        return res.status(500).json({ error: 'github_repo_read_failed' });
      }
    },
  );

  router.post(
    '/repo/write',
    authenticateToken,
    [
      body('path').isString().trim().isLength({ min: 1, max: 400 }),
      body('content').isString().isLength({ max: 400_000 }),
      body('workspaceId').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await writeRepoFile({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          workspaceId: req.body.workspaceId,
          path: req.body.path,
          content: req.body.content,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/write', err && err.message);
        return res.status(500).json({ error: 'github_repo_write_failed' });
      }
    },
  );

  router.post(
    '/repo/exec',
    authenticateToken,
    [
      body('command').isString().trim().isLength({ min: 1, max: 80 }),
      body('args').optional().isArray({ max: 16 }),
      body('workspaceId').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await execRepo({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          workspaceId: req.body.workspaceId,
          command: req.body.command,
          args: req.body.args,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/exec', err && err.message);
        return res.status(500).json({ error: 'github_repo_exec_failed' });
      }
    },
  );

  router.post(
    '/repo/pr',
    authenticateToken,
    [
      body('title').isString().trim().isLength({ min: 1, max: 180 }),
      body('body').optional().isString().isLength({ max: 4000 }),
      body('branch').optional().isString().trim().isLength({ max: 80 }),
      body('base').optional().isString().trim().isLength({ max: 80 }),
      body('approved').isBoolean(),
      body('workspaceId').optional().isString().trim().isLength({ max: 80 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await openPullRequest({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          workspaceId: req.body.workspaceId,
          title: req.body.title,
          body: req.body.body,
          branch: req.body.branch,
          base: req.body.base,
          approved: req.body.approved === true,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
          saveArtifact: deps.saveArtifact,
          env: deps.env || process.env,
        });
        return sendMvpResult(res, out);
      } catch (err) {
        console.error('[construir-mvp] repo/pr', err && err.message);
        return res.status(500).json({ error: 'github_pr_failed' });
      }
    },
  );

  return router;
}

module.exports = createConstruirMvpRouter();
module.exports.createConstruirMvpRouter = createConstruirMvpRouter;
