/**
 * jwt-aware-rate-limit-key — pins the bucketing rule used by every
 * tier of the rate limiter. Two properties are load-bearing for
 * production behavior:
 *
 *   1. Authenticated requests bucket by user-id, NOT by IP. This is
 *      the entire reason the helper exists; without it, PRO users
 *      behind a shared NAT collapse into one IP quota.
 *
 *   2. Forged / expired / wrong-secret tokens fall through to IP
 *      bucketing — they are NEVER allowed to pin abuse to a victim's
 *      bucket. We verify the signature here, not in the test alone.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const {
  makeJwtAwareKeyGenerator,
  extractBearerToken,
} = require("../src/middleware/rate-limit-policy");

const SECRET = "test-jwt-secret-1";
const OTHER_SECRET = "test-jwt-secret-2";

function fakeReq({ authorization, cookieToken, ip = "203.0.113.7" } = {}) {
  return {
    ip,
    headers: authorization ? { authorization } : {},
    cookies: cookieToken ? { token: cookieToken } : {},
  };
}

describe("extractBearerToken", () => {
  test("pulls token from a `Bearer <token>` Authorization header", () => {
    const token = extractBearerToken(fakeReq({ authorization: "Bearer abc.def.ghi" }));
    assert.equal(token, "abc.def.ghi");
  });

  test("ignores non-Bearer schemes", () => {
    assert.equal(extractBearerToken(fakeReq({ authorization: "Basic abc" })), null);
  });

  test("falls back to the `token` cookie when no Authorization header", () => {
    assert.equal(extractBearerToken(fakeReq({ cookieToken: "from-cookie" })), "from-cookie");
  });

  test("returns null when neither source is present", () => {
    assert.equal(extractBearerToken(fakeReq()), null);
  });

  test("is defensive against missing req / headers", () => {
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken({}), null);
  });
});

describe("makeJwtAwareKeyGenerator — happy paths", () => {
  test("buckets by `user:<userId>` when JWT carries `userId`", () => {
    const token = jwt.sign({ userId: "u-42" }, SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${token}` }),
    );
    assert.equal(key, "user:u-42");
  });

  test("falls back to the `id` claim when `userId` is absent", () => {
    const token = jwt.sign({ id: "u-id-claim" }, SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${token}` }),
    );
    assert.equal(key, "user:u-id-claim");
  });

  test("falls back to the `sub` claim when `userId` and `id` are absent", () => {
    const token = jwt.sign({ sub: "u-sub-claim" }, SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${token}` }),
    );
    assert.equal(key, "user:u-sub-claim");
  });

  test("recognizes tokens carried in the cookie just like the auth middleware does", () => {
    const token = jwt.sign({ userId: "u-cookie" }, SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(fakeReq({ cookieToken: token }));
    assert.equal(key, "user:u-cookie");
  });
});

describe("makeJwtAwareKeyGenerator — IP fallback", () => {
  test("anonymous request → ip:<ip>", () => {
    const key = makeJwtAwareKeyGenerator(SECRET)(fakeReq({ ip: "203.0.113.9" }));
    assert.equal(key, "ip:203.0.113.9");
  });

  test("forged token (wrong signature) → ip:<ip>, NEVER user:<victim>", () => {
    // Sign with a DIFFERENT secret. If verify lets this through, an
    // attacker could pin abuse to any victim's bucket.
    const forged = jwt.sign({ userId: "victim-123" }, OTHER_SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${forged}`, ip: "198.51.100.5" }),
    );
    assert.equal(key, "ip:198.51.100.5");
  });

  test("expired token → ip:<ip>", () => {
    const expired = jwt.sign({ userId: "u-old" }, SECRET, { expiresIn: -10 });
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${expired}`, ip: "198.51.100.6" }),
    );
    assert.equal(key, "ip:198.51.100.6");
  });

  test("malformed token (random string) → ip:<ip>", () => {
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: "Bearer not-a-real-jwt", ip: "198.51.100.7" }),
    );
    assert.equal(key, "ip:198.51.100.7");
  });

  test("missing JWT_SECRET → degrades gracefully to ip-only bucketing (does not crash)", () => {
    const token = jwt.sign({ userId: "u-x" }, SECRET);
    // Misconfigured deploy: no secret available.
    const key = makeJwtAwareKeyGenerator("")(
      fakeReq({ authorization: `Bearer ${token}`, ip: "198.51.100.8" }),
    );
    assert.equal(key, "ip:198.51.100.8");
  });

  test("token verifies but carries no recognizable user-id claim → ip:<ip>", () => {
    const token = jwt.sign({ unrelated: "field" }, SECRET);
    const key = makeJwtAwareKeyGenerator(SECRET)(
      fakeReq({ authorization: `Bearer ${token}`, ip: "198.51.100.9" }),
    );
    assert.equal(key, "ip:198.51.100.9");
  });

  test("missing req.ip → ip:unknown (rather than crashing)", () => {
    const key = makeJwtAwareKeyGenerator(SECRET)({ headers: {}, cookies: {} });
    assert.equal(key, "ip:unknown");
  });
});
