'use strict';

/**
 * SMS-based 2FA login challenge lifecycle (ratchet 45, cycle 131).
 *
 * Pure helpers around the `TwoFAChallenge` Prisma model so the auth
 * routes (`POST /api/auth/2fa/sms/challenge` + `POST /api/auth/2fa/sms/verify`)
 * stay slim. This is the LOGIN-side counterpart to `phone-verification.js`
 * (which protects `PUT /api/users/me/phone`).
 *
 * Contract:
 *   - Codes are 6 random digits, short-lived (5 min by default — override
 *     with `TWOFA_SMS_TTL_MS`), stored as bcrypt hashes.
 *   - The challenge is identified by an opaque `challengeId` returned to
 *     the client, NOT by userId — so a partially-authenticated user can
 *     resume verification without a session cookie.
 *   - The destination (E.164 phone, email, or session token) is resolved
 *     to a User before we mint the row. When the lookup is ambiguous we
 *     fail closed with `unknown_contact` to avoid enumeration.
 *   - Single-use (`consumedAt`), capped at MAX_VERIFY_ATTEMPTS=5 attempts.
 *   - Plaintext OTPs are NEVER logged or persisted.
 *
 * Login-flow integration (binding a partial session, fanning the final
 * JWT only after a successful verify) is intentionally left for the
 * next cycle — this service exposes `verifyChallenge` which returns
 * `{ ok: true, userId }` on success; the route layer is responsible
 * for actually minting the session token.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const BCRYPT_COST = 8;
// E.164: leading '+', 8-15 digits total. Matches phone-verification.js.
const E164_RE = /^\+[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ttlMs() {
  const raw = Number(process.env.TWOFA_SMS_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

function isValidPhone(v) {
  return typeof v === 'string' && E164_RE.test(v);
}

function isValidEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v) && v.length <= 254;
}

function isValidCode(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

function isValidChallengeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(id);
}

function mintCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

function mintChallengeId() {
  // 32 bytes → 43 url-safe base64 chars (no padding). Plenty of entropy
  // and short enough to round-trip through query strings.
  return crypto.randomBytes(32).toString('base64url');
}

function lookupKey(destination) {
  const norm = String(destination || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex');
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
 * Resolve `{ phone, email, sessionToken }` → a User row (or null). The
 * caller is expected to short-circuit when no user is found so we
 * don't leak which contact strings are registered.
 *
 * `sessionToken` here is the partial-login session token a previous
 * login-flow step would have minted; this scaffold accepts it but the
 * actual partial-session model lives in a follow-up cycle. For now we
 * treat it like an opaque pointer and bail with `unknown_contact`.
 */
async function resolveUser(prisma, { phone, email, sessionToken } = {}) {
  if (!prisma?.user?.findFirst) return null;
  if (typeof email === 'string' && isValidEmail(email)) {
    const norm = email.trim().toLowerCase();
    try {
      const u = await prisma.user.findUnique({ where: { email: norm } });
      if (u) return u;
    } catch { /* fall through */ }
  }
  if (typeof phone === 'string' && isValidPhone(phone)) {
    try {
      const u = await prisma.user.findFirst({ where: { phone } });
      if (u) return u;
    } catch { /* fall through */ }
  }
  if (typeof sessionToken === 'string' && sessionToken.length >= 16) {
    // Partial-session model not implemented yet — the contract is
    // documented in the route header. Always resolves to null here so
    // a malicious client can't enumerate via this branch.
    return null;
  }
  return null;
}

/**
 * Best-effort SMS send via Twilio. Mirrors the graceful-degradation
 * contract in `phone-verification.js`: any missing env / package /
 * config is a `skipped` result, never a thrown error.
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
      logger?.info?.(`[two-fa-sms] twilio not installed (${err?.message || err})`);
      return { sent: false, reason: 'no-twilio-lib' };
    }
  }
  let client;
  try {
    client = opts.client || (typeof twilioMod === 'function'
      ? twilioMod(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      : twilioMod.default?.(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));
  } catch (err) {
    logger?.warn?.(`[two-fa-sms] twilio init failed: ${err?.message || err}`);
    return { sent: false, reason: 'twilio-init-failed' };
  }
  if (!client?.messages?.create) {
    return { sent: false, reason: 'no-twilio-client' };
  }
  const body = `Your siraGPT login code is ${code}. It expires in 5 minutes.`;
  const payload = messagingServiceSid
    ? { to: phone, body, messagingServiceSid }
    : { to: phone, body, from };
  try {
    await client.messages.create(payload);
    return { sent: true };
  } catch (err) {
    logger?.warn?.(`[two-fa-sms] sms send failed: ${err?.message || err}`);
    return { sent: false, reason: 'send-failed' };
  }
}

/**
 * Mint a new 2FA challenge. Invalidates any prior unconsumed rows for
 * `user.id` (single active challenge at a time) and returns
 * `{ challengeId, code, expiresAt, row }`. The caller is responsible
 * for actually sending the SMS so this helper stays unit-testable.
 *
 * `destination` is the phone we'll text — for the SMS channel this
 * MUST be a valid E.164 number (we re-validate). The caller is
 * expected to pull it from the resolved User (`user.phone`) so we
 * never accidentally text a user-controlled string from the request
 * body.
 */
