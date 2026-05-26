'use strict';

// F2 PR6 — Unit tests for the plans router. Verifies the Zod schemas
// (accept canonical payloads, reject malformed ones), serializePlan's
// BigInt handling, and the exported router shape — without spinning up
// a live Express server.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stub the auth middleware + Prisma client BEFORE requiring the route
// so the module's `require()` returns the stubs instead of the real
// implementations (Prisma here would fail without a live DATABASE_URL).
const origResolve = Module._resolveFilename;
const origRequire = Module.prototype.require;
const stubFiles = new Map();
stubFiles.set('../middleware/auth', {
  authenticateToken: (_req, _res, next) => next(),
  optionalAuth: (_req, _res, next) => next(),
});
stubFiles.set('../config/database', {
  planCatalog: {
    async findMany() {
      return [];
    },
    async findUnique() {
      return null;
    },
    async create({ data }) {
      return { id: 'p_test', createdAt: new Date(), updatedAt: new Date(), ...data };
    },
    async update({ where, data }) {
      return { id: where.id, createdAt: new Date(), updatedAt: new Date(), code: 'PRO', ...data };
    },
  },
});

Module.prototype.require = function patchedRequire(spec) {
  if (stubFiles.has(spec)) return stubFiles.get(spec);
  return origRequire.apply(this, arguments);
};

const plans = require('../src/routes/plans');
const { serializePlan, CreatePlanSchema, UpdatePlanSchema, adminRouter } = plans;

// Restore so other tests load real modules.
Module.prototype.require = origRequire;
Module._resolveFilename = origResolve;

test('plans router: default export is an Express Router with .get handlers', () => {
  // express Routers are functions with a `stack` property.
  assert.equal(typeof plans, 'function');
  assert.ok(Array.isArray(plans.stack), 'router.stack should be an array');
  // We registered at least two GET handlers (list + by code).
  const gets = plans.stack.filter((layer) =>
    layer.route?.methods?.get,
  );
  assert.ok(gets.length >= 2, `expected at least 2 GET handlers, found ${gets.length}`);
});

test('plans router: admin router exposes POST + PATCH', () => {
  assert.equal(typeof adminRouter, 'function');
  const methods = new Set();
  for (const layer of adminRouter.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) methods.add(m);
  }
  assert.ok(methods.has('post'), 'adminRouter missing POST');
  assert.ok(methods.has('patch'), 'adminRouter missing PATCH');
});

test('CreatePlanSchema: accepts a minimal canonical payload', () => {
  const parse = CreatePlanSchema.safeParse({ code: 'PRO', name: 'Pro' });
  assert.equal(parse.success, true);
});

test('CreatePlanSchema: rejects an unknown plan code', () => {
  const parse = CreatePlanSchema.safeParse({ code: 'SUPER_DUPER', name: 'Bad' });
  assert.equal(parse.success, false);
});

test('CreatePlanSchema: accepts monthlyCredits as a numeric string (BigInt-safe)', () => {
  const parse = CreatePlanSchema.safeParse({
    code: 'ENTERPRISE',
    name: 'Enterprise',
    monthlyCredits: '50000',
  });
  assert.equal(parse.success, true);
});

test('CreatePlanSchema: rejects negative pricing', () => {
  const parse = CreatePlanSchema.safeParse({
    code: 'PRO',
    name: 'Pro',
    priceMonthlyCents: -100,
  });
  assert.equal(parse.success, false);
});

test('UpdatePlanSchema: allows omitting every field (partial)', () => {
  const parse = UpdatePlanSchema.safeParse({});
  assert.equal(parse.success, true);
});

test('serializePlan: stringifies BigInt monthlyCredits for safe JSON transport', () => {
  const out = serializePlan({
    id: 'plan_pro',
    code: 'PRO',
    name: 'Pro',
    description: null,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    currency: 'usd',
    monthlyCredits: BigInt('500'),
    trialDays: 0,
    features: [],
    isActive: true,
    displayOrder: 20,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    createdAt: new Date('2026-05-23T00:00:00Z'),
    updatedAt: new Date('2026-05-23T00:00:00Z'),
  });
  assert.equal(out.monthlyCredits, '500');
  assert.equal(typeof out.monthlyCredits, 'string');
  assert.equal(out.features.length, 0);
});

test('serializePlan: returns null for null input (defensive)', () => {
  assert.equal(serializePlan(null), null);
  assert.equal(serializePlan(undefined), null);
});

test('serializePlan: defaults features to [] when null in DB', () => {
  const out = serializePlan({
    id: 'p',
    code: 'FREE',
    name: 'Free',
    description: null,
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    currency: 'usd',
    monthlyCredits: BigInt('0'),
    trialDays: 0,
    features: null,
    isActive: true,
    displayOrder: 10,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.deepEqual(out.features, []);
});
