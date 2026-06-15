'use strict';

/**
 * /api/accounting — Sistema contable (PCGE peruano, partida doble).
 * Auth: requiere authenticateToken (datos contables de la organización).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');

const journal = require('../services/accounting/journal');
const ledger = require('../services/accounting/ledger');
const periods = require('../services/accounting/periods');
const exchangeRate = require('../services/accounting/exchange-rate');
const catalog = require('../services/accounting/catalog');
const invoicing = require('../services/accounting/invoicing');
const autoJournal = require('../services/accounting/auto-journal');
const ple = require('../services/accounting/ple');
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
  if (err && err.code === 'PERIOD_CLOSED') {
    return res.status(422).json({ error: 'period_closed', message: err.message, period: err.period });
  }
  if (err && (err.code === 'RATE_NOT_FOUND' || err.code === 'INVALID_RATE')) {
    return res.status(422).json({ error: err.code.toLowerCase(), message: err.message });
  }
  if (err && err.code === 'NOT_FOUND') {
    return res.status(404).json({ error: 'not_found', message: err.message });
  }
  if (err && (err.code === 'INVALID_STATE' || err.code === 'OSE_NOT_CONFIGURED')) {
    return res.status(422).json({ error: err.code.toLowerCase(), message: err.message, hints: err.hints });
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

// ── Periodos contables ───────────────────────────────────────────────────────
router.get('/periods', authenticateToken, async (req, res) => {
  try {
    res.json({ periods: await periods.listPeriods({ prisma }) });
  } catch (err) { sendDomainError(res, err); }
});

router.post('/periods/open', authenticateToken, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    res.json({ period: await periods.openPeriod({ prisma, input: req.body }) });
  } catch (err) { sendDomainError(res, err); }
});

router.post('/periods/close', authenticateToken, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    res.json({ period: await periods.closePeriod({ prisma, input: req.body, closedBy: req.user && req.user.id }) });
  } catch (err) { sendDomainError(res, err); }
});

// ── Clientes ─────────────────────────────────────────────────────────────────
router.get('/customers', authenticateToken, async (req, res) => {
  try {
    res.json(await catalog.listCustomers({ prisma, q: req.query.q, skip: Math.max(0, Number(req.query.skip) || 0), take: Math.min(200, Math.max(1, Number(req.query.take) || 50)) }));
  } catch (err) { sendDomainError(res, err); }
});
router.post('/customers', authenticateToken, express.json({ limit: '16kb' }), async (req, res) => {
  try { res.status(201).json({ customer: await catalog.createCustomer({ prisma, input: req.body }) }); } catch (err) { sendDomainError(res, err); }
});
router.get('/customers/:id', authenticateToken, async (req, res) => {
  try {
    const customer = await catalog.getCustomer({ prisma, id: req.params.id });
    if (!customer) return res.status(404).json({ error: 'not_found', message: 'Cliente no encontrado' });
    res.json({ customer });
  } catch (err) { sendDomainError(res, err); }
});
router.patch('/customers/:id', authenticateToken, express.json({ limit: '16kb' }), async (req, res) => {
  try { res.json({ customer: await catalog.updateCustomer({ prisma, id: req.params.id, input: req.body }) }); } catch (err) { sendDomainError(res, err); }
});

// ── Productos / servicios ────────────────────────────────────────────────────
router.get('/products', authenticateToken, async (req, res) => {
  try {
    const isSubscription = req.query.isSubscription == null ? undefined : req.query.isSubscription === 'true';
    res.json(await catalog.listProducts({ prisma, kind: req.query.kind, isSubscription, skip: Math.max(0, Number(req.query.skip) || 0), take: Math.min(300, Math.max(1, Number(req.query.take) || 100)) }));
  } catch (err) { sendDomainError(res, err); }
});
router.post('/products', authenticateToken, express.json({ limit: '16kb' }), async (req, res) => {
  try { res.status(201).json({ product: await catalog.createProduct({ prisma, input: req.body }) }); } catch (err) { sendDomainError(res, err); }
});
router.get('/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await catalog.getProduct({ prisma, id: req.params.id });
    if (!product) return res.status(404).json({ error: 'not_found', message: 'Producto no encontrado' });
    res.json({ product });
  } catch (err) { sendDomainError(res, err); }
});
router.patch('/products/:id', authenticateToken, express.json({ limit: '16kb' }), async (req, res) => {
  try { res.json({ product: await catalog.updateProduct({ prisma, id: req.params.id, input: req.body }) }); } catch (err) { sendDomainError(res, err); }
});

// ── Comprobantes electrónicos (boleta/factura) ───────────────────────────────
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    res.json(await invoicing.listInvoices({ prisma, docType: req.query.docType, status: req.query.status, customerId: req.query.customerId, skip: Math.max(0, Number(req.query.skip) || 0), take: Math.min(200, Math.max(1, Number(req.query.take) || 50)) }));
  } catch (err) { sendDomainError(res, err); }
});
router.post('/invoices', authenticateToken, express.json({ limit: '256kb' }), async (req, res) => {
  try { res.status(201).json({ invoice: await invoicing.createInvoice({ prisma, input: req.body, userId: req.user && req.user.id }) }); } catch (err) { sendDomainError(res, err); }
});
router.get('/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const invoice = await invoicing.getInvoice({ prisma, id: req.params.id });
    if (!invoice) return res.status(404).json({ error: 'not_found', message: 'Comprobante no encontrado' });
    res.json({ invoice });
  } catch (err) { sendDomainError(res, err); }
});
router.post('/invoices/:id/issue', authenticateToken, async (req, res) => {
  try { res.json({ invoice: await invoicing.issueInvoice({ prisma, id: req.params.id }) }); } catch (err) { sendDomainError(res, err); }
});
router.post('/invoices/:id/payment', authenticateToken, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const entry = await autoJournal.registerPayment({ prisma, invoiceId: req.params.id, account: req.body && req.body.account, amount: req.body && req.body.amount, date: req.body && req.body.date });
    res.status(201).json({ entry });
  } catch (err) { sendDomainError(res, err); }
});

// ── Tipo de cambio (multimoneda) ─────────────────────────────────────────────
router.get('/exchange-rates', authenticateToken, async (req, res) => {
  try {
    res.json({ rates: await exchangeRate.listRates({ prisma, currency: req.query.currency }) });
  } catch (err) { sendDomainError(res, err); }
});

router.post('/exchange-rates', authenticateToken, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    res.status(201).json({ rate: await exchangeRate.recordRate({ prisma, input: req.body }) });
  } catch (err) { sendDomainError(res, err); }
});

router.get('/exchange-rates/lookup', authenticateToken, async (req, res) => {
  try {
    const rate = await exchangeRate.getRate({ prisma, currency: req.query.currency, date: req.query.date, rateType: req.query.rateType });
    res.json({ currency: String(req.query.currency || '').toUpperCase(), rate });
  } catch (err) { sendDomainError(res, err); }
});

// ── Libros electrónicos PLE (SUNAT) ──────────────────────────────────────────
router.get('/ple/ventas', authenticateToken, async (req, res) => {
  try {
    const text = await ple.generateVentasPle({ prisma, periodo: req.query.periodo });
    res.type('text/plain').send(text);
  } catch (err) { sendDomainError(res, err); }
});

router.get('/ple/compras', authenticateToken, async (req, res) => {
  try {
    // Las compras se proveen como registros capturados (módulo de compras = extensión futura).
    const text = await ple.generateComprasPle({ purchases: [], periodo: req.query.periodo });
    res.type('text/plain').send(text);
  } catch (err) { sendDomainError(res, err); }
});

// ── Libro Mayor / Balance de comprobación ────────────────────────────────────
router.get('/ledger', authenticateToken, async (req, res) => {
  try {
    const accounts = await ledger.computeLedger({ prisma, from: req.query.from, to: req.query.to });
    res.json({ accounts });
  } catch (err) { sendDomainError(res, err); }
});

router.get('/ledger/:accountCode', authenticateToken, async (req, res) => {
  try {
    const account = await ledger.computeLedger({ prisma, accountCode: req.params.accountCode, from: req.query.from, to: req.query.to });
    res.json({ account });
  } catch (err) { sendDomainError(res, err); }
});

router.get('/trial-balance', authenticateToken, async (req, res) => {
  try {
    const result = await ledger.computeTrialBalance({ prisma, from: req.query.from, to: req.query.to });
    res.json(result);
  } catch (err) { sendDomainError(res, err); }
});

module.exports = router;
