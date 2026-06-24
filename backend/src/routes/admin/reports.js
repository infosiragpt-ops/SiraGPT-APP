/**
 * Admin · Reports — real report builders over existing Prisma tables.
 *
 * GET /            → catalog of available report types
 * GET /:type       → JSON report for a date range (?from=&to=, ≤92 days)
 * GET /:type?format=csv → RFC-4180 CSV download
 *
 * Types: user-activity, api-usage, security, performance (admin tier)
 * and revenue (super-admin, matching the existing /cost-report policy).
 * Replaces a page that listed five fictional reports and an alert()
 * download button.
 */

const express = require('express');
const { authenticateToken, requireAdmin } = require('../../middleware/auth');

const MAX_RANGE_DAYS = 92;

const REPORT_TYPES = [
  { id: 'user-activity', nombre: 'Actividad de usuarios', descripcion: 'Altas, sesiones, chats y mensajes por día', superAdmin: false },
  { id: 'api-usage', nombre: 'Uso de API', descripcion: 'Tokens y llamadas por modelo', superAdmin: false },
  { id: 'security', nombre: 'Seguridad', descripcion: 'Eventos de auditoría agregados por acción', superAdmin: false },
  { id: 'performance', nombre: 'Rendimiento', descripcion: 'Volumen de actividad por día (chats, mensajes, archivos)', superAdmin: false },
  { id: 'revenue', nombre: 'Ingresos', descripcion: 'Pagos completados por día (solo super-admin)', superAdmin: true },
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(','));
  return lines.join('\n') + '\n';
}

function parseRange(query = {}) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  const from = query.from
    ? new Date(String(query.from))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return { error: 'Rango de fechas inválido' };
  }
  if ((to - from) / (24 * 60 * 60 * 1000) > MAX_RANGE_DAYS) {
    return { error: `El rango máximo es de ${MAX_RANGE_DAYS} días` };
  }
  return { from, to };
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function bucketByDay(rows, field, from, to) {
  const days = {};
  for (let t = new Date(dayKey(from)); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) {
    days[dayKey(t)] = 0;
  }
  for (const row of rows) {
    const key = dayKey(row[field]);
    if (key in days) days[key] += 1;
  }
  return days;
}

async function buildUserActivity(prismaClient, { from, to }) {
  const where = { createdAt: { gte: from, lte: to } };
  const [signups, sessions, chats, messages] = await Promise.all([
    prismaClient.user.findMany({ where: { ...where, isSuperAdmin: false }, select: { createdAt: true } }),
    prismaClient.session.findMany({ where, select: { createdAt: true } }),
    prismaClient.chat.findMany({ where, select: { createdAt: true } }),
    prismaClient.message.findMany({ where: { timestamp: { gte: from, lte: to } }, select: { timestamp: true } }),
  ]);
  const buckets = {
    altas: bucketByDay(signups, 'createdAt', from, to),
    sesiones: bucketByDay(sessions, 'createdAt', from, to),
    chats: bucketByDay(chats, 'createdAt', from, to),
    mensajes: bucketByDay(messages, 'timestamp', from, to),
  };
  return Object.keys(buckets.altas).map((dia) => ({
    dia,
    altas: buckets.altas[dia],
    sesiones: buckets.sesiones[dia],
    chats: buckets.chats[dia],
    mensajes: buckets.mensajes[dia],
  }));
}

async function buildApiUsage(prismaClient, { from, to }) {
  const grouped = await prismaClient.apiUsage.groupBy({
    by: ['model'],
    where: { timestamp: { gte: from, lte: to } },
    _sum: { tokens: true },
    _count: { model: true },
  });
  return grouped
    .map((row) => ({ modelo: row.model, llamadas: row._count.model, tokens: Number(row._sum.tokens || 0) }))
    .sort((a, b) => b.tokens - a.tokens);
}

async function buildSecurity(prismaClient, { from, to }) {
  const grouped = await prismaClient.auditLog.groupBy({
    by: ['action'],
    where: { createdAt: { gte: from, lte: to } },
    _count: { action: true },
  });
  return grouped
    .map((row) => ({ accion: row.action, eventos: row._count.action }))
    .sort((a, b) => b.eventos - a.eventos);
}

async function buildPerformance(prismaClient, { from, to }) {
  const where = { createdAt: { gte: from, lte: to } };
  const [chats, messages, files] = await Promise.all([
    prismaClient.chat.findMany({ where, select: { createdAt: true } }),
    prismaClient.message.findMany({ where: { timestamp: { gte: from, lte: to } }, select: { timestamp: true } }),
    prismaClient.file.findMany({ where, select: { createdAt: true } }),
  ]);
  const buckets = {
    chats: bucketByDay(chats, 'createdAt', from, to),
    mensajes: bucketByDay(messages, 'timestamp', from, to),
    archivos: bucketByDay(files, 'createdAt', from, to),
  };
  return Object.keys(buckets.chats).map((dia) => ({
    dia,
    chats: buckets.chats[dia],
    mensajes: buckets.mensajes[dia],
    archivos: buckets.archivos[dia],
  }));
}

async function buildRevenue(prismaClient, { from, to }) {
  const payments = await prismaClient.payment.findMany({
    where: { createdAt: { gte: from, lte: to }, status: 'COMPLETED' },
    select: { createdAt: true, amount: true, currency: true },
  });
  const byDay = {};
  for (const p of payments) {
    const key = dayKey(p.createdAt);
    byDay[key] = byDay[key] || { dia: key, pagos: 0, importe: 0 };
    byDay[key].pagos += 1;
    byDay[key].importe += Number(p.amount) || 0;
  }
  return Object.values(byDay).sort((a, b) => a.dia.localeCompare(b.dia));
}

const BUILDERS = {
  'user-activity': buildUserActivity,
  'api-usage': buildApiUsage,
  security: buildSecurity,
  performance: buildPerformance,
  revenue: buildRevenue,
};

function createRouter({ prismaClient }) {
  const router = express.Router();
  router.use(authenticateToken, requireAdmin);

  router.get('/', (_req, res) => {
    res.json({ types: REPORT_TYPES });
  });

  router.get('/:type', async (req, res, next) => {
    const type = String(req.params.type || '');
    const meta = REPORT_TYPES.find((t) => t.id === type);
    if (!meta) {
      return res.status(400).json({ error: `Tipo de reporte inválido: ${type}` });
    }
    // Revenue follows the existing /cost-report privilege policy
    // (same check requireSuperAdmin performs).
    if (meta.superAdmin && !req.user?.isSuperAdmin) {
      return res.status(403).json({ error: 'Este reporte requiere super-admin' });
    }
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    try {
      const rows = await BUILDERS[type](prismaClient, range);
      if (String(req.query.format || '').toLowerCase() === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${type}-${dayKey(range.from)}_${dayKey(range.to)}.csv`);
        return res.send(toCsv(rows));
      }
      res.json({
        type,
        nombre: meta.nombre,
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        rows,
        total: rows.length,
      });
    } catch (error) {
      console.error(`Admin report '${type}' error:`, error);
      next ? next(error) : res.status(500).json({ error: 'No se pudo generar el reporte' });
    }
  });

  // Final error guard so a builder failure answers JSON, not HTML.
  router.use((error, _req, res, _next) => {
    res.status(500).json({ error: 'No se pudo generar el reporte' });
  });

  return router;
}

const prisma = require('../../config/database');
module.exports = createRouter({ prismaClient: prisma });
module.exports.createRouter = createRouter;
module.exports._internals = { REPORT_TYPES, parseRange, toCsv, csvEscape, bucketByDay, BUILDERS };
