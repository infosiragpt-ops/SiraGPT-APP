'use strict';

/**
 * /api/paraphrase — F2 PR8 — Canonical paraphrase endpoint that wraps
 * the existing `runParaphrasePipeline` (currently exposed at
 * /api/ai/paraphrase) with proper credit charging + idempotency. The
 * old path is preserved untouched for back-compat; F3 PR12 migrates
 * the frontend to this canonical alias.
 *
 *   GET    /api/paraphrase/modes      list available modes (public)
 *   POST   /api/paraphrase            paraphrase text (auth + credits)
 *
 * Cost model: `Math.max(1, ceil(text.length / 1000))` credits per call.
 * Tunable via env `CREDITS_PARAPHRASE_PER_1K_CHARS` (default 1). On
 * downstream LLM failure (502, timeout) the charge is auto-refunded so
 * the user is never drained for an unsuccessful call.
 */

const express = require('express');
const { z } = require('zod');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const chargeCredits = require('../middleware/charge-credits');
const { refundLastCharge } = chargeCredits;

const router = express.Router();

const SUPPORTED_MODES = [
  'standard',
  'humanize',
  'formal',
  'academic',
  'simple',
  'creative',
  'expand',
  'shorten',
  'custom',
];

const SUPPORTED_LANGUAGES = ['es', 'en', 'pt', 'fr', 'de', 'it'];

const ParaphraseSchema = z.object({
  text: z.string().min(1).max(20_000),
  mode: z.enum(SUPPORTED_MODES).default('standard'),
  language: z.enum(SUPPORTED_LANGUAGES).default('es'),
  customInstruction: z.string().max(1_000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

function paraphraseCost(req) {
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  const ratio = Number(process.env.CREDITS_PARAPHRASE_PER_1K_CHARS || 1);
  return Math.max(1, Math.ceil(text.length / 1000) * (Number.isFinite(ratio) ? ratio : 1));
}

router.get('/modes', optionalAuth, (req, res) => {
  res.json({
    modes: SUPPORTED_MODES.map((mode) => ({ mode })),
    languages: SUPPORTED_LANGUAGES,
    costPer1kChars: Number(process.env.CREDITS_PARAPHRASE_PER_1K_CHARS || 1),
  });
});

router.post(
  '/',
  authenticateToken,
  chargeCredits({ feature: 'paraphrase', cost: paraphraseCost }),
  async (req, res) => {
    const parse = ParaphraseSchema.safeParse(req.body);
    if (!parse.success) {
      await refundLastCharge(req, 'invalid_payload');
      return res
        .status(400)
        .json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const { text, mode, language, customInstruction } = parse.data;

    // Lazy-require so unit tests can run without the heavy paraphrase
    // engine (which depends on DeepSeek/OpenAI clients).
    let runParaphrasePipeline;
    try {
      ({ runParaphrasePipeline } = require('../services/paraphrase-engine'));
    } catch (err) {
      await refundLastCharge(req, 'engine_unavailable');
      return res.status(503).json({ error: 'paraphrase engine unavailable' });
    }
    try {
      const output = await runParaphrasePipeline({
        text,
        mode,
        language,
        customInstruction,
        userId: req.user.id,
      });
      if (!output || (typeof output === 'object' && !output.text && !output.output)) {
        await refundLastCharge(req, 'empty_output');
        return res
          .status(502)
          .json({ error: 'paraphrase engine returned empty output' });
      }
      const txn = req._chargedCredits?.txn;
      res.json({
        output:
          typeof output === 'string'
            ? output
            : output.text || output.output || output,
        mode,
        language,
        charge: txn
          ? {
              amount: String(req._chargedCredits.amount),
              transactionId: txn.id,
              replay: !!req._chargedCredits.replay,
            }
          : null,
      });
    } catch (err) {
      await refundLastCharge(req, `engine_error:${err && err.code ? err.code : 'unknown'}`);
      // Surface 502 for upstream LLM failures; 500 only for real bugs.
      const status = err && err.upstream ? 502 : 500;
      res.status(status).json({
        error: 'paraphrase failed',
        message:
          process.env.NODE_ENV === 'production'
            ? undefined
            : err && err.message,
      });
    }
  },
);

module.exports = router;
module.exports.ParaphraseSchema = ParaphraseSchema;
module.exports.SUPPORTED_MODES = SUPPORTED_MODES;
module.exports.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
module.exports.paraphraseCost = paraphraseCost;
