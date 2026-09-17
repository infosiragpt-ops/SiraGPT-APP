'use strict';

const { getPlanQuotaSnapshot, countFreeDailyCalls, isPlanQuotaExempt } = require('./plan-quota');

/** Fresh account state, before multipart. This check is not a reservation of
 * tokens and does not replace the worker's durable budget ledger. */
function createDocumentAdmissionPolicy(prisma) {
  return (req, res, next) => {
    const deny = (status, code, message) => {
      if (!res.destroyed) res.set('Cache-Control', 'no-store').status(status).json({ code, message });
    };
    if (!req.user?.id) return deny(401, 'E_FORBIDDEN', 'Inicia sesión para editar documentos.');
    Promise.resolve().then(async () => {
      const user = await prisma.user.findUnique({ where: { id: req.user.id },
        select: { id: true, deletedAt: true, plan: true, isSuperAdmin: true, apiUsage: true, monthlyLimit: true } });
      if (req.aborted || res.destroyed) return;
      if (!user || user.deletedAt) return deny(403, 'E_FORBIDDEN', 'La cuenta no está disponible.');
      // Unknown fields must not be coerced to an unlimited plan by legacy helpers.
      if (!['FREE', 'PRO', 'PRO_MAX', 'ENTERPRISE'].includes(user.plan) ||
          user.apiUsage == null || user.monthlyLimit == null ||
          !/^\d+$/.test(String(user.apiUsage)) || !/^\d+$/.test(String(user.monthlyLimit))) {
        throw new Error('DOC_ACCOUNT_QUOTA_UNAVAILABLE');
      }
      const freeDailyCallsUsed = user.plan === 'FREE' && !isPlanQuotaExempt(user)
        ? await countFreeDailyCalls({ userId: user.id, prisma }) : null;
      if (req.aborted || res.destroyed) return;
      const snapshot = getPlanQuotaSnapshot(user, { freeDailyCallsUsed });
      if (snapshot.exceeded) return deny(429, 'E_QUOTA', 'Se agotó la cuota de tu plan.');
      req.user = { ...req.user, ...user };
      next();
    }).catch(() => deny(503, 'E_NOT_READY', 'No se pudo comprobar la cuota; vuelve a intentarlo.'));
  };
}

module.exports = { createDocumentAdmissionPolicy };