async function createSmsChallenge(prisma, user, destination) {
  if (!prisma?.twoFAChallenge?.create) {
    throw new Error('prisma.twoFAChallenge model unavailable');
  }
  if (!user || !user.id) {
    const err = new Error('unknown_contact');
    err.code = 'unknown_contact';
    throw err;
  }
  if (!isValidPhone(destination)) {
    const err = new Error('invalid_phone');
    err.code = 'invalid_phone';
    throw err;
  }
  const code = mintCode();
  const codeHash = await hashCode(code);
  const challengeId = mintChallengeId();
  const expiresAt = new Date(Date.now() + ttlMs());

  // Invalidate prior unconsumed challenges AND mint the new one as one unit —
  // otherwise a failure between them could consume every active challenge yet
  // create no replacement (locking the user out), or leave two challenges live.
  const ops = [
    prisma.twoFAChallenge.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.twoFAChallenge.create({
      data: {
        challengeId,
        userId: user.id,
        channel: 'sms',
        destination,
        lookup: lookupKey(destination),
        codeHash,
        expiresAt,
      },
    }),
  ];
  // Fall back to sequential writes if the client lacks $transaction (test doubles).
  const [, row] = typeof prisma.$transaction === 'function'
    ? await prisma.$transaction(ops)
    : await Promise.all(ops);
  return { challengeId, code, expiresAt, row };
}

/**
 * Verify a submitted `code` against the row with `challengeId`. Returns
 *   - { ok: true, userId, channel }
 *   - { ok: false, code: 'not_found' }
 *   - { ok: false, code: 'expired' }
 *   - { ok: false, code: 'too_many_attempts', attempts }
 *   - { ok: false, code: 'invalid_code', attempts, remaining }
 *   - { ok: false, code: 'invalid_input' }
 */
async function verifyChallenge(prisma, challengeId, code) {
  if (!isValidChallengeId(challengeId) || !isValidCode(code)) {
    return { ok: false, code: 'invalid_input' };
  }
  if (!prisma?.twoFAChallenge?.findUnique) {
    return { ok: false, code: 'not_found' };
  }
  const row = await prisma.twoFAChallenge.findUnique({
    where: { challengeId },
  });
  if (!row || row.consumedAt) return { ok: false, code: 'not_found' };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    try {
      await prisma.twoFAChallenge.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
    } catch { /* best-effort */ }
    return { ok: false, code: 'expired' };
  }
  if ((row.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    try {
      await prisma.twoFAChallenge.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
    } catch { /* best-effort */ }
    return { ok: false, code: 'too_many_attempts', attempts: row.attempts };
  }

  const matches = await compareCode(code, row.codeHash);
  if (!matches) {
    // Atomic increment so concurrent wrong-code submissions can't all read the
    // same `attempts` and each write the same +1 — a lost-update that let a
    // parallel-guess burst slip past the brute-force cap. The DB serializes the
    // increments; we decide from the returned post-increment value.
    let nextAttempts = (row.attempts || 0) + 1;
    try {
      const updated = await prisma.twoFAChallenge.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      if (updated && typeof updated.attempts === 'number') nextAttempts = updated.attempts;
    } catch { /* best-effort: fall back to the optimistic local count */ }
    const shouldConsume = nextAttempts >= MAX_VERIFY_ATTEMPTS;
    if (shouldConsume) {
      try {
        await prisma.twoFAChallenge.update({
          where: { id: row.id },
          data: { consumedAt: new Date() },
        });
      } catch { /* best-effort */ }
      return { ok: false, code: 'too_many_attempts', attempts: nextAttempts };
    }
    return {
      ok: false,
      code: 'invalid_code',
      attempts: nextAttempts,
      remaining: MAX_VERIFY_ATTEMPTS - nextAttempts,
    };
  }

  // Success — mark row consumed. The caller (auth route) is responsible
  // for issuing the final JWT; this keeps the verification primitive
  // pure and decouples it from the not-yet-built partial-session model.
  const verifiedAt = new Date();
  try {
    await prisma.twoFAChallenge.update({
      where: { id: row.id },
      data: { consumedAt: verifiedAt },
    });
  } catch { /* best-effort */ }
  return { ok: true, userId: row.userId, channel: row.channel, verifiedAt };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  ttlMs,
  isValidPhone,
  isValidEmail,
  isValidCode,
  isValidChallengeId,
  mintCode,
  mintChallengeId,
  lookupKey,
  hashCode,
  compareCode,
  resolveUser,
  sendSms,
  createSmsChallenge,
  verifyChallenge,
};
