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
 *
 * Env tunables:
 *   CREDITS_PARAPHRASE_PER_1K_CHARS — credit cost ratio (default 1)
 *   PARAPHRASE_MAX_TEXT_LENGTH      — per-request text cap (default
 *                                     20_000 chars, hard upper 100_000).
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

// Tolerant pre-parse: callers occasionally send "human", "scholarly",
// "shorter", "paraphrase", etc. Apply the engine's alias map BEFORE
// Zod validation so a known alias doesn't 400 with "invalid enum".
function normaliseModeOnBody(body) {
  if (!body || typeof body !== 'object' || typeof body.mode !== 'string') return body;
  try {
    // eslint-disable-next-line global-require
    const { normaliseMode } = require('../services/paraphrase-engine');
    body.mode = normaliseMode(body.mode);
  } catch { /* engine not loaded — leave untouched */ }
  return body;
}

// Per-request text-length cap. Hard upper bound stays at 100K chars to
// protect the worker pool from accidental novel-sized payloads; the
// effective limit can be tuned down per deployment via env. Defaults to
// 20K which is the cap the schema shipped with originally.
function resolveMaxTextLength(env = process.env) {
  const HARD_UPPER = 100_000;
  const DEFAULT = 20_000;
  const raw = env.PARAPHRASE_MAX_TEXT_LENGTH;
  if (raw == null || raw === '') return DEFAULT;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT;
  return Math.min(HARD_UPPER, n);
}

const MAX_TEXT_LENGTH = resolveMaxTextLength();

const ParaphraseSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
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

// POST /api/paraphrase/score — free pre-paraphrase AI score check.
// The frontend can call this to show "your text scores 0.7 — looks
// AI-generated" before the user commits credits to a paraphrase run.
// Public (no auth) because it doesn't consume credits and doesn't
// touch any LLM — it's a deterministic local scorer.
router.post('/score', express.json({ limit: '512kb' }), (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { estimateAIScoreDetailed, topAITellsFound } = require('../services/paraphrase-humanizer');
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text) {
      return res.status(400).json({ error: 'missing_text', message: 'body.text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({ error: 'text_too_long', maxLength: MAX_TEXT_LENGTH });
    }
    const detailed = estimateAIScoreDetailed(text);
    const topTells = topAITellsFound(text, { limit: 5 });
    return res.json({
      score: detailed.score,
      components: detailed.components,
      weights: detailed.weights,
      topTells,
      verdict: detailed.score >= 0.5 ? 'likely_ai'
        : detailed.score >= 0.25 ? 'mixed'
        : 'likely_human',
    });
  } catch (err) {
    return res.status(500).json({ error: 'score_failed', message: err && err.message });
  }
});

// POST /api/paraphrase/score/batch — score multiple texts in one call.
// Same scorer as /score but accepts an array of texts and returns an
// array of scored results. Useful for document-level processing where
// each paragraph needs to be evaluated independently.
router.post('/score/batch', express.json({ limit: '1mb' }), (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { estimateAIScoreDetailed, topAITellsFound } = require('../services/paraphrase-humanizer');
    const texts = Array.isArray(req.body?.texts) ? req.body.texts : null;
    if (!texts) {
      return res.status(400).json({ error: 'missing_texts', message: 'body.texts must be an array of strings' });
    }
    if (texts.length > 50) {
      return res.status(413).json({ error: 'too_many_texts', limit: 50 });
    }
    const out = texts.map((text, i) => {
      const s = typeof text === 'string' ? text : '';
      if (!s) return { index: i, error: 'empty_text', score: 0 };
      if (s.length > MAX_TEXT_LENGTH) return { index: i, error: 'text_too_long', score: 0 };
      const detailed = estimateAIScoreDetailed(s);
      return {
        index: i,
        score: detailed.score,
        components: detailed.components,
        topTells: topAITellsFound(s, { limit: 3 }),
        verdict: detailed.score >= 0.5 ? 'likely_ai'
          : detailed.score >= 0.25 ? 'mixed'
          : 'likely_human',
      };
    });
    // Quick aggregate so the UI can render "of 12 paragraphs, 3 likely AI".
    const aggregate = {
      total: out.length,
      likely_ai: out.filter((r) => r.verdict === 'likely_ai').length,
      mixed: out.filter((r) => r.verdict === 'mixed').length,
      likely_human: out.filter((r) => r.verdict === 'likely_human').length,
      avgScore: out.length > 0
        ? Math.round((out.reduce((a, r) => a + (r.score || 0), 0) / out.length) * 1000) / 1000
        : 0,
    };
    return res.json({ results: out, aggregate });
  } catch (err) {
    return res.status(500).json({ error: 'score_batch_failed', message: err && err.message });
  }
});

// POST /api/paraphrase/humanize — local-only humanizer pass.
// Same humanizer the paraphrase route uses at the tail of its pipeline,
// but without the LLM rewrite. Cheaper for users who already have a
// reasonable draft and just want the AI-tell patterns cleaned up. Public
// (no auth) for now because it never calls any external API.
router.post('/humanize', express.json({ limit: '512kb' }), (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { humanizeText, humanizeChunked } = require('../services/paraphrase-humanizer');
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text) {
      return res.status(400).json({ error: 'missing_text', message: 'body.text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({ error: 'text_too_long', maxLength: MAX_TEXT_LENGTH });
    }
    const language = typeof req.body?.language === 'string' && SUPPORTED_LANGUAGES.includes(req.body.language)
      ? req.body.language : 'es';
    const intensity = typeof req.body?.intensity === 'string'
      ? req.body.intensity : 'medium';
    // Use chunked variant for large inputs so we don't blow the stack
    // on a single regex sweep.
    const result = text.length > 8000
      ? humanizeChunked({ text, language, intensity })
      : humanizeText({ text, language, intensity });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'humanize_failed', message: err && err.message });
  }
});

