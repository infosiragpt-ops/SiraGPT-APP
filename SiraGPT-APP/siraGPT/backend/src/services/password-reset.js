'use strict';

/**
 * Password reset token lifecycle (spec §7.13).
 *
 * Mirrors services/email-verification.js. Tokens are 32-byte hex strings
 * (64 chars), single-use (`consumedAt`), short-lived (30m by default —
 * override with PASSWORD_RESET_TTL_MS). The link itself is the secret;
 * we store plaintext because brute-force is gated by per-IP+email rate
 * limits in the auth route.
 *
 * The accompanying email is delivered via services/email.js so test
 * harnesses can stub the transport.
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function ttlMs() {
  const raw = Number(process.env.PASSWORD_RESET_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new PasswordResetToken row for `userId` and return the
 * plaintext token. The caller is responsible for emailing it.
 *
 * @param {object} prisma — Prisma client with `passwordResetToken` model
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.requestedFromIp] — Audit trail for the requester.
 */
async function createPasswordResetToken(prisma, userId, opts = {}) {
  if (!prisma || !prisma.passwordResetToken) {
    throw new Error('prisma.passwordResetToken model unavailable');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('createPasswordResetToken: userId required');
  }
  const token = mintToken();
  const expiresAt = new Date(Date.now() + ttlMs());
  await prisma.passwordResetToken.create({
    data: {
      userId,
      token,
      expiresAt,
      requestedFromIp: opts.requestedFromIp || null,
    },
  });
  return { token, expiresAt };
}

/**
 * Validate a reset token without consuming it. Returns
 *   { ok: true, userId } on success
 *   { ok: false, code } otherwise
 *
 * Codes:
 *   - 'not_found'    — token does not exist
 *   - 'expired'      — token outside its TTL window
 *   - 'already_used' — token previously consumed
 *
 * Useful for the frontend to check the token before showing the
 * "set new password" form.
 */
async function validatePasswordResetToken(prisma, token) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return { ok: false, code: 'not_found' };
  }
  const row = await prisma.passwordResetToken.findUnique({
    where: { token },
  });
  if (!row) return { ok: false, code: 'not_found' };
  if (row.consumedAt) return { ok: false, code: 'already_used' };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, code: 'expired' };
  }
  return { ok: true, userId: row.userId };
}

/**
 * Consume a password reset token and update the user's password hash.
 * Wrapped in a transaction so the password change + token consumption
 * are atomic — we never end up with a consumed token but an unchanged
 * password (or vice versa).
 *
 * @param {object} prisma
 * @param {string} token
 * @param {object} args
 * @param {string} args.newPasswordHash — bcrypt hash from the route handler
 */
async function consumePasswordResetToken(prisma, token, args = {}) {
  const validation = await validatePasswordResetToken(prisma, token);
  if (!validation.ok) return validation;
  const { newPasswordHash } = args;
  if (!newPasswordHash || typeof newPasswordHash !== 'string') {
    throw new TypeError('consumePasswordResetToken: newPasswordHash required');
  }

  const row = await prisma.passwordResetToken.findUnique({ where: { token } });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: row.userId },
      data: { password: newPasswordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
  });

  return { ok: true, userId: row.userId };
}

module.exports = {
  mintToken,
  ttlMs,
  createPasswordResetToken,
  validatePasswordResetToken,
  consumePasswordResetToken,
  DEFAULT_TTL_MS,
};
