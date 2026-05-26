/**
 * tryConsumePlanQuota — pins the response shape produced by the
 * extracted function so the seven /api/ai call sites it replaces
 * keep behaving byte-for-byte identically. Two properties matter:
 *
 *   1. FREE users are no longer blocked after 3 text calls.
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
  // Use `in` instead of `??` so `null` is a valid distinct value the
  // test can assert on (Prisma's typed client returns null when no
  // row matches a strict where clause; we want to model that).
  const hasResult = "updateManyResult" in opts;
  const updateManyResult = hasResult ? opts.updateManyResult : { count: 1 };
  return {
    user: {
      async updateMany(args) {
        calls.push(args);
        return updateManyResult;
      },
    },
    _calls: () => calls,
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
  test("FREE user → ok:true unlimited, no DB decrement", async () => {
    const prisma = makePrismaStub({ updateManyResult: { count: 1 } });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.deepEqual(result, { ok: true, unlimited: true });
    assert.equal(prisma._calls().length, 0);
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
