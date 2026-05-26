'use strict';

/**
 * ProviderOAuthService — encapsulates the four-step lifecycle every
 * Google-style provider OAuth integration (Gmail, Calendar+Drive, …)
 * shares, so the route layer can stay focused on HTTP concerns
 * (status codes, popup HTML, validation).
 *
 * Lifecycle owned by this service:
 *   1. buildAuthUrl(userId, { forceConsent? })  → authorize URL
 *   2. handleCallback({ code, state })          → { ok, userId?, error? }
 *   3. disconnect(userId)                       → void
 *   4. getStatus(userId)                        → { isConnected, hasRefreshToken, hasRequiredScopes, needsReauth }
 *
 * SOLID notes:
 *  - SRP: only the per-provider OAuth flow. No HTTP, no popup HTML,
 *    no token-blob crypto (delegated to TokenVault), no Prisma
 *    (delegated to UserRepository methods bound in the descriptor).
 *  - DIP: every collaborator (tokenVault, signState, verifyState,
 *    logger) is injected; the provider descriptor injects the
 *    oauth2 client and the persistence methods, so the same class
 *    serves any number of providers.
 *  - OCP: adding a third provider is "instantiate a descriptor" —
 *    no edits to this file.
 *  - ISP: provider descriptor surface is small (5 callbacks + 4
 *    static fields). Routes consume the 4 service methods directly.
 */

/**
 * @typedef {object} ProviderDescriptor
 * @property {string} service                  — stable id ('gmail', 'google_services')
 * @property {object} oauth2Client             — googleapis OAuth2Client (or duck-type) with generateAuthUrl + getToken
 * @property {string[]} scopes                 — scopes to request at authorize time
 * @property {string} scopeFallback            — value stored when Google's response omits `scope`
 * @property {string[]} requiredScopes         — scopes the status check verifies are present
 * @property {'every'|'some'} scopeMatch       — policy: must have ALL required scopes vs ANY
 * @property {(userId: string, sealedBlob: string) => Promise<any>} persistTokens
 * @property {(userId: string) => Promise<any>} clearTokens
 * @property {(userId: string) => Promise<string|null>} readSealedTokens
 *   — returns the ciphertext blob (or null) for the status check.
 */

class ProviderOAuthService {
  /**
   * @param {object} deps
   * @param {ProviderDescriptor} deps.provider
   * @param {import('./TokenVault').TokenVault} deps.tokenVault
   * @param {(payload: {userId:string, service:string}) => string} deps.signState
   * @param {(rawState:string, opts:{service:string}) => {userId:string}} deps.verifyState
   * @param {Console} [deps.logger]
   */
  constructor({ provider, tokenVault, signState, verifyState, logger = console }) {
    if (!provider || typeof provider !== 'object') {
      throw new Error('ProviderOAuthService: provider descriptor is required');
    }
    for (const k of ['service', 'oauth2Client', 'scopes', 'scopeFallback',
      'requiredScopes', 'scopeMatch', 'persistTokens', 'clearTokens', 'readSealedTokens']) {
      if (provider[k] === undefined || provider[k] === null) {
        throw new Error(`ProviderOAuthService: provider.${k} is required`);
      }
    }
    if (provider.scopeMatch !== 'every' && provider.scopeMatch !== 'some') {
      throw new Error("ProviderOAuthService: provider.scopeMatch must be 'every' or 'some'");
    }
    if (!tokenVault || typeof tokenVault.sealProviderTokens !== 'function') {
      throw new Error('ProviderOAuthService: tokenVault is required');
    }
    if (typeof signState !== 'function' || typeof verifyState !== 'function') {
      throw new Error('ProviderOAuthService: signState/verifyState are required');
    }
    this.provider = provider;
    this.tokenVault = tokenVault;
    this.signState = signState;
    this.verifyState = verifyState;
    this.logger = logger;
  }

  /**
   * Build the provider authorize URL. `forceConsent` is on by default
   * because both current providers need a guaranteed refresh_token on
   * every connect; `/gmail/reauth` used to spin up an ad-hoc client
   * just to flip the prompt — now it's a flag.
   */
  buildAuthUrl(userId, { forceConsent = true } = {}) {
    return this.provider.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: forceConsent ? 'consent' : undefined,
      scope: this.provider.scopes,
      state: this.signState({ userId, service: this.provider.service }),
    });
  }

  /**
   * Run the full callback pipeline: validate state, exchange the
   * code, seal the bundle, persist it. Returns a structured result
   * the route layer maps to popup HTML — never throws on the
   * expected failure paths (missing input, bad state, exchange
   * failure). Unexpected errors are caught and surfaced as
   * `{ ok:false, error:'auth_failed' }` to match the legacy
   * behaviour.
   */
  async handleCallback({ code, state }) {
    if (!code || !state) {
      return { ok: false, service: this.provider.service, error: 'auth_failed' };
    }

    let userId;
    try {
      ({ userId } = this.verifyState(state, { service: this.provider.service }));
    } catch (stateError) {
      this.logger.warn?.(
        `[oauth/${this.provider.service}] state validation failed: ${stateError.message}`
      );
      return { ok: false, service: this.provider.service, error: 'invalid_state' };
    }

    try {
      const { tokens } = await this.provider.oauth2Client.getToken(code);
      this.logger.log?.(`[oauth/${this.provider.service}] token exchange ok`, {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        scope: tokens.scope,
      });

      const sealed = this.tokenVault.sealProviderTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType: tokens.token_type,
        scope: tokens.scope || this.provider.scopeFallback,
        expiresAt: tokens.expiry_date || undefined,
      });

      await this.provider.persistTokens(userId, sealed);
      return { ok: true, service: this.provider.service, userId };
    } catch (err) {
      this.logger.error?.(
        `[oauth/${this.provider.service}] callback error:`, err?.message || err
      );
      return { ok: false, service: this.provider.service, error: 'auth_failed' };
    }
  }

  /**
   * Disconnect by clearing the persisted token blob. Lets errors
   * propagate so the route can decide on the HTTP status — disconnect
   * is a user-initiated action, not fire-and-forget like audit.
   */
  disconnect(userId) {
    return this.provider.clearTokens(userId);
  }

  /**
   * Read the persisted blob, open it through TokenVault, and return
   * the connection status the legacy /status endpoints returned. A
   * missing or corrupt blob yields `isConnected:false` — the vault
   * already logs the corrupt case at warn level.
   */
  async getStatus(userId) {
    const sealed = await this.provider.readSealedTokens(userId);
    const tokens = this.tokenVault.openProviderTokens(sealed);

    if (!tokens) {
      return {
        isConnected: false,
        hasRefreshToken: false,
        hasRequiredScopes: false,
        needsReauth: false,
      };
    }

    const hasRefreshToken = !!tokens.refreshToken;
    const tokenScope = tokens.scope || '';
    const hasRequiredScopes = this.provider.scopeMatch === 'every'
      ? this.provider.requiredScopes.every((s) => tokenScope.includes(s))
      : this.provider.requiredScopes.some((s) => tokenScope.includes(s));

    return {
      isConnected: true,
      hasRefreshToken,
      hasRequiredScopes,
      needsReauth: !hasRefreshToken || !hasRequiredScopes,
    };
  }
}

module.exports = { ProviderOAuthService };
