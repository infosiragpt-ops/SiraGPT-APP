'use strict';

/**
 * github-search route — unified discovery over GitHub repositories, code,
 * issues/PRs, users/orgs and topics, plus README retrieval.
 *
 *   POST /api/github-search
 *     body: { query, type?, limit?, language?, sort?, order?, minStars?, repo?, timeoutMs? }
 *     →    { items, type, count, errors, authenticated }
 *
 *   POST /api/github-search/all
 *     body: { query, limit?, language?, types?, timeoutMs? }
 *     →    { repositories, code, issues, users, errors, authenticated }
 *
 *   GET  /api/github-search/readme?owner=&repo=&maxChars=
 *     →    { repository, path, htmlUrl, content, truncated }
 *
 *   GET  /api/github-search/health
 *     →    { ok, types, authenticated, cache }
 *
 * Auth: requires authenticateToken so anonymous traffic doesn't burn through
 * GitHub's (low) search rate limit.
 */

const express = require('express');
const { body, query: q, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { responseCache } = require('../middleware/response-cache');
const githubSearch = require('../services/github-search');
const githubCache = require('../services/github-search-cache');

const router = express.Router();

router.get('/health', responseCache({ ttlMs: 60_000, namespace: 'gh-search-health' }), (req, res) => {
  res.json({
    ok: true,
    types: githubSearch.TYPES,
    authenticated: githubSearch.hasToken(),
    cache: githubCache.stats(),
  });
});

function failValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return true;
  }
  return false;
}

router.post(
  '/',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 1, max: 256 })
      .withMessage('query must be 1-256 chars'),
    body('type').optional().isIn(['repositories', 'code', 'issues', 'users', 'topics']),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('language').optional().isString().isLength({ max: 40 }),
    body('sort').optional().isString().isLength({ max: 24 }),
    body('order').optional().isIn(['asc', 'desc']),
    body('minStars').optional().isInt({ min: 0 }),
    body('repo').optional().isString().isLength({ max: 140 }),
    body('topic').optional().isString().isLength({ max: 60 }),
    body('filename').optional().isString().isLength({ max: 120 }),
    body('kind').optional().isIn(['issue', 'pr']),
    body('state').optional().isIn(['open', 'closed']),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
  ],
  async (req, res) => {
    if (failValidation(req, res)) return;
    const { query, ...opts } = req.body;
    try {
      const result = await githubSearch.search(query, opts);
      return res.json({ ...result, query });
    } catch (err) {
      console.error('[github-search] uncaught:', err.message);
      return res.status(500).json({ error: 'github_search_failed', message: err.message });
    }
  },
);

router.post(
  '/all',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 1, max: 256 }),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('language').optional().isString().isLength({ max: 40 }),
    body('types').optional().isArray({ max: 4 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
  ],
  async (req, res) => {
    if (failValidation(req, res)) return;
    const { query, ...opts } = req.body;
    try {
      const result = await githubSearch.searchAll(query, opts);
      return res.json({ ...result, query });
    } catch (err) {
      console.error('[github-search:all] uncaught:', err.message);
      return res.status(500).json({ error: 'github_search_failed', message: err.message });
    }
  },
);

router.get(
  '/readme',
  authenticateToken,
  [
    q('owner').isString().trim().isLength({ min: 1, max: 100 }),
    q('repo').isString().trim().isLength({ min: 1, max: 120 }),
    q('maxChars').optional().isInt({ min: 500, max: 50_000 }),
  ],
  async (req, res) => {
    if (failValidation(req, res)) return;
    const { owner, repo, maxChars } = req.query;
    try {
      const result = await githubSearch.getReadme(owner, repo, { maxChars: maxChars ? Number(maxChars) : undefined });
      return res.json(result);
    } catch (err) {
      const status = err.status === 404 ? 404 : 500;
      return res.status(status).json({ error: 'github_readme_failed', message: err.message });
    }
  },
);

module.exports = router;
