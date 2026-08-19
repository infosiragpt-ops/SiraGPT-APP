'use strict';

/**
 * scientific-search route — unified search over arXiv / Semantic Scholar /
 * OpenAlex / CrossRef / PubMed / Europe PMC / CORE.
 *
 *   POST /api/scientific-search
 *     body: { query, providers?, limit?, timeoutMs?, diversify?, unpaywall? }
 *     →    { papers, errors, providers, count }
 *
 *   GET  /api/scientific-search/providers
 *     →    { providers, keysConfigured: { core: bool, ncbi: bool, semanticscholar: bool } }
 *
 * Auth: requires authenticateToken so anonymous traffic doesn't burn through
 * the (rate-limited) upstream provider quotas.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { responseCache } = require('../middleware/response-cache');
const scientificSearch = require('../services/scientific-search');
const { buildLiteratureReview } = require('../services/research/literature-review-engine');
const { analyzeQuery } = require('../services/research/research-query-intelligence');
const {
  DISCIPLINE_IDS,
  orderProvidersForDiscipline,
} = require('../services/research/research-discipline-router');
const {
  assessFullTextRiskOfBias,
  extractEffectEstimates,
  gradeFullTextEvidence,
} = require('../services/research/systematic-review-protocol');
const {
  critiqueEvidence,
  verifyScientificCitations,
} = require('../services/research/research-quality-agents');
const { runSystematicReviewAgent } = require('../services/research/systematic-review-agent');

const router = express.Router();

// Provider list rarely changes — cache for 5 min to avoid recomputing env probes.
const { DATABASE_CATALOG, catalogSummary } = require('../services/scientific-databases-catalog');

router.get('/providers', responseCache({ ttlMs: 5 * 60_000, namespace: 'sci-providers' }), (req, res) => {
  res.json({
    // The 16 directly-queried provider APIs (real, separate live calls).
    providers: scientificSearch.PROVIDERS,
    // The full honest catalog of scientific databases SiraGPT reaches (60+),
    // each labelled `access: direct|federated`. Federated ones are reached
    // through the aggregators we already query (OpenAlex/Crossref/CORE/DataCite).
    databases: DATABASE_CATALOG,
    coverage: catalogSummary(),
    keysConfigured: {
      core: !!process.env.CORE_API_KEY,
      ncbi: !!process.env.NCBI_API_KEY,
      semanticscholar: !!process.env.SEMANTIC_SCHOLAR_API_KEY,
      scopus: !!process.env.SCOPUS_API_KEY,
      wos: !!(process.env.WOS_API_KEY || process.env.CLARIVATE_API_KEY),
      mailto: !!process.env.SIRAGPT_RESEARCH_EMAIL,
    },
  });
});

router.post(
  '/',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 2, max: 500 })
      .withMessage('query must be 2-500 chars'),
    body('providers').optional().isArray({ max: 10 })
      .withMessage('providers must be an array of provider names'),
    body('discipline').optional().isIn(DISCIPLINE_IDS),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
    body('diversify').optional().isBoolean()
      .withMessage('diversify must be a boolean'),
    body('unpaywall').optional().isBoolean()
      .withMessage('unpaywall must be a boolean'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const { query, providers, discipline, limit, timeoutMs, diversify, unpaywall } = req.body;
    try {
      const plan = analyzeQuery(query, { discipline });
      const routedProviders = Array.isArray(providers) && providers.length
        ? providers
        : orderProvidersForDiscipline(scientificSearch.PROVIDERS, plan.discipline);
      const result = await scientificSearch.search(query, { providers: routedProviders, limit, timeoutMs, diversify, unpaywall });
      return res.json({
        ...result,
        count: result.papers.length,
        query,
        discipline: plan.discipline,
      });
    } catch (err) {
      console.error('[scientific-search] uncaught:', err);
      return res.status(500).json({ error: 'scientific_search_failed', message: err.message });
    }
  }
);

/**
 * POST /api/scientific-search/review — turn a natural-language research request
 * into a full literature review: multilingual query expansion, multi-provider
 * search, evidence extraction, thematic synthesis, consensus/gaps, APA/IEEE/MLA
 * bibliography, a comparison table and an assembled Markdown report.
 *
 *   body: { query, providers?, limit?, maxPapers?, timeoutMs? }
 *   →    { query, papers, synthesis, bibliography, comparisonTable, report, meta }
 */
