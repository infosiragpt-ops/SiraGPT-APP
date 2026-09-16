'use strict';

/**
 * RLHF HTTP surface.
 *
 *   POST /api/rlhf/feedback          record an explicit thumb (optional reason/reasonCode)
 *   POST /api/rlhf/pair              record a chosen/rejected pair for one prompt
 *   POST /api/rlhf/rlaif/propose     optional synthetic pairs (flag-gated, rate-limited)
 *   GET  /api/rlhf/stats             caller's preference counts + phase-2 flags
 *                                    + RLCD calibration snapshot (Brier/ECE)
 *                                    (admin also gets process telemetry)
 *   GET  /api/rlhf/export            SFT / DPO / RM JSONL
 *   POST /api/rlhf/score             score a (prompt, response) with the RM
 *   POST /api/rlhf/rerank            rank N candidates with the RM (judge fallback)
 *   POST /api/rlhf/train             fit the RM (admin)
 *   GET  /api/rlhf/model             active RM metrics
 *   POST /api/rlhf/jobs              enqueue SFT/DPO prep (admin, flagged)
 *   GET  /api/rlhf/jobs              list recent prep jobs (admin)
 *   GET  /api/rlhf/jobs/:id          job status + artifact pointers (admin)
 *   GET  /api/rlhf/jobs/:id/artifact download scrubbed JSONL (admin)
 *   POST /api/rlhf/backfill          copy Message.feedback → preference_events (admin)
 *
 * Collection is on by default (SIRAGPT_RLHF_ENABLED). Best-of-N sampling
 * at generation time is off by default (SIRAGPT_RLHF_BEST_OF_N) because
 * it multiplies token cost. Train-prep jobs are off by default
 * (SIRAGPT_RLHF_TRAIN_JOBS) and stay prep-only unless a catalog adapter
 * exists AND SIRAGPT_RLHF_TRAIN_SUBMIT is on.
 */

const fs = require('fs');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const rag = require('../services/rag-service');
const rlhf = require('../services/rlhf');
const { REASON_CODES, resolveFeedbackReasons } = require('../services/rlhf/reason-codes');
const prisma = require('../config/database');
const {
  isTrainJobsEnabled,
  isTrainSubmitEnabled,
  getTrainJobQueue,
} = require('../services/rlhf/train-jobs');
const objectStorage = require('../services/object-storage');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');

const router = express.Router();

function handleErrors(fn) {
  return async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      await fn(req, res);
    } catch (err) {
      const code = err && err.code;
      const status = Number(err && err.status) || (code === 'E_DISABLED' ? 403 : code === 'E_QUOTA' ? 429 : code === 'E_PARAMS' ? 400 : 500);
      if (status >= 500) console.error(`[rlhf ${req.path}] failed:`, code || err.message || 'rlhf failed');
      const body = { error: err.message || 'rlhf failed' };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  };
}

function embedder() {
  return (texts) => rag.embed(texts);
}

async function loadOwnedMessage(userId, messageId) {
  if (!userId || !messageId || !prisma?.message?.findUnique) return null;
  try {
    const message = await prisma.message.findUnique({
      where: { id: String(messageId) },
      select: {
        id: true,
        content: true,
        role: true,
        chatId: true,
        timestamp: true,
        chat: { select: { userId: true } },
      },
    });
    if (!message || message.chat?.userId !== userId) return null;
    return message;
  } catch {
    return null;
  }
}

async function priorUserPrompt(message) {
  if (!message?.chatId || !prisma?.message?.findFirst) return '';
  try {
    const prior = await prisma.message.findFirst({
      where: {
        chatId: message.chatId,
        role: 'USER',
        timestamp: { lt: message.timestamp },
      },
      orderBy: { timestamp: 'desc' },
      select: { content: true, id: true },
    });
    return prior || null;
  } catch {
    return null;
  }
}

