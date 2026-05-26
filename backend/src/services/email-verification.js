'use strict';

/**
 * Email verification token lifecycle (ratchet 45).
 *
 * Pure helpers around the `EmailVerificationToken` Prisma model so the
 * auth route + the org-invitation accept flow can reuse the same mint /
 * redeem logic. Tokens are 32-byte hex strings (64 chars), short-lived
 * (24h by default — override with EMAIL_VERIFICATION_TTL_MS), and stored
 * as plaintext: the link itself is the secret and the token is single
 * use (`consumedAt`).
 *
 * The accompanying email is delivered via services/email.js so test
 * harnesses can stub the transport.
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function ttlMs() {
  const raw = Number(process.env.EMAIL_VERIFICATION_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new EmailVerificationToken row for `userId` and return the
 * plaintext token. The caller is responsible for emailing it (so this
 * helper stays usable in tests / scripts that want to skip SMTP).
 */
async function createVerificationToken(prisma, userId) {
  if (!prisma || !prisma.emailVerificationToken) {
    throw new Error('prisma.emailVerificationToken model unavailable');
  }
  const token = mintToken();
  const expiresAt = new Date(Date.now() + ttlMs());
  await prisma.emailVerificationToken.create({
    data: { userId, token, expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Redeem a verification token. Returns `{ ok: true, userId }` on
 * success, or `{ ok: false, code }` where `code` is one of:
 *   - 'not_found'      — token does not exist
 *   - 'expired'        — token outside its TTL window
 *   - 'already_used'   — token previously consumed
 *
 * On success, `users.emailVerifiedAt` is set (idempotent — left alone
 * when already verified) and the token row is marked consumed. Wrapped
 * in a transaction so partial failures don't leave the user verified
 * without the token consumed (or vice versa).
 */
async function redeemVerificationToken(prisma, token) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return { ok: false, code: 'not_found' };
  }
  const row = await prisma.emailVerificationToken.findUnique({
    where: { token },
  });
  if (!row) return { ok: false, code: 'not_found' };
  if (row.consumedAt) return { ok: false, code: 'already_used' };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, code: 'expired' };
  }

  // Two writes — keep them in a transaction so we never set the user
  // as verified without marking the token consumed.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: new Date() },
    });
    await tx.emailVerificationToken.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
  });

  return { ok: true, userId: row.userId };
}

module.exports = {
  mintToken,
  ttlMs,
  createVerificationToken,
  redeemVerificationToken,
  DEFAULT_TTL_MS,
};
