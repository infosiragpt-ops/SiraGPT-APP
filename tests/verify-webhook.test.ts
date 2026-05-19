import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  constantTimeHexEqual,
  parseSignatureHeader,
  verifyHmacSignature,
} from "../lib/integrations/verify-webhook";

function sign(secret: string, body: string, timestamp: number): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("verifyHmacSignature (consumer-side SiraGPT webhook verifier)", () => {
  it("accepts a freshly signed body under the matching secret", () => {
    const body = JSON.stringify({ event: "task.completed", id: "task_123" });
    const secret = "whsec_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(secret, body, ts);

    assert.equal(verifyHmacSignature(body, header, secret), true);
  });

  it("rejects a tampered body (signature mismatch is constant-time)", () => {
    const secret = "whsec_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(secret, "original", ts);

    // Body mutated after signing — must not verify.
    assert.equal(verifyHmacSignature("tampered", header, secret), false);
    // Wrong secret on the consumer side — must not verify either.
    assert.equal(verifyHmacSignature("original", header, "wrong_secret"), false);
  });

  it("rejects signatures outside the tolerance window", () => {
    const secret = "whsec_test_cccccccccccccccccccccccccccccccc";
    const body = "hello";
    const now = 1_700_000_000_000; // fixed clock (ms)
    const fresh = sign(secret, body, Math.floor(now / 1000));
    const stale = sign(secret, body, Math.floor(now / 1000) - 10 * 60); // 10 min old

    assert.equal(
      verifyHmacSignature(body, fresh, secret, { now: () => now }),
      true,
    );
    assert.equal(
      verifyHmacSignature(body, stale, secret, { now: () => now, toleranceSeconds: 300 }),
      false,
    );
    // Custom (wider) tolerance accepts the same stale header.
    assert.equal(
      verifyHmacSignature(body, stale, secret, { now: () => now, toleranceSeconds: 60 * 60 }),
      true,
    );
  });

  it("handles malformed inputs without throwing", () => {
    assert.equal(verifyHmacSignature("body", null, "secret"), false);
    assert.equal(verifyHmacSignature("body", "garbage-header", "secret"), false);
    assert.equal(verifyHmacSignature("body", "t=abc,v1=xyz", "secret"), false);
    assert.equal(verifyHmacSignature(null, "t=1,v1=aa", "secret"), false);
    assert.equal(verifyHmacSignature("body", "t=1,v1=aa", ""), false);

    // parseSignatureHeader contract: tolerant of whitespace and order.
    const parsed = parseSignatureHeader(" v1=deadbeef ,  t=42 ");
    assert.equal(parsed.timestamp, 42);
    assert.equal(parsed.v1, "deadbeef");
  });

  it("verifies bodies passed as Buffer (raw bytes) identically to strings", () => {
    const secret = "whsec_test_dddddddddddddddddddddddddddddddd";
    const body = Buffer.from("✓ unicode body", "utf8");
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(secret, body.toString("utf8"), ts);

    assert.equal(verifyHmacSignature(body, header, secret), true);
    // constantTimeHexEqual smoke check: equal-length hex must match,
    // mismatched length / non-hex inputs must reject without throwing.
    assert.equal(constantTimeHexEqual("deadbeef", "deadbeef"), true);
    assert.equal(constantTimeHexEqual("deadbeef", "deadbeee"), false);
    assert.equal(constantTimeHexEqual("deadbeef", "deadbe"), false);
    assert.equal(constantTimeHexEqual("zzzz", "zzzz"), false);
  });
});
