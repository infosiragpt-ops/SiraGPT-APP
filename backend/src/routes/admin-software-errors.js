'use strict';

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const store = require('../services/software-errors/store');
const repair = require('../services/software-errors/repair');
const worker = require('../services/software-errors/worker');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

function dayBound(value, end) {
  if (!value) return undefined;
  const raw = String(value);
  if (raw.includes('T')) return raw;
  const suffix = end ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const d = new Date(`${raw}${suffix}`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

router.get('/', async (req, res) => {
  try {
    const stale = !worker.status().lastTickAt
      || (Date.now() - Date.parse(worker.status().lastTickAt || 0) > 20_000);
    if (stale) {
      await worker.tick();
    }
    const result = await store.listErrors({
      page: req.query.page,
      limit: req.query.limit,
      severity: req.query.severity,
      service: req.query.service,
      status: req.query.status,
      from: dayBound(req.query.from, false),
      to: dayBound(req.query.to, true),
      q: req.query.q,
    });
    res.json({
      ok: true,
      view: 'errors',
      marker: 'autonome',
      worker: worker.status(),
      ...result,
    });
  } catch (err) {
    console.error('[admin/software-errors] list failed:', err?.message || err);
    res.status(500).json({ error: 'No se pudieron cargar los errores' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await store.getError(req.params.id);
    if (!row) return res.status(404).json({ error: 'Error no encontrado' });
    res.json({ ok: true, item: row });
  } catch (err) {
    console.error('[admin/software-errors] get failed:', err?.message || err);
    res.status(500).json({ error: 'No se pudo leer el error' });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const row = await store.getError(req.params.id);
    if (!row) return res.status(404).json({ error: 'Error no encontrado' });
    const result = await repair.attempt(row, { manual: true });
    res.json({
      ok: Boolean(result.ok),
      item: result.row,
      result: result.result || null,
      error: result.error || null,
    });
  } catch (err) {
    const status = err?.message === 'no_safe_repair' ? 409 : 500;
    res.status(status).json({
      error: err.detail || err.message || 'No se pudo reintentar la reparación',
    });
  }
});

module.exports = router;
