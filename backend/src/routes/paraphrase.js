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

const { randomUUID } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const chargeCredits = require('../middleware/charge-credits');
const {
  cacheIdempotentResponse,
  failIdempotentOperation,
  refundLastCharge,
  startIdempotencyLeaseHeartbeat,
} = chargeCredits;
const prisma = require('../config/database');
const freeIaMetrics = require('../services/free-ia-metrics');
const {
  completeFallbackReservation,
  failFallbackReservation,
} = require('../services/free-ia-fallback-quota');
const { runParaphrasePipeline } = require('../services/paraphrase-engine');
const {
  createParaphraseRewriteFn,
  resolveParaphraseProvider,
} = require('../services/paraphrase-provider');

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
const PARAPHRASE_CHARGE_OPTIONS = Object.freeze({
  feature: 'paraphrase',
  cost: paraphraseCost,
  allowFreeIaFallback: true,
});
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const MIN_PROVIDER_TIMEOUT_MS = 10;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const MAX_CUSTOM_INSTRUCTION_LENGTH = 300;
const UNSAFE_CUSTOM_INSTRUCTION_PATTERNS = Object.freeze([
  /(?:ignore|disregard|forget|override|bypass|ignora|olvida|anula|omite)[\s\S]{0,50}(?:instructions?|prompt|rules?|instrucciones|reglas)/i,
  /\b(?:system|assistant|developer|tool|sistema|asistente|desarrollador|herramienta)\s*:/i,
  /\b(?:act|behave|pretend|actua|actúa|comportate|compórtate)\s+(?:as|como)\b/i,
  /(?:reveal|show|print|expose|revela|muestra|imprime)[\s\S]{0,50}(?:system prompt|instructions?|secrets?|prompt del sistema|instrucciones|secretos?)/i,
  /<\|(?:system|assistant|developer|tool)[^>]*\|>/i,
]);

const CustomInstructionSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_CUSTOM_INSTRUCTION_LENGTH)
  .superRefine((value, ctx) => {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customInstruction contains disallowed control characters',
      });
      return;
    }
    if (UNSAFE_CUSTOM_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customInstruction must contain rewrite preferences only',
      });
    }
  });

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
  customInstruction: CustomInstructionSchema.optional(),
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
    // Optional opt-out: callers can pin specific patterns the
    // humanizer must NOT replace ("don't touch 'In conclusion' —
    // I'm writing an academic abstract"). Silently ignore non-array.
    const excludeTells = Array.isArray(req.body?.excludeTells)
      ? req.body.excludeTells.filter((t) => typeof t === 'string')
      : [];
    // Use chunked variant for large inputs so we don't blow the stack
    // on a single regex sweep.
    const result = text.length > 8000
      ? humanizeChunked({ text, language, intensity, excludeTells })
      : humanizeText({ text, language, intensity, excludeTells });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'humanize_failed', message: err && err.message });
  }
});

function resolveProviderTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.PARAPHRASE_PROVIDER_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(MIN_PROVIDER_TIMEOUT_MS, parsed));
}

function fallbackBusinessRequestKey(req) {
  if (req?._freeIaBusinessRequestKey) return req._freeIaBusinessRequestKey;
  const explicit = req?._chargedCredits?.idempotencyKeyHash
    || req?._chargedCredits?.txn?.idempotencyKey
    || req?._chargedCredits?.txn?.id
    || req?.id
    || randomUUID();
  const key = `${req?.user?.id || 'unknown'}:${explicit}`;
  if (req) req._freeIaBusinessRequestKey = key;
  return key;
}

function fallbackReservationFromCharge(charge) {
  if (charge?.reservation?.transaction) return charge.reservation;
  if (!charge?.txn) return null;
  return {
    transaction: charge.txn,
    transactionId: charge.txn.id,
    userId: charge.txn.userId,
    feature: charge.feature || charge.txn.metadata?.feature,
    requestHash: charge.requestHash || charge.txn.metadata?.requestHash,
    requestedAmount: charge.txn.metadata?.requestedAmount,
    idempotencyKeyHash: charge.txn.idempotencyKey,
  };
}

function recordFallbackMetric(metrics, method, payload) {
  try {
    if (typeof metrics?.[method] === 'function') metrics[method](payload);
  } catch {
    // Business telemetry must not alter request outcomes.
  }
}

function setFallbackHeaders(req, res) {
  if (typeof res?.setHeader !== 'function' || res.headersSent) return;
  res.setHeader('x-sira-fallback', 'free-ia');
  res.setHeader('x-sira-fallback-feature', req?._chargedCredits?.feature || 'paraphrase');
  res.setHeader('x-sira-fallback-cost', String(req?._chargedCredits?.amount || 0));
}

