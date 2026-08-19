/**
 * plan-quota — pins the snapshot computation that downstream
 * middleware relies on. The function is pure (no DB), so we can
 * exercise every branch with hand-crafted user shapes:
 *
 *   - FREE plan call accounting (3-call cap, decrementing counter)
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

describe("getPlanQuotaSnapshot — FREE plan (call-based)", () => {
  test("fresh FREE user with 3 remaining calls → 0% used", () => {
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
  });

  test("FREE user with 1 call remaining → 67% used → warning band", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "FREE",
      monthlyCallLimit: 1,
    });
    assert.equal(snap.used, 2);
    assert.equal(snap.remaining, 1);
    // 2/3 = 0.6667; warning fires at >= 0.8
    assert.equal(snap.warning, false);
    assert.equal(snap.exceeded, false);
  });

  test("FREE user with 0 calls remaining → 100% used → exceeded, no warning", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "FREE",
      monthlyCallLimit: 0,
    });
    assert.equal(snap.used, 3);
    assert.equal(snap.remaining, 0);
    assert.equal(snap.percentage, 1);
    assert.equal(snap.exceeded, true);
    assert.equal(snap.warning, false); // mutually exclusive with exceeded
  });

  test("FREE user reading BigInt from Prisma is normalized to number", () => {
    const snap = getPlanQuotaSnapshot({
      plan: "FREE",
      monthlyCallLimit: BigInt(2),
    });
    assert.equal(typeof snap.remaining, "number");
    assert.equal(snap.remaining, 2);
    assert.equal(snap.used, 1);
  });

  test("FREE user with negative remaining is clamped to 0 (defensive)", () => {
    // Race conditions in atomic decrement could surface a negative
    // value briefly. The snapshot must not produce negative numbers
    // that downstream UI rendering would choke on.
    const snap = getPlanQuotaSnapshot({
      plan: "FREE",
      monthlyCallLimit: -1,
    });
    assert.equal(snap.remaining, 0);
    assert.equal(snap.used, 3);
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
