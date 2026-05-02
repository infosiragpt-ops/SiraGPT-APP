/**
 * tryConsumePlanQuota — pins the response shape produced by the
 * extracted function so the seven /api/ai call sites it replaces
 * keep behaving byte-for-byte identically. Two properties matter:
 *
 *   1. The error strings, status codes, and body field order
 *      MATCH the previous inline implementation exactly. A client
 *      that branches off `error === 'Free monthly queries
 *      exhausted. ...'` must keep working.
 *
 *   2. The FREE atomic decrement is performed via Prisma's
 *      `updateMany` with the `monthlyCallLimit: { gt: 0 }` guard.
 *      Concurrent winners get a count:1 result; losers get count:0
 *      and the function MUST return ok:false. We assert the call
 *      shape so a future Prisma upgrade that renames `updateMany`
 *      surfaces here, not in production.
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
  test("atomic decrement succeeds (count:1) → ok:true", async () => {
    const prisma = makePrismaStub({ updateManyResult: { count: 1 } });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.deepEqual(result, { ok: true });
    // Pin the Prisma call shape so a future regression that drops
    // the `gt: 0` guard or the `decrement: 1` op fails here.
    const [args] = prisma._calls();
    assert.deepEqual(args.where, {
      id: "u-free",
      monthlyCallLimit: { gt: 0 },
    });
    assert.deepEqual(args.data, { monthlyCallLimit: { decrement: 1 } });
  });

  test("atomic decrement returns count:0 (exhausted) → 429 with legacy message", async () => {
    const prisma = makePrismaStub({ updateManyResult: { count: 0 } });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    // Exact string. Existing client UI may branch off this — do NOT
    // change the wording without a deliberate frontend coordination.
    assert.equal(
      result.body.error,
      "Free monthly queries exhausted. Please upgrade to continue.",
    );
    assert.equal(result.body.remaining, 0);
  });

  test("Prisma returns null (no row) → 429 with the same legacy message", async () => {
    const prisma = makePrismaStub({ updateManyResult: null });
    const result = await tryConsumePlanQuota({
      userId: "u-free",
      prisma,
      user: { id: "u-free", plan: "FREE" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
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
