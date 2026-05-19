// Consumer-side webhook signature verifier for SiraGPT outbound events.
//
// SiraGPT signs every outbound webhook with HMAC-SHA256 over the raw
// request body and ships the result in the `X-SiraGPT-Signature`
// header using the canonical Stripe-style format:
//
//   X-SiraGPT-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
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

export interface VerifyOptions {
  /** Reject signatures whose `t=` timestamp is older than this many seconds. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** Override `Date.now()` for deterministic testing (returns ms since epoch). */
  now?: () => number;
}

export interface ParsedSignatureHeader {
  /** Unix-seconds timestamp from the `t=` segment, or null when missing/invalid. */
  timestamp: number | null;
  /** Hex digest from the `v1=` segment, or null when missing. */
  v1: string | null;
}

/**
 * Parse a SiraGPT `X-SiraGPT-Signature` header value.
 * Tolerant of surrounding whitespace and segment order.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignatureHeader {
  const out: ParsedSignatureHeader = { timestamp: null, v1: null };
  if (!header || typeof header !== "string") return out;
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number(v);
      if (Number.isFinite(n)) out.timestamp = n;
    } else if (k === "v1") {
      out.v1 = v;
    }
  }
  return out;
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
  if (parsed.timestamp == null || parsed.v1 == null) return false;

  const toleranceSeconds = Number.isFinite(opts.toleranceSeconds as number)
    ? Math.max(0, Math.floor(opts.toleranceSeconds as number))
    : 300;
  const nowMs = typeof opts.now === "function" ? opts.now() : Date.now();
  const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (skewSeconds > toleranceSeconds) return false;

  const bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  const base = `${parsed.timestamp}.${bodyStr}`;
  const expected = createHmac("sha256", secret).update(base).digest("hex");

  return constantTimeHexEqual(expected, parsed.v1);
}