router.post(
  '/feedback',
  authenticateToken,
  [
    body('runId').optional().isString().isLength({ min: 1, max: 128 }),
    body('messageId').optional().isString().isLength({ min: 1, max: 128 }),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('request').optional().isString().isLength({ max: 8000 }),
    body('prompt').optional().isString().isLength({ max: 8000 }),
    body('response').custom((v) => v !== undefined),
    body('helpful').optional().isBoolean(),
    body('label').optional().isString().isLength({ max: 32 }),
    body('reason').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('reasonCode').optional({ nullable: true }).isString().isLength({ max: 32 }),
    body('notes').optional().isString().isLength({ max: 1000 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
  ],
  handleErrors(async (req, res) => {
    const reasons = resolveFeedbackReasons({
      reason: req.body.reason,
      reasonCode: req.body.reasonCode,
      notes: req.body.notes,
    });
    const r = await rlhf.ingestThumb({
      userId: req.user.id,
      runId: req.body.runId || req.body.messageId,
      messageId: req.body.messageId || req.body.runId,
      chatId: req.body.chatId || null,
      agent: req.body.agent || 'chat',
      request: req.body.request || req.body.prompt || '',
      response: req.body.response,
      helpful: typeof req.body.helpful === 'boolean' ? req.body.helpful : undefined,
      label: req.body.label,
      reason: req.body.reason,
      reasonCode: reasons.reasonCode,
      notes: reasons.notes,
      embedder: embedder(),
    });
    res.json({ ok: true, ...r, reasonCodes: REASON_CODES, stats: rlhf.stats(req.user.id) });
  }),
);

router.post(
  '/pair',
  authenticateToken,
  [
    body('prompt').optional().isString().isLength({ max: 8000 }),
    body('chosen').optional(),
    body('rejected').optional(),
    body('chosenMessageId').optional().isString().isLength({ min: 1, max: 128 }),
    body('rejectedMessageId').optional().isString().isLength({ min: 1, max: 128 }),
    body('reason').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('reasonCode').optional({ nullable: true }).isString().isLength({ max: 32 }),
    body('notes').optional().isString().isLength({ max: 1000 }),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
  ],
  handleErrors(async (req, res) => {
    let prompt = req.body.prompt || '';
    let chosenText = req.body.chosen;
    let rejectedText = req.body.rejected;
    let chosenMessageId = req.body.chosenMessageId || null;
    let rejectedMessageId = req.body.rejectedMessageId || null;
    let chatId = req.body.chatId || null;
    let promptMessageId = null;

    if (chosenMessageId || rejectedMessageId) {
      const [chosenMsg, rejectedMsg] = await Promise.all([
        chosenMessageId ? loadOwnedMessage(req.user.id, chosenMessageId) : null,
        rejectedMessageId ? loadOwnedMessage(req.user.id, rejectedMessageId) : null,
      ]);
      if (chosenMsg) {
        chosenText = chosenText != null ? chosenText : chosenMsg.content;
        chatId = chatId || chosenMsg.chatId;
        const prior = await priorUserPrompt(chosenMsg);
        if (prior) {
          prompt = prompt || prior.content || '';
          promptMessageId = prior.id || null;
        }
      }
      if (rejectedMsg) {
        rejectedText = rejectedText != null ? rejectedText : rejectedMsg.content;
        chatId = chatId || rejectedMsg.chatId;
        if (!prompt) {
          const prior = await priorUserPrompt(rejectedMsg);
          if (prior) {
            prompt = prior.content || '';
            promptMessageId = promptMessageId || prior.id || null;
          }
        }
      }
    }

    const pair = await rlhf.recordPair({
      userId: req.user.id,
      chatId,
      agent: req.body.agent || 'chat',
      prompt,
      chosen: chosenText,
      rejected: rejectedText,
      chosenMessageId,
      rejectedMessageId,
      promptMessageId,
      reason: req.body.reason,
      reasonCode: req.body.reasonCode,
      notes: req.body.notes,
      embedder: embedder(),
    });
    res.json({
      ok: !!pair.stored,
      ...pair,
      stats: rlhf.stats(req.user.id),
    });
  }),
);

router.post(
  '/rlaif/propose',
  authenticateToken,
  [
    body('prompt').optional().isString().isLength({ max: 8000 }),
    body('a').optional(),
    body('b').optional(),
    body('turns').optional().isArray({ max: 12 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
    body('agent').optional().isString().isLength({ max: 32 }),
  ],
  handleErrors(async (req, res) => {
    const openai = typeof rag.getOpenAI === 'function' ? rag.getOpenAI() : null;
    let out;
    if (req.body.a != null && req.body.b != null && req.body.prompt) {
      out = await rlhf.rlaif.proposePair({
        userId: req.user.id,
        prompt: req.body.prompt,
        a: req.body.a,
        b: req.body.b,
        chatId: req.body.chatId || null,
        agent: req.body.agent || 'chat',
        openai,
        embedder: embedder(),
      });
    } else {
      out = await rlhf.rlaif.proposeFromRecent({
        userId: req.user.id,
        turns: req.body.turns,
        chatId: req.body.chatId || null,
        agent: req.body.agent || 'chat',
        openai,
        embedder: embedder(),
      });
    }
    res.json({
      ok: true,
      enabled: rlhf.rlaif.isRlaifEnabled(),
      ...out,
      stats: rlhf.stats(req.user.id),
    });
  }),
);

router.get('/stats', authenticateToken, handleErrors(async (req, res) => {
  await rlhf.hydrateUser(req.user.id);
  const isAdmin = !!(req.user.isAdmin || req.user.isSuperAdmin);
  res.json({
    ok: true,
    enabled: rlhf.isCollectionEnabled(),
    steering: rlhf.isSteeringEnabled(),
    bestOfN: rlhf.isBestOfNEnabled(),
    rlaif: rlhf.rlaif.isRlaifEnabled(),
    model: rlhf.hasActiveModel() ? {
      version: rlhf.getActiveModel().version,
      metrics: rlhf.getActiveModel().metrics,
      trainedAt: rlhf.getActiveModel().trainedAt,
    } : null,
    user: rlhf.stats(req.user.id),
    global: isAdmin ? rlhf.stats() : null,
    rlcd: (() => {
      const snap = rlhf.rlcdStats();
      if (isAdmin) return snap;
      return {
        enabled: snap.enabled,
        meaning: snap.meaning,
        n: snap.n,
        brier: snap.brier,
        ece: snap.ece,
        deferRate: snap.deferRate,
      };
    })(),
    phase2: isAdmin ? {
      ...rlhf.phase2Stats(),
      trainJobsEnabled: isTrainJobsEnabled(),
      trainSubmitEnabled: isTrainSubmitEnabled(),
    } : {
      steeringEnabled: rlhf.isSteeringEnabled(),
      bestOfN: rlhf.isBestOfNEnabled(),
      trainJobsEnabled: isTrainJobsEnabled(),
      rlaif: rlhf.rlaif.isRlaifEnabled(),
    },
  });
}));

router.get('/export', authenticateToken, handleErrors(async (req, res) => {
  const format = String(req.query.format || 'sft').toLowerCase();
  const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
  const scrubPii = req.query.scrubPii !== 'false';
  const aggressive = req.query.aggressive === 'true';
  const includeRlaif = req.query.includeRlaif === 'true';
  if (!['sft', 'dpo', 'pairs', 'rm'].includes(format)) {
    return res.status(400).json({ error: `unknown format '${format}' — use sft, dpo, or rm` });
  }
  const out = await rlhf.exportData({
    userId: req.user.id, format, agent, scrubPii, aggressive, includeRlaif,
  });
  const filename = safeDownloadFilename(
    `rlhf-${format}${agent ? '-' + agent : ''}-${req.user.id}.jsonl`,
    { fallback: 'rlhf-preferences.jsonl', extension: '.jsonl' },
  );
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', filename));
  res.setHeader('X-Export-Count', String(out.count));
  res.setHeader('X-PII-Scrubbed', String(out.scrubbed));
  res.send(out.ndjson);
}));

router.post(
  '/score',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom((v) => v !== undefined),
  ],
  handleErrors(async (req, res) => {
    const out = await rlhf.scoreCompletion({
      prompt: req.body.prompt,
      response: typeof req.body.response === 'string' ? req.body.response : JSON.stringify(req.body.response),
      embedder: embedder(),
    });
    res.json({ ok: true, ...out });
  }),
);

router.post(
  '/rerank',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('samples').isArray({ min: 1, max: 8 }),
  ],
  handleErrors(async (req, res) => {
    const ranked = await rlhf.pickBest({
      prompt: req.body.prompt,
      userRequest: req.body.prompt,
      samples: req.body.samples,
      embedder: embedder(),
      openai: rag.getOpenAI(),
    });
    res.json({ ok: true, ...ranked });
  }),
);

router.post('/train', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  const result = await rlhf.train({
    userId: req.body && req.body.scope === 'user' ? req.user.id : null,
    scope: req.body && req.body.scope,
  });
  res.json({ ok: !!result.ok, ...result });
}));

