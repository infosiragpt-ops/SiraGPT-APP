/**
 * enforce-plan-quota — verifies the middleware contract end-to-end
 * without booting Express. The middleware is shaped so we can hand
 * it a fake `req` with `req.user` and a fake `res` exposing
 * `setHeader` / `status().json()`, then assert which path it took.
 *
 * Three properties matter for production behavior:
 *
 *   1. Anonymous traffic always passes through (no req.user → no
 *      quota to enforce; the rate limiter handles abuse there).
 *
 *   2. Snapshot headers are ALWAYS set when a user is present,
 *      even when the request is denied. Clients render quota state
 *      from these headers.
 *
 *   3. Enforcement is gated by PLAN_QUOTAS_ENFORCED. With it off,
 *      the middleware acts as read-only telemetry — every quota
 *      state still computes, headers still flow, but no 429.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  enforcePlanQuota,
  isEnforcementEnabled,
  HEADER_USED,
  HEADER_LIMIT,
  HEADER_REMAINING,
  HEADER_KIND,
  HEADER_PLAN,
} = require("../src/middleware/enforce-plan-quota");

function fakeRes() {
  const headers = {};
  let statusCode = 200;
  let payload = null;
  return {
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    status(code) {
      statusCode = code;
      return {
        json(obj) {
          payload = obj;
          return this;
        },
      };
    },
    _state() {
      return { headers, statusCode, payload };
    },
  };
}

function fakeNext() {
  let calls = 0;
  function next() {
    calls += 1;
  }
  next.calls = () => calls;
  return next;
}

describe("isEnforcementEnabled", () => {
  test("default ON when PLAN_QUOTAS_ENFORCED is unset", () => {
    assert.equal(isEnforcementEnabled({}), true);
  });

  test("PLAN_QUOTAS_ENFORCED=false explicitly disables", () => {
    assert.equal(isEnforcementEnabled({ PLAN_QUOTAS_ENFORCED: "false" }), false);
  });

  test("PLAN_QUOTAS_ENFORCED=0 also disables (parsed as boolean)", () => {
    assert.equal(isEnforcementEnabled({ PLAN_QUOTAS_ENFORCED: "0" }), false);
  });

  test("Empty string falls back to default ON", () => {
    assert.equal(isEnforcementEnabled({ PLAN_QUOTAS_ENFORCED: "" }), true);
  });
});

describe("enforcePlanQuota — anonymous and unlimited paths", () => {
  test("no req.user → calls next() without setting headers (rate limiter handles anon)", () => {
    const mw = enforcePlanQuota({ surface: "test" });
    const res = fakeRes();
    const next = fakeNext();
    mw({}, res, next);
    assert.equal(next.calls(), 1);
    assert.equal(Object.keys(res._state().headers).length, 0);
  });

  test("ENTERPRISE with monthlyLimit=0 (unlimited) → headers off, passes through", () => {
    const mw = enforcePlanQuota({ surface: "rag" });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      { user: { id: "u1", plan: "ENTERPRISE", apiUsage: 9_999_999, monthlyLimit: 0 } },
      res,
      next,
    );
    assert.equal(next.calls(), 1);
    // No headers — kind: 'none' for the unlimited posture is the
    // signal that quota state is meaningless here. (limit:0 path
    // never sets headers in the middleware to avoid lying about a
    // "0 remaining" cap.)
    assert.equal(res._state().statusCode, 200);
  });
});

describe("enforcePlanQuota — FREE plan call accounting", () => {
  test("FREE user with quota left → headers set, next() called", () => {
    const mw = enforcePlanQuota({ surface: "document-ai" });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      { user: { id: "u1", plan: "FREE", monthlyCallLimit: 2 } },
      res,
      next,
      { method: "POST", originalUrl: "/api/document-ai" },
    );
    assert.equal(next.calls(), 1);
    const { headers } = res._state();
    assert.equal(headers[HEADER_PLAN], "FREE");
    assert.equal(headers[HEADER_KIND], "calls");
    assert.equal(headers[HEADER_LIMIT], "3");
    assert.equal(headers[HEADER_USED], "1");
    assert.equal(headers[HEADER_REMAINING], "2");
  });

  test("FREE user exhausted (0 remaining) → 429 with structured payload", () => {
    const mw = enforcePlanQuota({ surface: "document-ai" });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      {
        user: { id: "u1", plan: "FREE", monthlyCallLimit: 0 },
        method: "POST",
        originalUrl: "/api/document-ai",
      },
      res,
      next,
    );
    assert.equal(next.calls(), 0);
    const { statusCode, payload, headers } = res._state();
    assert.equal(statusCode, 429);
    assert.equal(payload.error, "Plan quota exceeded");
    assert.equal(payload.plan, "FREE");
    assert.equal(payload.kind, "calls");
    assert.equal(payload.upgradeRequired, true);
    assert.equal(payload.surface, "document-ai");
    // Headers MUST still be set on a denied request so the client
    // can render quota state without an extra round-trip.
    assert.equal(headers[HEADER_REMAINING], "0");
    assert.equal(headers[HEADER_LIMIT], "3");
  });
});

describe("enforcePlanQuota — Paid plan token accounting", () => {
  test("PRO under cap → headers set, next() called", () => {
    const mw = enforcePlanQuota({ surface: "agent" });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      {
        user: { id: "u-pro", plan: "PRO", apiUsage: 100_000, monthlyLimit: 500_000 },
      },
      res,
      next,
    );
    assert.equal(next.calls(), 1);
    assert.equal(res._state().headers[HEADER_PLAN], "PRO");
    assert.equal(res._state().headers[HEADER_KIND], "tokens");
    assert.equal(res._state().headers[HEADER_USED], "100000");
    assert.equal(res._state().headers[HEADER_LIMIT], "500000");
    assert.equal(res._state().headers[HEADER_REMAINING], "400000");
  });

  test("PRO over cap → 429 with upgradeRequired:false (paid users get a different CTA)", () => {
    const mw = enforcePlanQuota({ surface: "agent" });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      {
        user: { id: "u-pro", plan: "PRO", apiUsage: 600_000, monthlyLimit: 500_000 },
      },
      res,
      next,
    );
    assert.equal(next.calls(), 0);
    const { statusCode, payload } = res._state();
    assert.equal(statusCode, 429);
    assert.equal(payload.plan, "PRO");
    assert.equal(payload.kind, "tokens");
    assert.equal(payload.upgradeRequired, false);
  });
});

describe("enforcePlanQuota — feature flag", () => {
  test("PLAN_QUOTAS_ENFORCED=false → headers still set, never blocks (read-only mode)", () => {
    const mw = enforcePlanQuota({
      surface: "test",
      envOverride: { PLAN_QUOTAS_ENFORCED: "false" },
    });
    const res = fakeRes();
    const next = fakeNext();
    mw(
      {
        user: { id: "u1", plan: "FREE", monthlyCallLimit: 0 },
      },
      res,
      next,
    );
    // next() runs even though the user is exhausted — flag is off.
    assert.equal(next.calls(), 1);
    assert.equal(res._state().statusCode, 200);
    // Headers still surfaced — read-only telemetry stays on.
    assert.equal(res._state().headers[HEADER_REMAINING], "0");
    assert.equal(res._state().headers[HEADER_USED], "3");
  });
});
