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
 * Auth: requires authenticateToken. No CSRF — the engine is pure compute with
 * no side effects (mirrors /api/scientific-search).
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { COVERAGE_DIMENSIONS } = require('../services/builder/contracts');
const { QUESTION_BANK, questionForDimension } = require('../services/builder/questions');
const intake = require('../services/builder/intake-engine');

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

function snapshot(session) {
  const cov = intake.coverage(session);
  return {
    session,
    coverage: cov,
    nextQuestion: intake.nextQuestion(session),
    complete: cov.complete,
  };
}

router.get('/intake/questions', authenticateToken, (req, res) => {
  res.json({
    dimensions: COVERAGE_DIMENSIONS,
    questions: COVERAGE_DIMENSIONS.map((d) => questionForDimension(d)),
  });
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
  ],
  (req, res) => {
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
      return res.json(snapshot(session));
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

module.exports = router;
// internal helpers exported for unit tests
module.exports.hydrateSession = hydrateSession;