router.post(
  '/',
  (req, _res, next) => { normaliseModeOnBody(req.body); next(); },
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
      const raw = typeof output === 'string'
        ? output
        : output.text || output.output || output;

      // Anti-AI-detection humanization: applied automatically for the
      // 'humanize' mode and as an opt-in for other modes via the
      // `?humanize=1` query param. Reports an aiScore (0..1) so the UI
      // can render a "stealth" gauge. Free IA fallback users get this
      // too — the layer is pure JS and runs after the LLM pass.
      const wantHumanize = mode === 'humanize'
        || String(req.query?.humanize || '').trim() === '1';
      let stealth = null;
      let finalText = raw;
      if (wantHumanize && typeof raw === 'string' && raw.trim()) {
        try {
          // eslint-disable-next-line global-require
          const { humanizeText, humanizeChunked } = require('../services/paraphrase-humanizer');
          const intensity = String(req.query?.intensity || 'medium')
            .toLowerCase();
          const safeIntensity = ['low', 'medium', 'high'].includes(intensity)
            ? intensity
            : 'medium';
          // Use the chunked variant for long inputs (>8000 chars) so a
          // single big paste doesn't pay the full regex cost in one
          // pass and the response stays responsive.
          const useChunked = typeof raw === 'string' && raw.length > 8000;
          const runner = useChunked ? humanizeChunked : humanizeText;
          const humanized = runner({
            text: raw,
            language,
            intensity: safeIntensity,
          });
          finalText = humanized.text;
          stealth = {
            aiScoreBefore: humanized.aiScoreBefore,
            aiScoreAfter: humanized.aiScoreAfter,
            deltaScore: humanized.deltaScore,
            transformations: humanized.applied.length,
            intensity: humanized.intensity,
            chunked: !!humanized.chunked,
            chunkCount: humanized.chunkCount || 1,
          };
        } catch (humanizeErr) {
          // Humanizer is best-effort: a failure must not break the
          // paraphrase response (the LLM output is still valid).
          if (req.log?.warn) {
            req.log.warn({ err: humanizeErr }, 'paraphrase humanizer failed');
          }
        }
      }

      // Optional debug field: list the top AI-tells that were present
      // in the LLM output before the humanizer ran. Opt-in via
      // `?showTells=1` so the response stays lean by default.
      let tellsBefore = null;
      if (String(req.query?.showTells || '').trim() === '1' && typeof raw === 'string' && raw.trim()) {
        try {
          // eslint-disable-next-line global-require
          const { topAITellsFound } = require('../services/paraphrase-humanizer');
          tellsBefore = topAITellsFound(raw, { limit: 10 });
        } catch { /* best-effort */ }
      }

      const txn = req._chargedCredits?.txn;
      res.json({
        output: finalText,
        mode,
        language,
        stealth,
        tellsBefore,
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

// Explicit endpoint inventory — kept here so the surface stays
// discoverable without traversing Express's router internals. Same
// FNV-1a fingerprint pattern as /api/free-ia so cache invalidation
// rules are uniform across the API.
const ENDPOINT_INVENTORY = Object.freeze([
  { method: 'GET',  path: '/api/paraphrase/modes',         auth: 'public', returns: 'supported modes + languages + cost ratio' },
  { method: 'POST', path: '/api/paraphrase/score',         auth: 'public', returns: 'AI-score breakdown + verdict' },
  { method: 'POST', path: '/api/paraphrase/score/batch',   auth: 'public', returns: 'per-text scores + aggregate verdict' },
  { method: 'POST', path: '/api/paraphrase/humanize',      auth: 'public', returns: 'humanized text (no LLM)' },
  { method: 'POST', path: '/api/paraphrase',               auth: 'user',   returns: 'paraphrased text + humanizer pass' },
]);

const SURFACE_VERSION = 'v1.1';

function apiSurfaceFingerprint() {
  const sorted = ENDPOINT_INVENTORY
    .map((e) => `${e.method}:${e.path}:${e.auth}`)
    .sort()
    .join('|');
  const seed = `${SURFACE_VERSION}|${sorted}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Augmented /modes — adds endpoint inventory + surface version + fingerprint.
// Useful for the model picker / settings UI to render "paraphrase
// supports: score, batch, humanize, …" without hardcoding the list.
router.get('/surface', (_req, res) => {
  res.json({
    surfaceVersion: SURFACE_VERSION,
    apiFingerprint: apiSurfaceFingerprint(),
    endpoints: ENDPOINT_INVENTORY,
  });
});

module.exports = router;
module.exports.ParaphraseSchema = ParaphraseSchema;
module.exports.SUPPORTED_MODES = SUPPORTED_MODES;
module.exports.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
module.exports.paraphraseCost = paraphraseCost;
module.exports.resolveMaxTextLength = resolveMaxTextLength;
module.exports.MAX_TEXT_LENGTH = MAX_TEXT_LENGTH;
module.exports.ENDPOINT_INVENTORY = ENDPOINT_INVENTORY;
module.exports.SURFACE_VERSION = SURFACE_VERSION;
module.exports.apiSurfaceFingerprint = apiSurfaceFingerprint;
