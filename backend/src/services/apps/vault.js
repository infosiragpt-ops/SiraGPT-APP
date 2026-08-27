'use strict';

const { parseSecretRef, SECRET_KINDS } = require('./registry');

function identityVault() {
  return {
    openProviderTokens(blob) {
      if (!blob) return null;
      if (typeof blob === 'object') return blob;
      try { return JSON.parse(blob); } catch { return null; }
    },
    sealProviderTokens(bundle) {
      return JSON.stringify(bundle || {});
    },
  };
}

function getDefaultVault() {
  // Lazy: encryption.js exits the process when ENCRYPTION_KEY is missing.
  // eslint-disable-next-line global-require
  const { TokenVault } = require('../TokenVault');
  // eslint-disable-next-line global-require
  const { encrypt, decrypt } = require('../../utils/encryption');
  return new TokenVault({ encrypt, decrypt });
}

function normalizeBundle(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const accessToken = String(parsed.accessToken || parsed.access_token || '').trim();
  if (!accessToken) return null;
  const expiresAt = Number(parsed.expiresAt || parsed.expires_at || 0);
  const scope = parsed.scope || parsed.scopes || '';
  const scopes = Array.isArray(scope)
    ? scope.map(String).filter(Boolean)
    : String(scope).split(/[,\s]+/).filter(Boolean);
  return {
    accessToken,
    refreshToken: parsed.refreshToken || parsed.refresh_token || null,
    tokenType: parsed.tokenType || parsed.token_type || 'Bearer',
    scope: scopes.join(' '),
    scopes,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
  };
}

async function loadSealedBlob(prisma, secretRef) {
  const parsed = parseSecretRef(secretRef);
  if (!parsed || !prisma) return null;
  if (parsed.kind === SECRET_KINDS.GITHUB_ACCOUNT && prisma.githubAccount?.findUnique) {
    const row = await prisma.githubAccount.findUnique({
      where: { id: parsed.id },
      select: { id: true, encryptedTokens: true, scope: true, userId: true },
    });
    return row ? { blob: row.encryptedTokens, row, kind: parsed.kind } : null;
  }
  if (parsed.kind === SECRET_KINDS.SOCIAL_CONNECTION && prisma.socialConnection?.findUnique) {
    const row = await prisma.socialConnection.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
        scopes: true,
        expiresAt: true,
        userId: true,
        platform: true,
        accountId: true,
        accountName: true,
        profile: true,
      },
    });
    return row ? { blob: row.accessToken, row, kind: parsed.kind } : null;
  }
  if (parsed.kind === SECRET_KINDS.CONNECTOR_ACCOUNT && prisma.connectorAccount?.findUnique) {
    const row = await prisma.connectorAccount.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        userId: true,
        provider: true,
        tokenEncrypted: true,
        scopes: true,
        status: true,
        accountLabel: true,
      },
    });
    return row ? { blob: row.tokenEncrypted, row, kind: parsed.kind } : null;
  }
  if (parsed.kind === SECRET_KINDS.USER_GOOGLE_SERVICES && prisma.user?.findUnique) {
    const row = await prisma.user.findUnique({
      where: { id: parsed.id },
      select: { id: true, googleServicesTokens: true },
    });
    return row ? { blob: row.googleServicesTokens, row: { ...row, userId: parsed.id }, kind: parsed.kind } : null;
  }
  return null;
}

async function openSecret(prisma, secretRef, vault = null) {
  const selected = vault || getDefaultVault();
  const loaded = await loadSealedBlob(prisma, secretRef);
  if (!loaded?.blob) return null;
  const opened = selected.openProviderTokens
    ? selected.openProviderTokens(loaded.blob)
    : selected.open?.(loaded.blob);
  const bundle = normalizeBundle(opened);
  if (!bundle) return null;
  if ((!bundle.scopes || bundle.scopes.length === 0) && loaded.row?.scope) {
    bundle.scopes = String(loaded.row.scope).split(/[,\s]+/).filter(Boolean);
    bundle.scope = bundle.scopes.join(' ');
  }
  if ((!bundle.scopes || bundle.scopes.length === 0) && Array.isArray(loaded.row?.scopes)) {
    bundle.scopes = loaded.row.scopes.map(String);
    bundle.scope = bundle.scopes.join(' ');
  }
  if (!bundle.expiresAt && loaded.row?.expiresAt) {
    const ms = new Date(loaded.row.expiresAt).getTime();
    bundle.expiresAt = Number.isFinite(ms) ? ms : null;
  }
  return { ...bundle, _meta: { kind: loaded.kind, row: loaded.row } };
}

module.exports = {
  getDefaultVault,
  identityVault,
  normalizeBundle,
  loadSealedBlob,
  openSecret,
};
