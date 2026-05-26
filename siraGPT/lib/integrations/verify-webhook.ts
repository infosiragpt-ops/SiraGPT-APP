// Consumer-side webhook signature verifier for SiraGPT outbound events.
//
// SiraGPT signs every outbound webhook with HMAC-SHA256 over the raw
// request body and ships the result in the `X-SiraGPT-Signature`
// header using the canonical Stripe-style format:
//
//   X-SiraGPT-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>[,v2=<hex-hmac-sha256>]
//
// Ratchet 45 (Task 2) added an additional `v2=` segment for forwards
// compatibility. v2 is HMAC-SHA256 over `v2:${timestamp}.${body}` (a
// domain-separated variant of v1 that cannot be spoofed by replaying
// a v1 digest as v2). During the transition window the backend emits
// BOTH segments and this verifier accepts a payload as valid if EITHER
// segment verifies. New integrations should bind to v2; existing
// integrations on v1 keep working until v1 is retired in a future
// cycle.
//
// This module gives downstream consumers a single drop-in helper to
// verify those events without taking a runtime dependency on the
// backend code path that signs them (`backend/src/services/webhook-
// dispatcher.js`). It exposes pure, tree-shake-friendly functions and
// no I/O.
//
//   import { verifyHmacSignature } from "@siragpt/sdk/verify-webhook";
//
//   const ok = verifyHmacSignature(rawBody, req.headers["x-siragpt-signature"], secret);
//   if (!ok) return new Response("invalid signature", { status: 401 });
//
// Notes:
//   - `rawBody` MUST be the exact bytes you received on the wire — do
//     not re-serialize a parsed JSON object, since key order or
//     whitespace changes will break the signature.
//   - `secret` is the shared HMAC key you configured when creating
//     the webhook endpoint in the SiraGPT admin dashboard.
//   - Verification is constant-time: the comparison runs over the
//     full digest regardless of where the first mismatching byte
//     occurs, so it does not leak timing information about the
//     expected signature.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Replay-protection nonce cache contract.
 *
 * Ratchet 45 (Task 2) introduced a per-delivery 128-bit nonce emitted
 * as an `n=<hex>` segment of the signature header. Timestamp tolerance
 * alone leaves a window where an attacker can replay an intercepted
 * request unchanged; binding a nonce into the v2 base string AND
 * remembering recently-seen nonces in an LRU closes that gap.
 *
 * Implementations should return `true` when the nonce has already been
 * seen within the tolerance window (the consumer should reject the
 * request as a replay) and `false` after recording a fresh nonce.
 */
export interface NonceCache {
  seenOrRemember(nonce: string, timestampSeconds: number, toleranceSeconds: number): boolean;
}

export interface VerifyOptions {
  /** Reject signatures whose `t=` timestamp is older than this many seconds. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** Override `Date.now()` for deterministic testing (returns ms since epoch). */
  now?: () => number;
  /** Optional replay cache. When provided, repeated nonces within the tolerance window are rejected. */
  nonceCache?: NonceCache;
}

export interface ParsedSignatureHeader {
  /** Unix-seconds timestamp from the `t=` segment, or null when missing/invalid. */
  timestamp: number | null;
  /** Random per-delivery nonce from the `n=` segment (ratchet 45 Task 2), or null when missing. */
  nonce: string | null;
  /** Hex digest from the `v1=` segment, or null when missing. */
  v1: string | null;
  /** Hex digest from the `v2=` segment (ratchet 45 Task 2), or null when missing. */
  v2: string | null;
}

/**
 * Parse a SiraGPT `X-SiraGPT-Signature` header value.
 * Tolerant of surrounding whitespace and segment order.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignatureHeader {
  const out: ParsedSignatureHeader = { timestamp: null, nonce: null, v1: null, v2: null };
  if (!header || typeof header !== "string") return out;
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number(v);
      if (Number.isFinite(n)) out.timestamp = n;
    } else if (k === "n") {
      out.nonce = v;
    } else if (k === "v1") {
      out.v1 = v;
    } else if (k === "v2") {
      out.v2 = v;
    }
  }
  return out;
}

/**
 * Create an in-memory LRU nonce cache suitable for single-process
 * consumers. For multi-process / multi-host consumers, back the cache
 * with Redis (the contract is intentionally tiny: one method).
 *
 * Capacity is bounded; the oldest entries are evicted on overflow.
 * Entries auto-expire once `t + toleranceSeconds` has passed so the
 * cache size scales with the tolerance window, not lifetime traffic.
 */
