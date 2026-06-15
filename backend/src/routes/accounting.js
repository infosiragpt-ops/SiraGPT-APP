'use strict';

/**
 * /api/accounting — Sistema contable (PCGE peruano, partida doble).
 * Auth: requiere authenticateToken (datos contables de la organización).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');

const journal = require('../services/accounting/journal');
const { seedPcge } = require('../services/accounting/pcge');

const router = express.Router();

// Mapea errores tipados del dominio contable a códigos HTTP.
function sendDomainError(res, err) {
  if (err && err.code === 'VALIDATION_ERROR') {
    return res.status(400).json({ error: 'validation_error', message: err.message, issues: err.issues || [] });
  }
  if (err && err.code === 'UNBALANCED_ENTRY') {
    return res.status(422).json({ error: 'unbalanced_entry', message: err.message, details: err.details });
  }
  if (err && err.code === 'ACCOUNT_NOT_FOUND') {
    return res.status(422).json({ error: 'account_not_found', message: err.message, missing: err.missing });
  }
  console.error('[accounting] error:', err && err.message);
  return res.status(500).json({ error: 'internal_error', message: 'Error interno del módulo contable' });
}

// ── Plan de cuentas (PCGE) ───────────────────────────────────────────────────
router.get('/accounts', authenticateToken, async (req, res) => {
  try {
    const where = { isActive: true };
    if (req.query.element) where.element = Number(req.query.element);
    if (req.query.postable === 'true') where.postable = true;
    const accounts = await prisma.accountingAccount.findMany({ where, orderBy: { code: 'asc' } });
    res.json({ accounts, total: accounts.length });
  } catch (err) { sendDomainError(res, err); }
});

// Seed idempotente del catálogo PCGE base (solo admin).
router.post('/accounts/seed', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')) {
      return res.status(403).json({ error: 'forbidden', message: 'Solo administradores pueden sembrar el catálogo PCGE' });
    }
    const result = await seedPcge(prisma);
    res.json({ ok: true, ...result });
  } catch (err) { sendDomainError(res, err); }
});

// ── Libro Diario ─────────────────────────────────────────────────────────────
router.post('/journal-entries', authenticateToken, express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const entry = await journal.createJournalEntry({ prisma, input: req.body, userId: req.user && req.user.id });
    res.status(201).json({ entry });
  } catch (err) { sendDomainError(res, err); }
});

router.get('/journal-entries', authenticateToken, async (req, res) => {
  try {
    const result = await journal.listJournalEntries({
      prisma,
      status: req.query.status,
      source: req.query.source,
      from: req.query.from,
      to: req.query.to,
      skip: Math.max(0, Number(req.query.skip) || 0),
      take: Math.min(200, Math.max(1, Number(req.query.take) || 50)),
    });
    res.json(result);
  } catch (err) { sendDomainError(res, err); }
});

router.get('/journal-entries/:id', authenticateToken, async (req, res) => {
  try {
    const entry = await journal.getJournalEntry({ prisma, id: req.params.id });
    if (!entry) return res.status(404).json({ error: 'not_found', message: 'Asiento no encontrado' });
    res.json({ entry });
  } catch (err) { sendDomainError(res, err); }
});

module.exports = router;