router.get('/model', authenticateToken, handleErrors(async (req, res) => {
  await rlhf.loadLatestActive();
  const active = rlhf.getActiveModel();
  if (!active) return res.json({ ok: true, ready: false });
  res.json({
    ok: true,
    ready: true,
    version: active.version,
    metrics: active.metrics,
    trainedAt: active.trainedAt,
    scope: active.scope,
  });
}));

function adminJobsDisabled(res) {
  return res.status(403).json({
    error: 'RLHF train jobs are disabled',
    code: 'E_DISABLED',
  });
}

router.post(
  '/jobs',
  authenticateToken,
  requireAdmin,
  [
    body('format').isString().isIn(['sft', 'dpo', 'pairs', 'rm']),
    body('includeRlaif').optional().isBoolean(),
    body('minPairs').optional().isInt({ min: 1, max: 10000 }),
    body('scope').optional().isIn(['global', 'user']),
    body('scopeUserId').optional().isString().isLength({ min: 1, max: 128 }),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('scrubPii').optional().isBoolean(),
    body('aggressive').optional().isBoolean(),
    body('submit').optional().isBoolean(),
  ],
  handleErrors(async (req, res) => {
    if (!isTrainJobsEnabled()) return adminJobsDisabled(res);
    const queue = getTrainJobQueue();
    const job = await queue.enqueue({
      createdById: req.user.id,
      format: req.body.format,
      includeRlaif: req.body.includeRlaif === true,
      minPairs: req.body.minPairs,
      scope: req.body.scope,
      scopeUserId: req.body.scopeUserId,
      agent: req.body.agent,
      scrubPii: req.body.scrubPii,
      aggressive: req.body.aggressive === true,
      submit: req.body.submit === true,
    });
    res.status(202).json({
      ok: true,
      job,
      submitEnabled: isTrainSubmitEnabled(),
    });
  }),
);