router.post(
  '/review',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 2, max: 500 })
      .withMessage('query must be 2-500 chars'),
    body('providers').optional().isArray({ max: 10 }),
    body('discipline').optional().isIn(DISCIPLINE_IDS),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('maxPapers').optional().isInt({ min: 1, max: 50 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
    body('resolveDois').optional().isBoolean(),
    body('protocol').optional().isObject(),
    body('protocol.framework').optional().isIn(['pico', 'spider']),
    body('protocol.fields').optional().isObject(),
    body('protocol.inclusionCriteria').optional().isArray({ max: 20 }),
    body('protocol.exclusionCriteria').optional().isArray({ max: 20 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const { query, providers, discipline, limit, maxPapers, timeoutMs, resolveDois, protocol } = req.body;
    try {
      const review = await buildLiteratureReview(query, { providers, discipline, limit, maxPapers, timeoutMs, resolveDois, protocol });
      return res.json(review);
    } catch (err) {
      console.error('[scientific-search/review] uncaught:', err);
      return res.status(500).json({ error: 'literature_review_failed', message: err.message });
    }
  }
);

/**
 * POST /api/scientific-search/review/export — run the same auditable review
 * pipeline and return its protocol as a downloadable Markdown artifact.
 */
router.post(
  '/review/export',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 2, max: 500 })
      .withMessage('query must be 2-500 chars'),
    body('providers').optional().isArray({ max: 10 }),
    body('discipline').optional().isIn(DISCIPLINE_IDS),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('maxPapers').optional().isInt({ min: 1, max: 50 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
    body('resolveDois').optional().isBoolean(),
    body('protocol').optional().isObject(),
    body('protocol.framework').optional().isIn(['pico', 'spider']),
    body('protocol.fields').optional().isObject(),
    body('protocol.inclusionCriteria').optional().isArray({ max: 20 }),
    body('protocol.exclusionCriteria').optional().isArray({ max: 20 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const { query, providers, discipline, limit, maxPapers, timeoutMs, resolveDois, protocol } = req.body;
    try {
      const review = await buildLiteratureReview(query, { providers, discipline, limit, maxPapers, timeoutMs, resolveDois, protocol });
      if (!review.protocolExport) {
        return res.status(422).json({
          error: 'systematic_protocol_required',
          message: 'Use PICO, SPIDER, PRISMA or request a systematic review before exporting a protocol.',
        });
      }
      res.setHeader('Content-Type', review.protocolExport.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${review.protocolExport.filename}"`);
      return res.send(review.protocolExport.content);
    } catch (err) {
      console.error('[scientific-search/review/export] uncaught:', err);
      return res.status(500).json({ error: 'protocol_export_failed', message: err.message });
    }
  }
);

/**
 * POST /api/scientific-search/review/assess — full-text risk-of-bias and
 * GRADE assessment. Reviewer overrides remain explicit and every automated
 * judgment carries the supporting sentence from the supplied full text.
 */
router.post(
  '/review/assess',
  authenticateToken,
  [
    body('studies').isArray({ min: 1, max: 50 }),
    body('studies.*.paper').isObject(),
    body('studies.*.fullText').isString().isLength({ min: 100, max: 200_000 }),
    body('studies.*.judgments').optional().isObject(),
    body('grade').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    const studies = req.body.studies.map((study, index) => {
      const riskOfBias = assessFullTextRiskOfBias(study.paper, { fullText: study.fullText, judgments: study.judgments });
      const effects = extractEffectEstimates(study.fullText);
      return { id: study.paper.id || `study-${index + 1}`, ...study.paper, fullText: study.fullText, riskOfBias, effects };
    });
    return res.json({
      studies: studies.map(({ fullText, ...study }) => study),
      certainty: gradeFullTextEvidence(studies, req.body.grade || {}),
      meta: { scope: 'full_text', studiesAssessed: studies.length, reviewerOverridesSupported: true },
    });
  },
);

router.post(
  '/agents/evidence-critic',
  authenticateToken,
  [
    body('papers').isArray({ min: 1, max: 100 }),
    body('claims').optional().isArray({ max: 100 }),
    body('synthesis').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return res.json(critiqueEvidence({
      papers: req.body.papers,
      claims: req.body.claims,
      synthesis: req.body.synthesis,
    }));
  },
);

router.post(
  '/agents/citation-verifier',
  authenticateToken,
  [
    body('text').isString().isLength({ min: 1, max: 500_000 }),
    body('references').isArray({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return res.json(verifyScientificCitations(req.body.text, req.body.references));
  },
);

router.post(
  '/agents/systematic-review',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 2, max: 500 }),
    body('providers').optional().isArray({ max: 16 }),
    body('discipline').optional().isIn(DISCIPLINE_IDS),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('maxPapers').optional().isInt({ min: 1, max: 50 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
    body('resolveDois').optional().isBoolean(),
    body('protocol').optional().isObject(),
    body('protocol.framework').optional().isIn(['pico', 'spider']),
    body('protocol.fields').optional().isObject(),
    body('protocol.inclusionCriteria').optional().isArray({ max: 20 }),
    body('protocol.exclusionCriteria').optional().isArray({ max: 20 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    const { query, ...options } = req.body;
    try {
      return res.json(await runSystematicReviewAgent(query, options));
    } catch (err) {
      console.error('[scientific-search/agents/systematic-review] uncaught:', err);
      return res.status(500).json({ error: 'systematic_review_agent_failed', message: err.message });
    }
  },
);

module.exports = router;
