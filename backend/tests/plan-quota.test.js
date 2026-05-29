/**
 * plan-quota — pins the snapshot computation that downstream
 * middleware relies on. The function is pure (no DB), so we can
 * exercise every branch with hand-crafted user shapes:
 *
 *   - FREE plan daily call cap
 *   - Paid plans token accounting (apiUsage vs user.monthlyLimit)
 *   - Edge cases that real production data trips on:
 *       * BigInt fields from Prisma
 *       * Stale users with monthlyLimit=0 (no enforcement → warning false)
 *       * Anonymous / null inputs (no-quota snapshot)
 *       * apiUsage > monthlyLimit (clamped to percentage=1)
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getPlanQuotaSnapshot,
  checkPaidTokenCap,
  recordApiUsage,
  FREE_CALL_LIMIT,
  WARNING_THRESHOLD,
} = require("../src/services/plan-quota");

describe("getPlanQuotaSnapshot — anonymous / missing input", () => {
  test("null user → no-quota snapshot, every flag off", () => {
    const snap = getPlanQuotaSnapshot(null);
    assert.equal(snap.plan, null);
    assert.equal(snap.kind, "none");
    assert.equal(snap.used, 0);
    assert.equal(snap.limit, 0);
    assert.equal(snap.remaining, 0);
    assert.equal(snap.percentage, 0);
    assert.equal(snap.exceeded, false);
    assert.equal(snap.warning, false);
  });

  test("user without a plan → no-quota snapshot", () => {
    const snap = getPlanQuotaSnapshot({ id: "u1" });
    assert.equal(snap.kind, "none");
    assert.equal(snap.exceeded, false);
  });
});

describe("getPlanQuotaSnapshot — FREE plan (daily calls)", () => {
  test("FREE user gets a daily calls snapshot", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "FREE",
      monthlyCallLimit: 3,
    });
    assert.equal(snap.plan, "FREE");
    assert.equal(snap.kind, "calls");
    assert.equal(snap.limit, FREE_CALL_LIMIT);
    assert.equal(snap.used, 0);
    assert.equal(snap.remaining, 3);
    assert.equal(snap.percentage, 0);
    assert.equal(snap.exceeded, false);
    assert.equal(snap.warning, false);
    assert.equal(snap.unlimited, false);
  });

  test("FREE daily ApiUsage count drives used/remaining/exceeded", () => {
    const snap = getPlanQuotaSnapshot(
      {
        plan: "FREE",
        monthlyCallLimit: 3,
      },
      { freeDailyCallsUsed: 3 },
    );
    assert.equal(snap.used, 3);
    assert.equal(snap.remaining, 0);
    assert.equal(snap.percentage, 1);
    assert.equal(snap.exceeded, true);
  });
});

describe("getPlanQuotaSnapshot — Paid plans (token-based)", () => {
  test("PRO with 0 / 500000 → 0% used", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "PRO",
      apiUsage: 0,
      monthlyLimit: 500_000,
    });
    assert.equal(snap.kind, "tokens");
    assert.equal(snap.limit, 500_000);
    assert.equal(snap.used, 0);
    assert.equal(snap.percentage, 0);
    assert.equal(snap.exceeded, false);
    assert.equal(snap.warning, false);
  });

  test("PRO at 80% → warning fires, exceeded does not", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "PRO",
      apiUsage: 400_000,
      monthlyLimit: 500_000,
    });
    assert.equal(Math.round(snap.percentage * 100) / 100, 0.8);
    assert.equal(snap.warning, true);
    assert.equal(snap.exceeded, false);
    // The warning threshold lives in the module so consumers can
    // pin to it without hardcoding 0.8 themselves.
    assert.equal(snap.percentage >= WARNING_THRESHOLD, true);
  });

  test("PRO at 100% → exceeded fires, warning does not (mutually exclusive)", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "PRO",
      apiUsage: 500_000,
      monthlyLimit: 500_000,
    });
    assert.equal(snap.percentage, 1);
    assert.equal(snap.exceeded, true);
    assert.equal(snap.warning, false);
  });

  test("PRO at 150% (overrun, e.g. async race) is clamped to percentage=1", () => {
    // Token counters can over-shoot the cap when several async
    // generations land in the same window. The snapshot must clamp
    // so percentage * UI-progress-bar still renders sanely.
    const snap = getPlanQuotaSnapshot({
      plan: "PRO",
      apiUsage: 750_000,
      monthlyLimit: 500_000,
    });
    assert.equal(snap.percentage, 1);
    assert.equal(snap.exceeded, true);
    assert.equal(snap.remaining, 0);
  });

  test("Paid user with monthlyLimit=0 (legacy / unset) → unlimited posture", () => {
    // Staff / unlimited accounts may be stored with limit=0 to mean
    // "no enforcement". We do NOT treat this as exceeded — that would
    // brick those accounts the moment quota enforcement turns on.
    const snap = getPlanQuotaSnapshot({
      plan: "ENTERPRISE",
      apiUsage: 9_999_999,
      monthlyLimit: 0,
    });
    assert.equal(snap.percentage, 0);
    assert.equal(snap.exceeded, false);
    assert.equal(snap.warning, false);
  });

  test("Paid user with BigInt apiUsage and BigInt monthlyLimit is normalized", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "PRO_MAX",
      apiUsage: BigInt(750_000),
      monthlyLimit: BigInt(1_000_000),
    });
    assert.equal(typeof snap.used, "number");
    assert.equal(typeof snap.limit, "number");
    assert.equal(snap.used, 750_000);
    assert.equal(snap.limit, 1_000_000);
    assert.equal(snap.warning, false); // 75% < 80% threshold
  });

  test("Paid user at exactly 80% lands in warning band", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "PRO",
      apiUsage: 800,
      monthlyLimit: 1000,
    });
    assert.equal(snap.percentage, 0.8);
    assert.equal(snap.warning, true);
  });
});

describe("checkPaidTokenCap — paid token cap gate", () => {
  test("null user → ok:true (defensive, never throws)", () => {
    assert.deepEqual(checkPaidTokenCap(null), { ok: true });
    assert.deepEqual(checkPaidTokenCap(undefined), { ok: true });
  });

  test("under cap → ok:true", () => {
    const res = checkPaidTokenCap({ apiUsage: 100, monthlyLimit: 500 });
    assert.deepEqual(res, { ok: true });
  });

  test("at exactly the cap → 429 (>= comparison)", () => {
    const res = checkPaidTokenCap({ apiUsage: 500, monthlyLimit: 500 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "Monthly API limit exceeded");
    assert.deepEqual(res.body.usage, { current: 500, limit: 500 });
  });

  test("over cap → 429 with usage echoing the raw counters", () => {
    const res = checkPaidTokenCap({ apiUsage: 750, monthlyLimit: 500 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.deepEqual(res.body.usage, { current: 750, limit: 500 });
  });

  test("message override is honored (video route keeps its own string)", () => {
    const res = checkPaidTokenCap(
      { apiUsage: 500, monthlyLimit: 500 },
      { message: "Monthly video generation limit exceeded" },
    );
    assert.equal(res.body.error, "Monthly video generation limit exceeded");
  });

  test("BigInt counters are forwarded as-is (bigintSerializer handles JSON)", () => {
    const res = checkPaidTokenCap({
      apiUsage: BigInt(1_000),
      monthlyLimit: BigInt(1_000),
    });
    assert.equal(res.ok, false);
    assert.equal(res.body.usage.current, BigInt(1_000));
    assert.equal(res.body.usage.limit, BigInt(1_000));
  });

  test("missing counters do not throw and do not 429 (matches inline behavior)", () => {
    // The old inline gate did `req.user.apiUsage >= req.user.monthlyLimit`;
    // with undefined fields that comparison is false → request passes.
    assert.deepEqual(checkPaidTokenCap({}), { ok: true });
  });

  test("tryConsumePlanQuota's paid 429 is byte-identical to checkPaidTokenCap", async () => {
    // The two paths must never drift. tryConsumePlanQuota delegates its
    // paid branch to checkPaidTokenCap, so an over-cap paid user yields
    // the same { ok, status, body }.
    const { tryConsumePlanQuota } = require("../src/services/plan-quota");
    const user = { plan: "PRO", apiUsage: 600, monthlyLimit: 500 };
    const viaConsume = await tryConsumePlanQuota({ userId: "u1", prisma: {}, user });
    const viaCap = checkPaidTokenCap(user);
    assert.deepEqual(viaConsume, viaCap);
  });
});

describe("recordApiUsage — usage write + counter increment", () => {
  function makePrismaStub(updatedUser) {
    const calls = [];
    return {
      calls,
      apiUsage: {
        create: async (args) => {
          calls.push(["create", args]);
          return { id: "usage-1", ...args.data };
        },
      },
      user: {
        update: async (args) => {
          calls.push(["update", args]);
          return updatedUser;
        },
      },
    };
  }

  test("writes an ApiUsage row then increments the user counter, returns updatedUser", async () => {
    const updatedUser = { id: "u1", apiUsage: 10_500, monthlyLimit: 100_000 };
    const prisma = makePrismaStub(updatedUser);

    const result = await recordApiUsage({
      prisma,
      userId: "u1",
      model: "dall-e-3",
      tokens: 10_000,
    });

    assert.deepEqual(result, updatedUser);
    // create first, then update — ordering preserved from the inline code.
    assert.deepEqual(prisma.calls.map((c) => c[0]), ["create", "update"]);

    const [, createArgs] = prisma.calls[0];
    assert.deepEqual(createArgs, {
      data: { userId: "u1", model: "dall-e-3", tokens: 10_000, cost: 10 },
    });

    const [, updateArgs] = prisma.calls[1];
    assert.deepEqual(updateArgs, {
      where: { id: "u1" },
      data: { apiUsage: { increment: 10_000 } },
    });
  });

  test("cost is always tokens * 0.001 (the constant every site used)", async () => {
    const prisma = makePrismaStub({ id: "u1", apiUsage: 1, monthlyLimit: 9 });
    await recordApiUsage({ prisma, userId: "u1", model: "veo-3.0", tokens: 1_000 });
    const [, createArgs] = prisma.calls[0];
    assert.equal(createArgs.data.cost, 1);
  });
});
