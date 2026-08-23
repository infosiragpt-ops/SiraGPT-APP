/**
 * routes/routines — user-facing surface for recurring agent routines
 * shown in /code under the department computer panel («Rutinas»).
 *
 * Thin shell over services/scheduler/scheduler (the durable cron engine,
 * persisted in backend/data/scheduled-jobs.json, owned by the background
 * jobs fleet). This route adds:
 *   - `name` (friendly label) stored in job.meta.name
 *   - nextRunAt computed per job (timezone-aware) so the UI can show
 *     «próxima ejecución» without duplicating cron logic client-side
 *   - a status projection (idle|running|ok|error|disabled|skipped)
 *
 * Execution itself stays in the scheduler: fireJob → agent invoker.
 */

'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

function loadScheduler() {
  try {
    return require('../services/scheduler/scheduler');
  } catch (err) {
    console.error('[routines] scheduler unavailable:', err?.message || err);
    return null;
  }
}

const MAX_NAME_LEN = 120;
const MAX_PROMPT_LEN = 8000;

function computeNextRunAt(cronExpr, timezone) {
  // cron-parser is tz-aware and already a dependency; node-cron's task
  // object exposes no next-run API in 3.x.
  try {
    const parser = require('cron-parser');
    const interval = parser.parseExpression(String(cronExpr), {
      currentDate: new Date(),
      tz: timezone || 'UTC',
    });
    return interval.next().toISOString();
  } catch (_) {
    return null;
  }
}

function serializeJob(job) {
  const base = typeof job.toJSON === 'function' ? job.toJSON() : job;
  const meta = base && base.meta ? base.meta : {};
  const lastRuns = Array.isArray(base.lastRuns) ? base.lastRuns.slice(0, 10) : [];
  return {
    id: base.id,
    name: String(meta.name || '').slice(0, MAX_NAME_LEN) || null,
    cron: base.cron || null,
    timezone: base.timezone || null,
    promptPreview: String(base.prompt || '').slice(0, 200),
    enabled: Boolean(base.enabled),
    status: base.status || 'idle',
    statusDetails: base.statusDetails || null,
    nextRunAt: base.enabled ? computeNextRunAt(base.cron, base.timezone) : null,
    lastRunAt: (lastRuns[0] && lastRuns[0].at) || null,
    lastStatus: lastRuns[0] ? (lastRuns[0].ok ? 'ok' : 'error') : null,
    lastError: (lastRuns[0] && !lastRuns[0].ok && lastRuns[0].error) ? String(lastRuns[0].error).slice(0, 300) : null,
    lastRuns: lastRuns.map((r) => ({
      at: r.at || null,
      ok: r.ok === true,
      error: r.error ? String(r.error).slice(0, 300) : undefined,
    })),
    createdAt: base.createdAt || null,
  };
}

const createValidators = [
  body('name').optional().isString().isLength({ min: 1, max: MAX_NAME_LEN }),
  body('cron').isString().isLength({ min: 5, max: 100 }),
  body('prompt').isString().trim().isLength({ min: 3, max: MAX_PROMPT_LEN }),
  body('timezone').optional().isString().isLength({ min: 1, max: 64 }),
];

router.get('/', authenticateToken, async (req, res) => {
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const sched = loadScheduler();
  if (!sched) return res.status(503).json({ error: 'scheduler_unavailable' });
  try {
    const jobs = sched.listJobs({ userId });
    return res.json({
      routines: jobs.filter((j) => j.type !== 'webhook').map(serializeJob),
    });
  } catch (err) {
    console.error('[routines] list failed:', err?.message || err);
    return res.status(500).json({ error: 'list_failed', message: err?.message || 'unknown' });
  }
});

router.post('/', authenticateToken, createValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const name = req.body.name ? String(req.body.name).trim().slice(0, MAX_NAME_LEN) : '';
  const cronExpr = String(req.body.cron).trim();
  const prompt = String(req.body.prompt).trim();
  const timezone = req.body.timezone ? String(req.body.timezone).trim() : null;

  if (!cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'invalid_cron', message: 'La expresión cron no es válida (5 campos).' });
  }

  const sched = loadScheduler();
  if (!sched) return res.status(503).json({ error: 'scheduler_unavailable' });
  try {
    const job = sched.createCronJob({
      userId,
      cron: cronExpr,
      prompt,
      timezone,
      meta: name ? { name, source: 'code-routines' } : { source: 'code-routines' },
    });
    return res.status(201).json({ routine: serializeJob(sched.getJob(job.id) || job) });
  } catch (err) {
    console.error('[routines] create failed:', err?.message || err);
    return res.status(500).json({ error: 'create_failed', message: err?.message || 'unknown' });
  }
});

router.delete(
  '/:id',
  authenticateToken,
  [param('id').isString().isLength({ min: 6, max: 64 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    const userId = String(req.user?.id || '');
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const sched = loadScheduler();
    if (!sched) return res.status(503).json({ error: 'scheduler_unavailable' });
    try {
      const result = sched.cancelJob({ userId, jobId: String(req.params.id) });
      if (!result.ok) return res.status(404).json({ error: 'not_found' });
      return res.json({ deleted: true, id: result.removed.id });
    } catch (err) {
      console.error('[routines] delete failed:', err?.message || err);
      return res.status(500).json({ error: 'delete_failed', message: err?.message || 'unknown' });
    }
  },
);

router.post(
  '/:id/pause',
  authenticateToken,
  [param('id').isString().isLength({ min: 6, max: 64 })],
  async (req, res) => setEnabledRoute(req, res, false),
);

router.post(
  '/:id/resume',
  authenticateToken,
  [param('id').isString().isLength({ min: 6, max: 64 })],
  async (req, res) => setEnabledRoute(req, res, true),
);

async function setEnabledRoute(req, res, enabled) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const sched = loadScheduler();
  if (!sched) return res.status(503).json({ error: 'scheduler_unavailable' });
  try {
    const result = sched.setJobEnabled({ userId, jobId: String(req.params.id), enabled });
    if (!result.ok) return res.status(404).json({ error: 'not_found' });
    return res.json({ routine: serializeJob(result.job) });
  } catch (err) {
    console.error('[routines] setEnabled failed:', err?.message || err);
    return res.status(500).json({ error: 'update_failed', message: err?.message || 'unknown' });
  }
}

module.exports = { router, serializeJob, computeNextRunAt };
