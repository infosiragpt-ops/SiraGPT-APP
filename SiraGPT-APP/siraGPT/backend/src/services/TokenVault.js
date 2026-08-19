'use strict';

/**
 * TokenVault — single-responsibility envelope for encrypted provider
 * OAuth tokens (Gmail, Drive, Calendar, …). Wraps the AES-256
 * encrypt/decrypt utilities and standardises the on-disk JSON shape
 * so the rest of the codebase doesn't have to think about either.
 *
 * SOLID notes:
 *  - SRP: only token-blob crypto + serialization. No DB, no HTTP, no
 *    business rules.
 *  - DIP: `encrypt` and `decrypt` are injected via the constructor.
 *    Tests pass identity functions to assert behaviour without
 *    touching the real ENCRYPTION_KEY env var.
 *  - ISP: the public surface is three methods (sealProviderTokens,
 *    openProviderTokens, extractRefreshToken) — each call site uses
 *    at most two.
 */

class TokenVault {
  /**
   * @param {object} deps
   * @param {(plain: string) => string} deps.encrypt
   * @param {(cipher: string) => string} deps.decrypt
   * @param {Console}  [deps.logger]
   */
  constructor({ encrypt, decrypt, logger = console }) {
    if (typeof encrypt !== 'function') throw new Error('TokenVault: encrypt is required');
    if (typeof decrypt !== 'function') throw new Error('TokenVault: decrypt is required');
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.logger = logger;
  }

  /**
   * Serialise + encrypt a provider token bundle.
   *
   * @param {object} bundle
   * @param {string}      bundle.accessToken
   * @param {string|null} bundle.refreshToken
   * @param {string}      bundle.scope            Space-separated scope list
   * @param {number}      [bundle.expiresAt]      Unix ms; defaults to +1h
   * @param {string}      [bundle.tokenType]      Defaults to 'Bearer'
   * @returns {string} ciphertext blob suitable for prisma persistence
   */
  sealProviderTokens({ accessToken, refreshToken, scope, expiresAt, tokenType = 'Bearer' }) {
    const envelope = JSON.stringify({
      accessToken,
      refreshToken,
      tokenType,
      scope,
      expiresAt: expiresAt ?? Date.now() + 3600 * 1000,
    });
    return this.encrypt(envelope);
  }

  /**
   * Decrypt + parse a stored blob. Returns `null` if the blob is
   * missing OR if decryption / JSON parsing fails (corrupted /
   * rotated key / legacy format) so callers can fall through cleanly
   * without try/catch boilerplate. When the distinction between
   * "missing", "corrupt" and "valid but empty fields" matters, use
   * `inspectProviderTokens` instead.
   */
  openProviderTokens(blob) {
    return this.inspectProviderTokens(blob).value;
  }

  /**
   * Like `openProviderTokens` but surfaces *why* the result is null
   * so callers can distinguish:
   *   - `status: 'empty'`   → no blob stored (first login, cleared)
   *   - `status: 'corrupt'` → decrypt or JSON parse threw (key
   *     rotated, legacy format, garbage in DB) — caller should
   *     usually clear the row.
   *   - `status: 'ok'`      → decrypted + parsed successfully; the
   *     parsed object is in `value`. Note: `value` may itself have
   *     missing optional fields (e.g. no refreshToken) — that is NOT
   *     corruption.
   */
  inspectProviderTokens(blob) {
    if (!blob) return { status: 'empty', value: null };
    try {
      return { status: 'ok', value: JSON.parse(this.decrypt(blob)) };
    } catch (err) {
      this.logger.warn?.(`[token-vault] failed to decrypt stored tokens: ${err.message || err}`);
      return { status: 'corrupt', value: null };
    }
  }

  /**
   * Convenience: pull just the refreshToken out of a stored blob.
   * Returns `null` if the blob is missing, corrupted, or has no
   * refreshToken field.
   */
  extractRefreshToken(blob) {
    const parsed = this.openProviderTokens(blob);
    return parsed?.refreshToken ?? null;
  }
}

module.exports = { TokenVault };