async function refundTransactionalCharge(req, reason, refund = refundLastCharge) {
  const charge = req?._chargedCredits;
  if (!charge?.txn || charge.replay || charge.fallback) return null;
  const result = await refund(req, reason, { strict: true });
  if (!result || result.ok !== true) {
    const error = new Error('transactional credit refund failed');
    error.code = 'REFUND_FAILED';
    throw error;
  }
  return result;
}

function refundFailureResponse(req, res) {
  const transactionId = req?._chargedCredits?.txn?.id || null;
  return res.status(503).json({
    error: 'credit refund failed',
    code: 'REFUND_FAILED',
    retryable: true,
    audit: {
      chargeTransactionId: transactionId,
      refundKey: transactionId ? `refund:${transactionId}` : null,
    },
  });
}

function createRequestAbortContext(req, res, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new Error('paraphrase provider timed out');
  timeoutError.code = 'PARAPHRASE_TIMEOUT';
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  const abortForDisconnect = () => {
    if (controller.signal.aborted) return;
    const error = new Error('client disconnected');
    error.code = 'REQUEST_ABORTED';
    controller.abort(error);
  };
  const onRequestAborted = () => {
    abortForDisconnect();
  };
  const onResponseClose = () => {
    if (!res?.writableEnded) abortForDisconnect();
  };
  req?.once?.('aborted', onRequestAborted);
  res?.once?.('close', onResponseClose);
  if (req?.aborted) onRequestAborted();
  return {
    controller,
    cleanup() {
      clearTimeout(timer);
      req?.off?.('aborted', onRequestAborted);
      res?.off?.('close', onResponseClose);
    },
  };
}

function buildParaphraseResponse(req, { raw, mode, language }) {
  const wantHumanize = mode === 'humanize'
    || String(req.query?.humanize || '').trim() === '1';
  let stealth = null;
  let finalText = raw;
  if (wantHumanize && typeof raw === 'string' && raw.trim()) {
    try {
      // eslint-disable-next-line global-require
      const { humanizeText, humanizeChunked } = require('../services/paraphrase-humanizer');
      const intensity = String(req.query?.intensity || 'medium').toLowerCase();
      const safeIntensity = ['low', 'medium', 'high'].includes(intensity)
        ? intensity
        : 'medium';
      const runner = raw.length > 8000 ? humanizeChunked : humanizeText;
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
      if (req.log?.warn) req.log.warn({ err: humanizeErr }, 'paraphrase humanizer failed');
    }
  }

  let tellsBefore = null;
  if (String(req.query?.showTells || '').trim() === '1' && typeof raw === 'string' && raw.trim()) {
    try {
      // eslint-disable-next-line global-require
      const { topAITellsFound } = require('../services/paraphrase-humanizer');
      tellsBefore = topAITellsFound(raw, { limit: 10 });
    } catch { /* best-effort */ }
  }

  const txn = req._chargedCredits?.fallback
    ? null
    : req._chargedCredits?.txn;
  return {
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
  };
}

function validateParaphraseRequest(req, res, next) {
  const parse = ParaphraseSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
  }
  req._validatedParaphrase = parse.data;
  return next();
}

