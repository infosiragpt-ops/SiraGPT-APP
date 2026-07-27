'use strict';

const { TokenVault } = require('../TokenVault');

let vault = null;

function getVault() {
  if (vault) return vault;
  // Lazy load because the shared encryption helper intentionally exits when
  // ENCRYPTION_KEY is missing. Route imports and unit tests must stay inert.
  // eslint-disable-next-line global-require
  const { encrypt, decrypt } = require('../../utils/encryption');
  vault = new TokenVault({ encrypt, decrypt });
  return vault;
}

function sealSocialTokens(tokens, explicitVault = null) {
  const selected = explicitVault || getVault();
  const expiresAt = Number(tokens.expiresAt);
  return selected.sealProviderTokens({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    tokenType: tokens.tokenType || 'Bearer',
    scope: Array.isArray(tokens.scopes) ? tokens.scopes.join(' ') : String(tokens.scope || ''),
    // Some Page tokens do not return an expiry. TokenVault's generic default is
    // one hour, which would incorrectly disable those connections; represent
    // provider-managed/no-expiry tokens with a far-future boundary.
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt
      : Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000,
  });
}

function openSocialTokens(blob, explicitVault = null) {
  const selected = explicitVault || getVault();
  return selected.openProviderTokens(blob);
}

module.exports = { getVault, sealSocialTokens, openSocialTokens };
