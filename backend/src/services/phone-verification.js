'use strict';

/**
 * Phone verification lifecycle (ratchet 45, Task 1).
 *
 * Pure helpers around the `PhoneVerification` Prisma model so the
 * user-routes (`PUT /api/users/me/phone` + `POST /api/users/me/phone/verify`)
 * stay slim. Codes are 6 random digits, short-lived (10min by default —
 * override with `PHONE_VERIFICATION_TTL_MS`), stored as bcrypt hashes,
 * single-use (`consumedAt`), and capped at MAX_VERIFY_ATTEMPTS=5 attempts
 * per row. We deliberately do NOT log the plaintext code.
 *
 * Resend cap is enforced at the route layer via the shared
 * rate-limit-store (`consume()`), 1/min per user.
 *
 * SMS delivery reuses Twilio config from `sms-delivery.js` (TWILIO_*
 * env). When Twilio is not configured we still mint + persist the row
 * but flag the response so dev/test environments can read the code
 * out-of-band.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const BCRYPT_COST = 8; // Lower than password hash — codes are 6 digits + TTL'd
// E.164: leading '+', 8-15 digits total (we already accept the leading
// '+' and 8-15 digits after it). Permissive enough to cover global
// numbers without being a regex Borges.
const E164_RE = /^\+[1-9]\d{7,14}$/;

function ttlMs() {
  const raw = Number(process.env.PHONE_VERIFICATION_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

/** Returns true when `phone` is a plausible E.164 string. */
function isValidPhone(phone) {
  return typeof phone === 'string' && E164_RE.test(phone);
}

/** Returns true when `code` is exactly 6 ASCII digits. */
function isValidCode(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

/**
 * Generates a 6-digit OTP using crypto.randomInt so the distribution
 * is uniform (Math.random can introduce modulo bias on small ranges).
 * Returns the code zero-padded to 6 chars.
 */
function mintCode() {
  const n = crypto.randomInt(0, 1_000_000); // [0, 999999]
  return String(n).padStart(6, '0');
}

async function hashCode(code) {
  return bcrypt.hash(code, BCRYPT_COST);
}

async function compareCode(code, hash) {
  if (!code || !hash) return false;
  try { return await bcrypt.compare(code, hash); }
  catch { return false; }
}

/**
 * Best-effort SMS send via Twilio. Mirrors the graceful-degradation
 * contract in `sms-delivery.js`: any missing env / package / config is a
 * `skipped` result, never a thrown error. Returns
 * `{ sent: boolean, reason?: string }`.
 */
async function sendSms(phone, code, opts = {}) {
  const logger = opts.logger || console;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return { sent: false, reason: 'no-twilio-env' };
  }
  const from = process.env.TWILIO_FROM_NUMBER || null;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  if (!from && !messagingServiceSid) {
    return { sent: false, reason: 'no-twilio-sender' };
  }
  let twilioMod = opts.twilio;
  if (!twilioMod) {
    try { twilioMod = require('twilio'); }
    catch (err) {
      logger?.info?.(`[phone-verification] twilio not installed (${err?.message || err})`);
      return { sent: false, reason: 'no-twilio-lib' };
    }
  }
  let client;
  try {
    client = opts.client || (typeof twilioMod === 'function'
      ? twilioMod(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      : twilioMod.default?.(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));
  } catch (err) {
    logger?.warn?.(`[phone-verification] twilio init failed: ${err?.message || err}`);
    return { sent: false, reason: 'twilio-init-failed' };
  }
  if (!client?.messages?.create) {
    return { sent: false, reason: 'no-twilio-client' };
  }
  const body = `Your siraGPT verification code is ${code}. It expires in 10 minutes.`;
  const payload = messagingServiceSid
    ? { to: phone, body, messagingServiceSid }
    : { to: phone, body, from };
  try {
    await client.messages.create(payload);
    return { sent: true };
  } catch (err) {
    logger?.warn?.(`[phone-verification] sms send failed: ${err?.message || err}`);
    return { sent: false, reason: 'send-failed' };
  }
}

/**
 * Mint a new code for `userId`+`phone`. Invalidates any prior
 * unconsumed rows for the user (single active challenge at a time) and
 * returns `{ row, code, expiresAt }`. The caller is responsible for
 * actually sending the SMS so this helper stays unit-testable.
 */
async function createPhoneChallenge(prisma, userId, phone) {
  if (!prisma?.phoneVerification) {
    throw new Error('prisma.phoneVerification model unavailable');
  }
  if (!isValidPhone(phone)) {
    const err = new Error('invalid_phone');
    err.code = 'invalid_phone';
    throw err;
  }
  const code = mintCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + ttlMs());

  // Best-effort invalidation of any prior unconsumed rows so a user
  // can't pile up open challenges. We mark them consumed (rather than
  // delete) so audit / forensic queries can still see the history.
  try {
    await prisma.phoneVerification.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  } catch { /* best-effort */ }

  const row = await prisma.phoneVerification.create({
    data: { userId, phone, codeHash, expiresAt },
  });
  return { row, code, expiresAt };
}

