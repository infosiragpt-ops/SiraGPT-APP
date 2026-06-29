'use strict';

/**
 * builder route — siraGPT Builder · E1 intake.
 *
 * Exposes the structured-interview engine. The intake is stateless on the
 * server: the client owns the `session` object and round-trips it on each call.
 *
 *   GET  /api/builder/intake/questions
 *     →  { dimensions, questions }  — the full QuestionCard catalogue
 *
 *   POST /api/builder/intake/step
 *     body: { session?, answer?: { dimension, value }, integrations?, constraints? }
 *     →    { session, coverage, nextQuestion, complete }
 *
 *   POST /api/builder/intake/brief
 *     body: { session, openQuestions? }
 *     →    { brief }              when intake is complete
 *     →    400 { error, missing } when it is not
 *
 *   POST /api/builder/blueprint
 *     body: { brief }            a ProjectBrief
 *     →    { blueprint }         deterministic build plan (E2)
 *
 *   POST /api/builder/scaffold
 *     body: { brief }            a ProjectBrief
 *     →    { blueprint, files }  starter artifacts (E3)
 *
 * Auth: requires authenticateToken. No CSRF — the engine is pure compute with
 * no side effects (mirrors /api/scientific-search).
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { COVERAGE_DIMENSIONS, ProjectBriefSchema } = require('../services/builder/contracts');
const { QUESTION_BANK, questionForDimension } = require('../services/builder/questions');
const intake = require('../services/builder/intake-engine');
const { planFromBrief } = require('../services/builder/blueprint');
const { scaffoldFromBrief } = require('../services/builder/scaffold');
const { generateNextQuestion } = require('../services/builder/question-generator');
const { briefFromPrompt } = require('../services/builder/brief-from-prompt');
const { generateCodeIntakeQuestion } = require('../services/code-intake-question');

const router = express.Router();

/**
 * Build a clean session from an untrusted request body. Only known dimensions
 * are copied, which both validates input and avoids prototype pollution from
 * an attacker-supplied `session`.
 */
function hydrateSession(raw) {
  const session = intake.createSession();
  const answers = raw && typeof raw === 'object' && raw.answers && typeof raw.answers === 'object'
    ? raw.answers
    : {};
  for (const dimension of COVERAGE_DIMENSIONS) {
    if (Object.prototype.hasOwnProperty.call(answers, dimension)) {
      intake.recordAnswer(session, dimension, answers[dimension]);
    }
  }
  if (raw && raw.integrations != null) intake.recordIntegrations(session, raw.integrations);
  if (raw && typeof raw.constraints === 'string') intake.recordConstraints(session, raw.constraints);
  return session;
}

/**
 * Build the response snapshot. With `dynamic`, the next question is generated
 * contextually by the LLM (with automatic fallback to the static bank); the
 * `dynamic` flag is reported back so the client knows which path was taken.
 */
async function snapshot(session, { dynamic = false } = {}) {
  const cov = intake.coverage(session);
  let nextQuestion = intake.nextQuestion(session);
  if (dynamic && nextQuestion && cov.missing.length > 0) {
    try {
      nextQuestion = await generateNextQuestion(session, cov.missing[0]);
    } catch {
      // keep the static question on any failure
    }
  }
  return { session, coverage: cov, nextQuestion, complete: cov.complete, dynamic };
}

router.get('/intake/questions', authenticateToken, (req, res) => {
  res.json({
    dimensions: COVERAGE_DIMENSIONS,
    questions: COVERAGE_DIMENSIONS.map((d) => questionForDimension(d)),
  });
});

// Context-aware intake question for the /code agent. Given the slot being asked
// and the conversation so far, the LLM phrases a personalised question; falls
// back to the caller's static question on any failure (key/LLM/output).
router.post('/code-question', authenticateToken, async (req, res) => {
  const { slot, history, fallback } = req.body || {};
  try {
    const question = await generateCodeIntakeQuestion({
      slot: typeof slot === 'string' ? slot : '',
      history: Array.isArray(history) ? history : [],
      fallback: typeof fallback === 'string' ? fallback : '',
      env: process.env,
    });
    res.json({ question });
  } catch {
    res.json({ question: typeof fallback === 'string' ? fallback : '' });
  }
});

