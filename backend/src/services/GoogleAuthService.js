'use strict';

/**
 * GoogleAuthService — orchestrates the GoogleStrategy verify-callback
 * business rules. The passport adapter (config/passport.js) calls
 * `handleVerify(...)` and translates the result into `done(...)`.
 *
 * SOLID notes:
 *  - SRP: only the Google login business flow. No HTTP, no prisma
 *    handles, no passport plumbing leaks in. Encryption + DB access
 *    live behind injected collaborators.
 *  - DIP: `users` (UserRepository), `tokens` (TokenVault), `bcrypt`,
 *    `generateRandomPassword` and `logger` are all injected so this
 *    file can be unit-tested without prisma, without bcrypt's CPU
 *    cost, and without a real ENCRYPTION_KEY.
 *  - OCP: adding scopes or new persistence fields means changing
 *    `gmailScopes` / `googleServicesScopes` constants — not the
 *    branching logic.
 *  - LSP: returns plain `{ ok, user }` / `{ ok: false, reason }`
 *    shapes; any consumer (passport, a future REST handler, a worker)
 *    can use the same contract.
 */

const DEFAULT_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

const DEFAULT_GOOGLE_SERVICES_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');

class GoogleAuthService {
  /**
   * @param {object} deps
   * @param {import('../repositories/UserRepository').UserRepository} deps.users
   * @param {import('./TokenVault').TokenVault} deps.tokens
   * @param {{ hash: (s: string, rounds: number) => Promise<string> }} deps.bcrypt
   * @param {() => string} [deps.generateRandomPassword]
   * @param {string}       [deps.gmailScopes]
   * @param {string}       [deps.googleServicesScopes]
   * @param {Console}      [deps.logger]
   */
  constructor({
    users,
    tokens,
    bcrypt,
    generateRandomPassword,
    gmailScopes = DEFAULT_GMAIL_SCOPES,
    googleServicesScopes = DEFAULT_GOOGLE_SERVICES_SCOPES,
    logger = console,
  }) {
    if (!users) throw new Error('GoogleAuthService: users repository is required');
    if (!tokens) throw new Error('GoogleAuthService: tokens vault is required');
    if (!bcrypt || typeof bcrypt.hash !== 'function') {
      throw new Error('GoogleAuthService: bcrypt with hash() is required');
    }
    this.users = users;
    this.tokens = tokens;
    this.bcrypt = bcrypt;
    this.generateRandomPassword = generateRandomPassword || (() => Math.random().toString(36));
    this.gmailScopes = gmailScopes;
    this.googleServicesScopes = googleServicesScopes;
    this.logger = logger;
  }

  /**
   * Recover a refresh token from a previous successful login when
   * Google omits it on a return visit (common case: user already
   * granted consent and just re-authenticated). Returns whatever
   * refreshToken we can salvage, plus a side-effect: clearing
   * corrupted token blobs so the next login can re-prompt cleanly.
   *
   * @returns {Promise<string|null>}
   */
  async recoverRefreshTokenForEmail(email) {
    const existing = await this.users.findByEmail(email, {
      select: { id: true, gmailTokens: true },
    });
    if (!existing?.gmailTokens) return null;

    const inspection = this.tokens.inspectProviderTokens(existing.gmailTokens);
    if (inspection.status === 'ok') {
      if (inspection.value?.refreshToken) {
        this.logger.log?.('[google-auth] reusing existing refresh token from DB');
        return inspection.value.refreshToken;
      }
      // Decryption succeeded but the stored bundle simply has no
      // refresh token (common after a previous login that itself
      // didn't receive one). Leave the row alone — clearing it would
      // discard a valid access token + scope record for no benefit.
      return null;
    }

    // status === 'corrupt': decrypt or JSON parse failed. Clear the
    // row so the next login can re-prompt and store fresh tokens.
    // Failure to clear is logged but not fatal.
    try {
      await this.users.clearGmailTokens(existing.id);
      this.logger.log?.('[google-auth] cleared corrupted gmail tokens');
    } catch (clearErr) {
      this.logger.error?.('[google-auth] failed to clear corrupted tokens:', clearErr);
    }
    return null;
  }

  /**
   * Main entry point. Maps a Google OAuth profile into a persisted
   * user row, creating it on first login or updating tokens on
   * subsequent ones. Returns `{ ok: true, user }` on success.
   *
   * The caller (passport adapter) is responsible for translating
   * thrown errors into `done(err)` vs `done(null, false, info)`.
   */
  async handleVerify({ accessToken, refreshToken, profile }) {
    const email = profile?.emails?.[0]?.value;
    if (!email) {
      const err = new Error('Google profile has no email');
      err.code = 'NO_EMAIL';
      throw err;
    }

    // Resolve account state before encrypting/updating provider credentials.
    // A soft-deleted account must never be revived through OAuth or reach the
    // passport callback that mints its application session.
    const existing = await this.users.findByEmail(email);
    if (existing?.deletedAt != null) {
      const err = new Error('Account is inactive');
      err.code = 'ACCOUNT_INACTIVE';
      throw err;
    }

    let effectiveRefreshToken = refreshToken;
    if (!effectiveRefreshToken) {
      this.logger.error?.(
        '[google-auth] No refresh token from Google; attempting recovery from stored tokens'
      );
      effectiveRefreshToken = await this.recoverRefreshTokenForEmail(email);
    }

    const sealedGmail = this.tokens.sealProviderTokens({
      accessToken,
      refreshToken: effectiveRefreshToken,
      scope: this.gmailScopes,
    });
    const sealedGoogleServices = this.tokens.sealProviderTokens({
      accessToken,
      refreshToken: effectiveRefreshToken,
      scope: this.googleServicesScopes,
    });

    if (existing) {
      const updated = await this.users.updateGoogleIdentity(existing.id, {
        googleId: profile.id,
        gmailTokens: sealedGmail,
        googleServicesTokens: sealedGoogleServices,
      });
      return { ok: true, user: updated };
    }

    const passwordHash = await this.bcrypt.hash(this.generateRandomPassword(), 12);
    const created = await this.users.createOAuthUser({
      googleId: profile.id,
      name: profile.displayName,
      email,
      avatar: profile.photos?.[0]?.value,
      passwordHash,
      gmailTokens: sealedGmail,
      googleServicesTokens: sealedGoogleServices,
    });
    return { ok: true, user: created };
  }
}

module.exports = {
  GoogleAuthService,
  DEFAULT_GMAIL_SCOPES,
  DEFAULT_GOOGLE_SERVICES_SCOPES,
};
