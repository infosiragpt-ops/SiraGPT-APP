/**
 * tryConsumePlanQuota — pins the response shape produced by the
 * extracted function so the seven /api/ai call sites it replaces
 * keep behaving byte-for-byte identically. Two properties matter:
 *
 *   1. FREE users get 3 successful calls per local day.
 *
 *   2. Paid users still use the token cap check unchanged.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  tryConsumePlanQuota,
} = require("../src/services/plan-quota");

function makePrismaStub(opts = {}) {
  const calls = [];
  const apiUsageCalls = [];
  // Use `in` instead of `??` so `null` is a valid distinct value the
  // test can assert on (Prisma's typed client returns null when no
  // row matches a strict where clause; we want to model that).
  const hasResult = "updateManyResult" in opts;
  const updateManyResult = hasResult ? opts.updateManyResult : { count: 1 };
  const countResult = "apiUsageCount" in opts ? opts.apiUsageCount : 0;
  return {
    user: {
      async updateMany(args) {
        calls.push(args);
        return updateManyResult;
      },
    },
    apiUsage: {
      async count(args) {
        apiUsageCalls.push(args);
        return countResult;
      },
    },
    _calls: () => calls,
    _apiUsageCalls: () => apiUsageCalls,
  };
}

describe("tryConsumePlanQuota — anonymous", () => {
  test("no user → ok:true, no DB call", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({ userId: null, prisma, user: null });
    assert.deepEqual(result, { ok: true });
    assert.equal(prisma._calls().length, 0);
  });

  test("missing parameters object → ok:true (defensive, never throws)", async () => {
    const result = await tryConsumePlanQuota();
    assert.deepEqual(result, { ok: true });
  });
});

describe("tryConsumePlanQuota — FREE plan", () => {
  test("FREE user under daily cap → ok:true, counts today's usage", async () => {
    const prisma = makePrismaStub({ apiUsageCount: 2 });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.deepEqual(result, { ok: true, remaining: 1, dailyLimit: 3 });
    assert.equal(prisma._calls().length, 0);
    assert.equal(prisma._apiUsageCalls().length, 1);
    assert.equal(prisma._apiUsageCalls()[0].where.userId, "u-free");
    assert.ok(prisma._apiUsageCalls()[0].where.timestamp.gte instanceof Date);
    assert.ok(prisma._apiUsageCalls()[0].where.timestamp.lt instanceof Date);
  });

  test("FREE user at daily cap → 429 daily exhaustion", async () => {
    const prisma = makePrismaStub({ apiUsageCount: 3 });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "Free daily queries exhausted. Please upgrade to continue.");
    assert.equal(result.body.remaining, 0);
    assert.equal(result.body.dailyLimit, 3);
    assert.equal(result.body.usedToday, 3);
    assert.equal(result.body.upgradeRequired, true);
  });
});

describe("tryConsumePlanQuota — superAdmin bypass", () => {
  test("superAdmin on FREE plan → ok:true unlimited, NO daily-count DB read", async () => {
    // apiUsageCount:99 is well past the 3/day cap — a superAdmin must
    // still sail through, and the count() query must never run.
    const prisma = makePrismaStub({ apiUsageCount: 99 });
    const result = await tryConsumePlanQuota({
      userId: "admin",
      prisma,
      user: { id: "admin", plan: "FREE", isSuperAdmin: true },
    });
    assert.deepEqual(result, { ok: true, unlimited: true, bypass: "superadmin" });
    assert.equal(prisma._apiUsageCalls().length, 0);
    assert.equal(prisma._calls().length, 0);
  });

  test("superAdmin on a paid plan over the token cap → still ok:true", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "admin",
      prisma,
      user: { id: "admin", plan: "PRO", isSuperAdmin: true, apiUsage: 5000, monthlyLimit: 1000 },
    });
    assert.deepEqual(result, { ok: true, unlimited: true, bypass: "superadmin" });
  });
});

describe("tryConsumePlanQuota — FREE attachment exemption", () => {
  test("FREE turn WITH attachment → ok:true exempt, never blocked, NO daily-count DB read", async () => {
    // apiUsageCount:99 is far past the 3/day text cap — an attachment turn
    // must still pass, and the count() query must never run (it's exempt).
    const prisma = makePrismaStub({ apiUsageCount: 99 });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
      hasAttachments: true,
    });
    assert.deepEqual(result, { ok: true, exempt: "attachment", dailyLimit: 3 });
    assert.equal(prisma._apiUsageCalls().length, 0);
  });

  test("FREE text-only turn (hasAttachments:false) still gated at the cap", async () => {
    const prisma = makePrismaStub({ apiUsageCount: 3 });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
      hasAttachments: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "Free daily queries exhausted. Please upgrade to continue.");
  });

  test("default (no hasAttachments arg) preserves the text-only gating", async () => {
    const prisma = makePrismaStub({ apiUsageCount: 3 });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
  });

  test("attachment flag does NOT exempt a paid plan from its token cap", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "u-pro",
      prisma,
      user: { id: "u-pro", plan: "PRO", apiUsage: 1000, monthlyLimit: 1000 },
      hasAttachments: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "Monthly API limit exceeded");
  });
});

describe("tryConsumePlanQuota — paid plans", () => {
  test("PRO under cap → ok:true, NO DB call (read-only check)", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "u-pro",
      prisma,
      user: { id: "u-pro", plan: "PRO", apiUsage: 100, monthlyLimit: 1000 },
    });
    assert.deepEqual(result, { ok: true });
    // Paid users do NOT touch the DB on the quota check — usage is
    // incremented later, after the LLM call succeeds.
    assert.equal(prisma._calls().length, 0);
  });

  test("PRO at exactly the cap → 429 (>= comparison)", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "u-pro",
      prisma,
      user: { id: "u-pro", plan: "PRO", apiUsage: 1000, monthlyLimit: 1000 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "Monthly API limit exceeded");
    // Body forwards the BigInt-ish values verbatim — the existing
    // bigintSerializerMiddleware handles JSON serialization.
    assert.equal(result.body.usage.current, 1000);
    assert.equal(result.body.usage.limit, 1000);
  });

  test("PRO over cap → 429 with usage in body", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "u-pro",
      prisma,
      user: { id: "u-pro", plan: "PRO", apiUsage: 5000, monthlyLimit: 1000 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "Monthly API limit exceeded");
    assert.equal(result.body.usage.current, 5000);
    assert.equal(result.body.usage.limit, 1000);
  });

  test("ENTERPRISE with BigInt counters works the same way", async () => {
    const prisma = makePrismaStub();
    const result = await tryConsumePlanQuota({
      userId: "u-ent",
      prisma,
      user: {
        id: "u-ent",
        plan: "ENTERPRISE",
        apiUsage: BigInt(50),
        monthlyLimit: BigInt(100),
      },
    });
    assert.deepEqual(result, { ok: true });
  });
});