export function createNonceCache(options: { maxSize?: number } = {}): NonceCache & { size(): number; clear(): void } {
  const maxSize = options.maxSize && options.maxSize > 0 ? options.maxSize : 4096;
  // Map<nonce → insertion-time-ms>. We evict by insertion-age rather
  // than the signed timestamp so the cache is robust to clients that
  // sign with fixed historical timestamps (e.g. tests, frozen clocks).
  const store = new Map<string, number>();
  return {
    seenOrRemember(nonce, timestampSeconds, toleranceSeconds): boolean {
      if (!nonce) return false;
      const nowMs = Date.now();
      const tolMs = (toleranceSeconds || 300) * 1000;
      for (const [k, insertedAt] of store) {
        if (nowMs - insertedAt > tolMs) store.delete(k);
        else break;
      }
      if (store.has(nonce)) {
        const ins = store.get(nonce) as number;
        store.delete(nonce);
        store.set(nonce, ins);
        return true;
      }
      store.set(nonce, nowMs);
      if (store.size > maxSize) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      // `timestampSeconds` retained for future per-entry pruning.
      void timestampSeconds;
      return false;
    },
    size(): number { return store.size; },
    clear(): void { store.clear(); },
  };
}

/**
 * Constant-time hex comparison. Returns false (rather than throwing)
 * on any input that cannot be safely compared (length mismatch,
 * non-hex characters, null/undefined). The actual byte comparison
 * always runs over the full buffer once both inputs validate.
 */
export function constantTimeHexEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length !== b.length) return false;
  // Strict hex check — `Buffer.from(_, "hex")` will silently truncate
  // on the first invalid pair, so guard up front.
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a SiraGPT-signed webhook payload.
 *
 * @param body    Raw request body as received on the wire. Strings are
 *                hashed as UTF-8; Buffers are hashed as-is.
 * @param header  Value of the `X-SiraGPT-Signature` header.
 * @param secret  Shared HMAC secret (the value shown once when you
 *                created the endpoint).
 * @param opts    Optional tolerance window + clock override.
 * @returns       true iff the signature is structurally valid, matches
 *                the body+timestamp under the secret, and the
 *                timestamp falls inside the tolerance window.
 */
export function verifyHmacSignature(
  body: string | Buffer | null | undefined,
  header: string | null | undefined,
  secret: string | null | undefined,
  opts: VerifyOptions = {},
): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (body == null) return false;

  const parsed = parseSignatureHeader(header);
  if (parsed.timestamp == null) return false;
  // Need at least one digest segment to verify against.
  if (parsed.v1 == null && parsed.v2 == null) return false;

  const toleranceSeconds = Number.isFinite(opts.toleranceSeconds as number)
    ? Math.max(0, Math.floor(opts.toleranceSeconds as number))
    : 300;
  const nowMs = typeof opts.now === "function" ? opts.now() : Date.now();
  const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (skewSeconds > toleranceSeconds) return false;

  const bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  // v1 base: `${t}.${body}`. v2 base: when a per-delivery nonce is
  // present, `v2:${t}.${n}.${body}` (ratchet 45 Task 2); otherwise the
  // legacy unbound form `v2:${t}.${body}` so headers signed by older
  // backends keep verifying during the rollout window.
  let matched = false;
  if (parsed.v1 != null) {
    const exp = createHmac("sha256", secret)
      .update(`${parsed.timestamp}.${bodyStr}`)
      .digest("hex");
    if (constantTimeHexEqual(exp, parsed.v1)) matched = true;
  }
  if (parsed.v2 != null) {
    const base = parsed.nonce
      ? `v2:${parsed.timestamp}.${parsed.nonce}.${bodyStr}`
      : `v2:${parsed.timestamp}.${bodyStr}`;
    const exp = createHmac("sha256", secret).update(base).digest("hex");
    if (constantTimeHexEqual(exp, parsed.v2)) matched = true;
  }
  if (!matched) return false;
  // Replay protection: opt-in via opts.nonceCache. Same nonce inside
  // the tolerance window → reject.
  if (parsed.nonce && opts.nonceCache) {
    if (opts.nonceCache.seenOrRemember(parsed.nonce, parsed.timestamp, toleranceSeconds)) return false;
  }
  return true;
}