router.post(
  '/intake/step',
  authenticateToken,
  [
    body('answer').optional().isObject().withMessage('answer must be an object'),
    body('answer.dimension').optional().isIn(COVERAGE_DIMENSIONS)
      .withMessage(`dimension must be one of ${COVERAGE_DIMENSIONS.join(', ')}`),
    body('integrations').optional(),
    body('constraints').optional().isString(),
    body('dynamic').optional().isBoolean().withMessage('dynamic must be a boolean'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const session = hydrateSession(req.body.session);
      const { answer, integrations, constraints } = req.body;
      if (answer && answer.dimension) {
        intake.recordAnswer(session, answer.dimension, answer.value);
      }
      if (integrations != null) intake.recordIntegrations(session, integrations);
      if (typeof constraints === 'string') intake.recordConstraints(session, constraints);
      return res.json(await snapshot(session, { dynamic: req.body.dynamic === true }));
    } catch (err) {
      return res.status(400).json({ error: 'intake_step_failed', message: err.message });
    }
  }
);

router.post(
  '/intake/brief',
  authenticateToken,
  [
    body('openQuestions').optional().isArray().withMessage('openQuestions must be an array'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const session = hydrateSession(req.body.session);
    const cov = intake.coverage(session);
    if (!cov.complete) {
      return res.status(400).json({
        error: 'intake_incomplete',
        missing: cov.missing,
        message: `Intake incomplete; still missing: ${cov.missing.join(', ')}`,
      });
    }
    try {
      const brief = intake.buildBrief(session, { openQuestions: req.body.openQuestions || [] });
      return res.json({ brief });
    } catch (err) {
      return res.status(400).json({ error: 'brief_build_failed', message: err.message });
    }
  }
);

/**
 * POST /api/builder/blueprint
 *   body: { brief }  — a ProjectBrief (as emitted by /intake/brief)
 *   →    { blueprint }              the deterministic build plan
 *   →    400 { error, details }     when the brief is invalid
 */
router.post(
  '/blueprint',
  authenticateToken,
  [body('brief').isObject().withMessage('brief is required')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const parsed = ProjectBriefSchema.safeParse(req.body.brief);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_brief', details: parsed.error.issues });
    }
    try {
      const blueprint = planFromBrief(parsed.data);
      return res.json({ blueprint });
    } catch (err) {
      return res.status(400).json({ error: 'blueprint_failed', message: err.message });
    }
  }
);

/**
 * POST /api/builder/scaffold
 *   body: { brief }  — a ProjectBrief
 *   →    { blueprint, files }       starter artifacts (schema.prisma, README, .env)
 *   →    400 { error, details }     when the brief is invalid
 */
router.post(
  '/scaffold',
  authenticateToken,
  [body('brief').isObject().withMessage('brief is required')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const parsed = ProjectBriefSchema.safeParse(req.body.brief);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_brief', details: parsed.error.issues });
    }
    try {
      const result = scaffoldFromBrief(parsed.data);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: 'scaffold_failed', message: err.message });
    }
  }
);

/**
 * POST /api/builder/generate
 *   body: { prompt }  — a single free-text app description
 *   →    { brief, blueprint, files }  one-shot deterministic generation
 *   →    400 { error, message }       when the prompt is empty/unusable
 *
 * This is the LLM-free "Construir app" path: it derives a ProjectBrief from the
 * prompt heuristically and scaffolds a runnable project (incl. a live index.html)
 * so the /code workspace can build + preview even when the chat model is down.
 */
router.post(
  '/generate',
  authenticateToken,
  [body('prompt').isString().trim().notEmpty().withMessage('prompt is required')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const brief = briefFromPrompt(req.body.prompt);
      // Full-stack mode: emit the real Next.js/Prisma/PostgreSQL project
      // alongside the self-contained index.html preview. The /code preview
      // still opens localhost / index.html immediately, while the workspace
      // also receives package.json, app/api routes, prisma/schema.prisma and
      // docker-compose.yml when the brief has data.
      const { blueprint, files } = scaffoldFromBrief(brief);
      return res.json({ brief, blueprint, files });
    } catch (err) {
      return res.status(400).json({ error: 'generate_failed', message: err.message });
    }
  }
);

module.exports = router;
// internal helpers exported for unit tests
module.exports.hydrateSession = hydrateSession;