function createParaphraseHandler({
  env = process.env,
  runPipeline = runParaphrasePipeline,
  resolveProvider = resolveParaphraseProvider,
  createRewriteFn = createParaphraseRewriteFn,
  refundLastCharge: refund = refundLastCharge,
  cacheIdempotentResponse: cacheResponse = cacheIdempotentResponse,
  failIdempotentOperation: failOperation = failIdempotentOperation,
  completeFallbackReservation: completeFallback = completeFallbackReservation,
  failFallbackReservation: failFallback = failFallbackReservation,
  fallbackMetrics = freeIaMetrics,
  prismaClient = prisma,
  OpenAICtor,
  createInstrumentedCerebrasClient,
  startLeaseHeartbeat = ({
    request,
    abortController,
    prismaClient: heartbeatPrisma,
  }) => startIdempotencyLeaseHeartbeat(request, {
    abortController,
    prismaClient: heartbeatPrisma,
  }),
} = {}) {
  return async function paraphraseHandler(req, res) {
    const parse = req._validatedParaphrase
      ? { success: true, data: req._validatedParaphrase }
      : ParaphraseSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const { text, mode, language, customInstruction } = parse.data;
    const isFallback = Boolean(req._fallbackToFreeIA);
    const metricKey = isFallback ? fallbackBusinessRequestKey(req) : null;
    const fallbackMetricWinner = isFallback
      && req?._chargedCredits?.durableWinner === true;
    const reservation = isFallback
      ? fallbackReservationFromCharge(req?._chargedCredits)
      : null;

    if (isFallback) {
      if (!reservation) {
        return res.status(503).json({
          error: 'Free IA fallback reservation unavailable',
          code: 'FALLBACK_QUOTA_UNAVAILABLE',
          retryable: true,
        });
      }
      setFallbackHeaders(req, res);
      if (fallbackMetricWinner) {
        // The durable zero-amount ledger row already committed in middleware.
        // A process crash in this narrow gap can under-count one in-memory
        // attempt; the ledger remains the reconciliation source of truth.
        recordFallbackMetric(fallbackMetrics, 'recordFallbackAttempt', {
          feature: req._chargedCredits?.feature || 'paraphrase',
          amount: req._chargedCredits?.amount || 0,
          requestKey: metricKey,
        });
      }
    }

    const abortContext = createRequestAbortContext(req, res, resolveProviderTimeoutMs(env));
    let leaseHeartbeat = { async stop() {} };
    let refundAttempted = false;
    const performRefund = async (reason) => {
      refundAttempted = true;
      try {
        return await refundTransactionalCharge(req, reason, refund);
      } catch (error) {
        const wrapped = new Error('transactional credit refund failed');
        wrapped.code = 'REFUND_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
    };
    const markRefundPending = async () => failOperation(req, {
      code: 'REFUND_FAILED',
      statusCode: 503,
      state: 'refund_pending',
    }, prismaClient);

    try {
      leaseHeartbeat = startLeaseHeartbeat({
        request: req,
        abortController: abortContext.controller,
        prismaClient,
        env,
      }) || leaseHeartbeat;
      const selectedProvider = resolveProvider({
        forceFreeIa: isFallback,
        fallback: req._fallbackToFreeIA,
        env,
        OpenAICtor,
        createInstrumentedCerebrasClient,
      });
      if (!selectedProvider) {
        const error = new Error('paraphrase provider unavailable');
        error.code = 'PROVIDER_UNAVAILABLE';
        throw error;
      }
      req._paraphraseProvider = selectedProvider.metadata;
      const rewriteFn = createRewriteFn(selectedProvider, {
        signal: abortContext.controller.signal,
        timeoutMs: resolveProviderTimeoutMs(env),
        maxRetries: 0,
      });
      const output = await runPipeline({
        source: text,
        rewriteFn,
        mode,
        language,
        customInstruction,
        signal: abortContext.controller.signal,
      });

      if (output && typeof output === 'object' && output.ok === false) {
        const rejectionBody = {
          error: 'paraphrase output remained too similar',
          code: 'PARAPHRASE_SIMILARITY_REJECTED',
          similarity: output.similarity,
          maxSimilarity: output.maxSimilarity,
        };
        if (isFallback) {
          const failed = await failFallback({
            prismaClient,
            reservation,
            code: rejectionBody.code,
            statusCode: 422,
          });
          if (!failed?.ok) {
            const error = new Error('fallback failure state persistence failed');
            error.code = failed?.code || 'FALLBACK_CACHE_UNAVAILABLE';
            throw error;
          }
          if (fallbackMetricWinner) {
            recordFallbackMetric(fallbackMetrics, 'recordFallbackError', { requestKey: metricKey });
          }
        } else {
          await performRefund('similarity_gate');
        }
        return res.status(422).json(rejectionBody);
      }
      if (!output || (typeof output === 'object' && !output.text && !output.output)) {
        const error = new Error('paraphrase engine returned empty output');
        error.code = 'EMPTY_OUTPUT';
        throw error;
      }
      const raw = typeof output === 'string'
        ? output
        : output.text || output.output || output;
      const responseBody = buildParaphraseResponse(req, { raw, mode, language });

      if (isFallback) {
        const completed = await completeFallback({
          prismaClient,
          reservation,
          statusCode: 200,
          body: responseBody,
        });
        if (!completed?.ok) {
          const error = new Error('fallback response persistence failed');
          error.code = completed?.code || 'FALLBACK_CACHE_UNAVAILABLE';
          throw error;
        }
        if (fallbackMetricWinner) {
          recordFallbackMetric(fallbackMetrics, 'recordFallbackSuccess', { requestKey: metricKey });
        }
      } else {
        const cached = await cacheResponse(req, {
          statusCode: 200,
          body: responseBody,
        });
        if (cached && cached.ok === false) {
          const error = new Error('idempotent response cache failed');
          error.code = 'IDEMPOTENCY_CACHE_FAILED';
          throw error;
        }
      }
      return res.status(200).json(responseBody);
    } catch (err) {
      const abortCode = abortContext.controller.signal.aborted
        ? abortContext.controller.signal.reason?.code
        : null;
      let outcomeStatus = 500;
      let outcomeCode = err?.code || 'PARAPHRASE_FAILED';
      if (abortCode === 'REQUEST_ABORTED') {
        outcomeStatus = 499;
        outcomeCode = abortCode;
      } else if (abortCode === 'PARAPHRASE_TIMEOUT') {
        outcomeStatus = 504;
        outcomeCode = abortCode;
      } else if (abortCode === 'LEASE_LOST' || err?.code === 'LEASE_LOST') {
        outcomeStatus = 409;
        outcomeCode = 'LEASE_LOST';
      } else if (err?.code === 'PROVIDER_UNAVAILABLE') {
        outcomeStatus = 503;
      } else if (
        err?.code === 'FALLBACK_CACHE_UNAVAILABLE'
        || err?.code === 'IDEMPOTENCY_CACHE_FAILED'
        || err?.code === 'IDEMPOTENCY_RESPONSE_TOO_LARGE'
      ) {
        outcomeStatus = 503;
      } else if (err?.upstream || err?.code === 'EMPTY_OUTPUT') {
        outcomeStatus = 502;
      }

      if (outcomeCode === 'LEASE_LOST') {
        return res.status(409).json({
          error: 'idempotency lease ownership lost',
          code: 'LEASE_LOST',
          retryable: true,
        });
      }
      if (!isFallback && !refundAttempted) {
        try {
          await performRefund(`engine_error:${err?.code || 'unknown'}`);
        } catch (refundError) {
          try {
            await markRefundPending();
          } catch {
            // The retryable response below carries the transaction ID so
            // operators can reconcile if the database itself is unavailable.
          }
          return refundFailureResponse(req, res);
        }
      }
      if (!isFallback && err?.code === 'REFUND_FAILED') {
        try {
          await markRefundPending();
        } catch {
          // Keep the explicit retryable/auditable response even if persistence
          // itself is unavailable; replay reconciliation will retry the refund.
        }
        return refundFailureResponse(req, res);
      }
      if (isFallback) {
        try {
          const failed = await failFallback({
            prismaClient,
            reservation,
            code: outcomeCode,
            statusCode: outcomeStatus,
          });
          if (!failed?.ok) {
            return res.status(503).json({
              error: 'paraphrase failure state persistence failed',
              code: failed?.code || 'FALLBACK_CACHE_UNAVAILABLE',
              retryable: true,
            });
          }
        } catch {
          return res.status(503).json({
            error: 'paraphrase failure state persistence failed',
            code: 'FALLBACK_CACHE_UNAVAILABLE',
            retryable: true,
          });
        }
        if (fallbackMetricWinner) {
          recordFallbackMetric(fallbackMetrics, 'recordFallbackError', { requestKey: metricKey });
        }
      }

      if (abortCode === 'REQUEST_ABORTED') {
        if (res?.destroyed) return undefined;
        return res.status(499).json({
          error: 'request aborted',
          code: 'REQUEST_ABORTED',
          retryable: true,
        });
      }
      if (abortCode === 'PARAPHRASE_TIMEOUT') {
        return res.status(504).json({
          error: 'paraphrase provider timed out',
          code: 'PARAPHRASE_TIMEOUT',
          retryable: true,
        });
      }
      if (err?.code === 'PROVIDER_UNAVAILABLE') {
        return res.status(503).json({
          error: 'paraphrase provider unavailable',
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      }
      if (
        err?.code === 'FALLBACK_CACHE_UNAVAILABLE'
        || err?.code === 'IDEMPOTENCY_CACHE_FAILED'
        || err?.code === 'IDEMPOTENCY_RESPONSE_TOO_LARGE'
      ) {
        return res.status(503).json({
          error: 'paraphrase response persistence failed',
          code: err.code,
          retryable: true,
        });
      }
      const status = err?.upstream || err?.code === 'EMPTY_OUTPUT' ? 502 : 500;
      return res.status(status).json({
        error: 'paraphrase failed',
        message: env.NODE_ENV === 'production' ? undefined : err?.message,
      });
    } finally {
      await leaseHeartbeat.stop?.();
      abortContext.cleanup();
    }
  };
}

router.post(
  '/',
  (req, _res, next) => { normaliseModeOnBody(req.body); next(); },
  authenticateToken,
  validateParaphraseRequest,
  chargeCredits(PARAPHRASE_CHARGE_OPTIONS),
  createParaphraseHandler(),
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
module.exports.createParaphraseHandler = createParaphraseHandler;
module.exports.createParaphraseRewriteFn = createParaphraseRewriteFn;
module.exports.refundTransactionalCharge = refundTransactionalCharge;
module.exports.resolveParaphraseProvider = resolveParaphraseProvider;