/**
 * Verify a submitted `code` against the most recent active row for
 * `userId`. Returns one of:
 *   - { ok: true, phone }              — verified, caller should set User.phoneVerifiedAt
 *   - { ok: false, code: 'not_found' } — no active challenge
 *   - { ok: false, code: 'expired' }
 *   - { ok: false, code: 'too_many_attempts', attempts }
 *   - { ok: false, code: 'invalid_code', attempts, remaining }
 *   - { ok: false, code: 'invalid_input' }
 *
 * Increments `attempts` on every bad guess; when attempts reaches
 * MAX_VERIFY_ATTEMPTS the row is marked consumed (single-row invalidation).
 */
async function verifyPhoneChallenge(prisma, userId, code) {
  if (!isValidCode(code)) {
    return { ok: false, code: 'invalid_input' };
  }
  if (!prisma?.phoneVerification?.findFirst) {
    return { ok: false, code: 'not_found' };
  }
  const row = await prisma.phoneVerification.findFirst({
    where: { userId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { ok: false, code: 'not_found' };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    // Mark consumed so the next mint doesn't see a stale row.
    try {
      await prisma.phoneVerification.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
    } catch { /* best-effort */ }
    return { ok: false, code: 'expired' };
  }
  if ((row.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    try {
      await prisma.phoneVerification.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
    } catch { /* best-effort */ }
    return { ok: false, code: 'too_many_attempts', attempts: row.attempts };
  }

  const matches = await compareCode(code, row.codeHash);
  if (!matches) {
    const nextAttempts = (row.attempts || 0) + 1;
    const shouldConsume = nextAttempts >= MAX_VERIFY_ATTEMPTS;
    try {
      await prisma.phoneVerification.update({
        where: { id: row.id },
        data: {
          attempts: nextAttempts,
          ...(shouldConsume ? { consumedAt: new Date() } : {}),
        },
      });
    } catch { /* best-effort */ }
    if (shouldConsume) {
      return { ok: false, code: 'too_many_attempts', attempts: nextAttempts };
    }
    return {
      ok: false,
      code: 'invalid_code',
      attempts: nextAttempts,
      remaining: MAX_VERIFY_ATTEMPTS - nextAttempts,
    };
  }

  // Success — mark row consumed AND set User.phone + User.phoneVerifiedAt
  // atomically when the prisma client exposes $transaction. Falls back
  // to two writes when the test mock omits it.
  const verifiedAt = new Date();
  const tx = async (client) => {
    await client.phoneVerification.update({
      where: { id: row.id },
      data: { consumedAt: verifiedAt },
    });
    await client.user.update({
      where: { id: userId },
      data: { phone: row.phone, phoneVerifiedAt: verifiedAt },
    });
  };
  if (typeof prisma.$transaction === 'function') {
    await prisma.$transaction(tx);
  } else {
    await tx(prisma);
  }
  return { ok: true, phone: row.phone, verifiedAt };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  ttlMs,
  isValidPhone,
  isValidCode,
  mintCode,
  hashCode,
  compareCode,
  sendSms,
  createPhoneChallenge,
  verifyPhoneChallenge,
};