router.get('/jobs', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  if (!isTrainJobsEnabled()) return adminJobsDisabled(res);
  const limit = req.query.limit;
  const queue = getTrainJobQueue();
  const jobs = await queue.list({ limit });
  res.json({
    ok: true,
    jobs,
    enabled: true,
    submitEnabled: isTrainSubmitEnabled(),
  });
}));

router.get('/jobs/:id', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  if (!isTrainJobsEnabled()) return adminJobsDisabled(res);
  const queue = getTrainJobQueue();
  const job = await queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found', code: 'E_PARAMS' });
  res.json({ ok: true, job });
}));

router.get('/jobs/:id/artifact', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  if (!isTrainJobsEnabled()) return adminJobsDisabled(res);
  const queue = getTrainJobQueue();
  const row = await queue.getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'job not found', code: 'E_PARAMS' });
  if (row.status !== 'ready') {
    return res.status(409).json({ error: 'artifact not ready', code: 'E_PARAMS', status: row.status });
  }
  const priv = row.result && row.result.__private;
  const ref = (priv && (priv.ref || priv.localPath)) || null;
  const format = row.format === 'pairs' ? 'dpo' : (row.format || 'sft');
  const filename = safeDownloadFilename(
    `rlhf-train-${format}-${row.id}.jsonl`,
    { fallback: 'rlhf-train.jsonl', extension: '.jsonl' },
  );
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', filename));
  if (row.result && row.result.count != null) {
    res.setHeader('X-Export-Count', String(row.result.count));
  }
  res.setHeader('X-PII-Scrubbed', String(row.scrubPii !== false));

  if (ref && objectStorage.isRemote(ref)) {
    const { stream } = await objectStorage.readStream(ref);
    stream.pipe(res);
    return;
  }
  const localPath = (priv && priv.localPath) || ref;
  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(404).json({ error: 'artifact missing', code: 'E_PARAMS' });
  }
  fs.createReadStream(localPath).pipe(res);
}));

router.post('/backfill', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  const prisma = require('../config/database');
  const result = await rlhf.backfill({
    prisma,
    embedder: embedder(),
    userId: req.body && req.body.userId ? String(req.body.userId) : null,
    limit: req.body && req.body.limit,
  });
  res.json({ ok: !!result.ok, ...result, stats: rlhf.stats() });
}));

module.exports = router;
