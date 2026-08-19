import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  constantTimeHexEqual,
  createNonceCache,
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

  // ── ratchet 45 task 2: v2 algorithm ───────────────────────────────
  it("accepts a v2-only signature (HMAC over `v2:${t}.${body}`)", () => {
    const secret = "whsec_test_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const body = "hello-v2";
    const ts = Math.floor(Date.now() / 1000);
    const v2 = createHmac("sha256", secret).update(`v2:${ts}.${body}`).digest("hex");
    const header = `t=${ts},v2=${v2}`;
    assert.equal(verifyHmacSignature(body, header, secret), true);
  });

  it("accepts the dual `v1=..,v2=..` header emitted during transition", () => {
    const secret = "whsec_test_dual_bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const body = "dual-body";
    const ts = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const v2 = createHmac("sha256", secret).update(`v2:${ts}.${body}`).digest("hex");
    const header = `t=${ts},v1=${v1},v2=${v2}`;
    assert.equal(verifyHmacSignature(body, header, secret), true);
  });

  it("rejects a v1 digest placed in the v2 slot (domain separation)", () => {
    const secret = "whsec_test_sep_cccccccccccccccccccccccccccc";
    const body = "x";
    const ts = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    // Replay v1 digest into the v2 segment (no v1 segment at all).
    const header = `t=${ts},v2=${v1}`;
    assert.equal(verifyHmacSignature(body, header, secret), false);
  });

  // ── ratchet 45 task 2: per-delivery nonce + replay LRU ────────────
  it("accepts a v2 signature bound to an n= nonce segment", () => {
    const secret = "whsec_test_nonce_aaaaaaaaaaaaaaaaaaaaaaaa";
    const body = "nonce-body";
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "deadbeefcafebabedeadbeefcafebabe";
    const v2 = createHmac("sha256", secret).update(`v2:${ts}.${nonce}.${body}`).digest("hex");
    const header = `t=${ts},n=${nonce},v2=${v2}`;
    assert.equal(verifyHmacSignature(body, header, secret), true);
  });

  it("rejects a replayed nonce within the tolerance window when a cache is passed", () => {
    const secret = "whsec_test_replay_bbbbbbbbbbbbbbbbbbbbbbbb";
    const body = "replay-body";
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "11112222333344445555666677778888";
    const v2 = createHmac("sha256", secret).update(`v2:${ts}.${nonce}.${body}`).digest("hex");
    const header = `t=${ts},n=${nonce},v2=${v2}`;
    const cache = createNonceCache();
    assert.equal(verifyHmacSignature(body, header, secret, { nonceCache: cache }), true);
    assert.equal(verifyHmacSignature(body, header, secret, { nonceCache: cache }), false);
    // Without a cache, the same header still verifies — replay protection is opt-in.
    assert.equal(verifyHmacSignature(body, header, secret), true);
  });

  it("rejects v2 when nonce is tampered (signature mismatch)", () => {
    const secret = "whsec_test_tamper_cccccccccccccccccccccccc";
    const body = "x";
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const v2 = createHmac("sha256", secret).update(`v2:${ts}.${nonce}.${body}`).digest("hex");
    // Swap the nonce in the header but keep the original digest.
    const header = `t=${ts},n=${"b".repeat(32)},v2=${v2}`;
    assert.equal(verifyHmacSignature(body, header, secret), false);
  });

  it("parseSignatureHeader extracts the n= segment", () => {
    const parsed = parseSignatureHeader("t=42,n=abc123,v1=ff,v2=ee");
    assert.equal(parsed.timestamp, 42);
    assert.equal(parsed.nonce, "abc123");
    assert.equal(parsed.v1, "ff");
    assert.equal(parsed.v2, "ee");
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
