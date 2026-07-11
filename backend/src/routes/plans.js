'use strict';

/**
 * /api/plans — F2 PR6 — Public plan catalog + admin CRUD.
 *
 *   GET    /api/plans               → list active plans, ordered by displayOrder
 *   GET    /api/plans/:code         → one plan by canonical code (FREE/PRO/...)
 *   POST   /api/admin/plans         → create a new plan        (super admin only)
 *   PATCH  /api/admin/plans/:id     → partial update a plan    (super admin only)
 *
 * The plans table is seeded by migration `20260523210000_add_plan_table`
 * with 4 canonical tiers. Admin endpoints can override pricing /
 * monthly credits / Stripe price IDs / features without a migration.
 *
 * Until F2 PR9/PR10 ship the declarative `requirePermission()` middleware,
 * the admin endpoints gate on the legacy `req.user.isSuperAdmin` flag.
 * That flag is preserved by F1 PR4 backfill so existing super admins
 * keep their access. PR10 will swap the gate to `requirePermission(
 * 'plans.manage')` in shadow mode.
 */

const express = require('express');
const { z } = require('zod');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const requireAdminRoutePermission = require('../services/admin-route-policy');
const prisma = require('../config/database');

const router = express.Router();

const PLAN_CODE = z.enum(['FREE', 'PRO', 'PRO_MAX', 'ENTERPRISE']);

const CreatePlanSchema = z.object({
  code: PLAN_CODE,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  priceMonthlyCents: z.number().int().min(0).max(100_000_00).optional(),
  priceYearlyCents: z.number().int().min(0).max(100_000_00).optional(),
  currency: z.string().length(3).toLowerCase().optional(),
  monthlyCredits: z
    .union([z.number().int().min(0), z.string().regex(/^\d+$/)])
    .optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  features: z.array(z.unknown()).optional(),
  stripePriceIdMonthly: z.string().max(200).optional().nullable(),
  stripePriceIdYearly: z.string().max(200).optional().nullable(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
});

const UpdatePlanSchema = CreatePlanSchema.partial();

// ── Helpers ────────────────────────────────────────────────────────
function serializePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    priceMonthlyCents: plan.priceMonthlyCents,
    priceYearlyCents: plan.priceYearlyCents,
    currency: plan.currency,
    monthlyCredits:
      typeof plan.monthlyCredits === 'bigint'
        ? plan.monthlyCredits.toString()
        : String(plan.monthlyCredits ?? 0),
    trialDays: plan.trialDays,
    features: plan.features ?? [],
    isActive: plan.isActive,
    displayOrder: plan.displayOrder,
    stripePriceIdMonthly: plan.stripePriceIdMonthly ?? null,
    stripePriceIdYearly: plan.stripePriceIdYearly ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function coerceBigInt(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}

function requireSuperAdmin(req, res) {
  if (!req.user || !req.user.isSuperAdmin) {
    res.status(403).json({ error: 'forbidden', missingPermission: 'plans.manage' });
    return false;
  }
  return true;
}

// ── Routes ─────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const includeInactive =
      req.user?.isSuperAdmin && req.query.includeInactive === 'true';
    const plans = await prisma.planCatalog.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
    });
    res.json({ plans: plans.map(serializePlan) });
  } catch (err) {
    next(err);
  }
});

router.get('/:code', optionalAuth, async (req, res, next) => {
  try {
    const codeParse = PLAN_CODE.safeParse(req.params.code);
    if (!codeParse.success) {
      return res.status(400).json({ error: 'invalid plan code' });
    }
    const plan = await prisma.planCatalog.findUnique({
      where: { code: codeParse.data },
    });
    if (!plan || (!plan.isActive && !req.user?.isSuperAdmin)) {
      return res.status(404).json({ error: 'plan not found' });
    }
    res.json({ plan: serializePlan(plan) });
  } catch (err) {
    next(err);
  }
});

// Admin write endpoints — mounted under /api/admin/plans (see index.js).
const adminRouter = express.Router();
adminRouter.use(authenticateToken, requireAdminRoutePermission);

adminRouter.post('/', async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const parse = CreatePlanSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = {
      ...parse.data,
      monthlyCredits: coerceBigInt(parse.data.monthlyCredits),
    };
    if (data.monthlyCredits === undefined) delete data.monthlyCredits;
    const plan = await prisma.planCatalog.create({ data });
    res.status(201).json({ plan: serializePlan(plan) });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'plan code already exists' });
    }
    next(err);
  }
});

adminRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const parse = UpdatePlanSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = { ...parse.data };
    if (data.monthlyCredits !== undefined) {
      data.monthlyCredits = coerceBigInt(data.monthlyCredits);
    }
    const plan = await prisma.planCatalog.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ plan: serializePlan(plan) });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: 'plan not found' });
    }
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'plan code already exists' });
    }
    next(err);
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
module.exports.serializePlan = serializePlan;
module.exports.CreatePlanSchema = CreatePlanSchema;
module.exports.UpdatePlanSchema = UpdatePlanSchema;
