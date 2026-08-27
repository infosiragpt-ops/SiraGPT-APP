'use strict';

const { getManifest, parseSecretRef, SECRET_KINDS } = require('./registry');
const { openSecret } = require('./vault');
const { findByUserAndApp, deleteConnection } = require('./store');
const { auditAppEvent } = require('./audit');

const REQUEST_TIMEOUT_MS = 10_000;

function envValue(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

async function fetchWithTimeout(url, init, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function revokeRemote({ appId, accessToken, env, fetchImpl }) {
  if (!accessToken) return { attempted: false, ok: false };
  try {
    if (appId === 'github') {
      const clientId = envValue(env, 'GITHUB_CLIENT_ID');
      const clientSecret = envValue(env, 'GITHUB_CLIENT_SECRET');
      if (!clientId || !clientSecret) return { attempted: false, ok: false };
      const response = await fetchWithTimeout('https://api.github.com/applications/' + encodeURIComponent(clientId) + '/token', {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          'User-Agent': 'siraGPT-apps',
        },
        body: JSON.stringify({ access_token: accessToken }),
      }, fetchImpl);
      return { attempted: true, ok: response.status === 204 || response.status === 200 || response.status === 404 };
    }
    if (appId === 'linkedin') {
      const clientId = envValue(env, 'SOCIAL_LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_ID');
      const clientSecret = envValue(env, 'SOCIAL_LINKEDIN_CLIENT_SECRET', 'LINKEDIN_CLIENT_SECRET');
      const response = await fetchWithTimeout('https://www.linkedin.com/oauth/v2/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          token: accessToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }, fetchImpl);
      return { attempted: true, ok: response.ok || response.status === 404 };
    }
    if (appId === 'onedrive') {
      return { attempted: false, ok: false };
    }
    if (appId === 'google-drive') {
      const response = await fetchWithTimeout('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ token: accessToken }),
      }, fetchImpl);
      return { attempted: true, ok: response.ok || response.status === 400 || response.status === 404 };
    }
    const clientId = envValue(env, 'SOCIAL_X_CLIENT_ID', 'X_CLIENT_ID', 'TWITTER_CLIENT_ID');
    const clientSecret = envValue(env, 'SOCIAL_X_CLIENT_SECRET', 'X_CLIENT_SECRET', 'TWITTER_CLIENT_SECRET');
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (clientId && clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    }
    const body = new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' });
    if (clientId) body.set('client_id', clientId);
    const response = await fetchWithTimeout('https://api.x.com/2/oauth2/revoke', {
      method: 'POST',
      headers,
      body,
    }, fetchImpl);
    return { attempted: true, ok: response.ok || response.status === 404 };
  } catch {
    return { attempted: true, ok: false };
  }
}

async function deleteSourceSecret(prisma, secretRef) {
  const parsed = parseSecretRef(secretRef);
  if (!parsed) return false;
  if (parsed.kind === SECRET_KINDS.GITHUB_ACCOUNT && prisma.githubAccount?.deleteMany) {
    await prisma.githubAccount.deleteMany({ where: { id: parsed.id } });
    return true;
  }
  if (parsed.kind === SECRET_KINDS.SOCIAL_CONNECTION && prisma.socialConnection?.deleteMany) {
    await prisma.socialConnection.deleteMany({ where: { id: parsed.id } });
    return true;
  }
  if (parsed.kind === SECRET_KINDS.CONNECTOR_ACCOUNT && prisma.connectorAccount) {
    const row = prisma.connectorAccount.findUnique
      ? await prisma.connectorAccount.findUnique({
        where: { id: parsed.id },
        select: { id: true, userId: true, provider: true },
      })
      : null;
    if (row?.provider === 'google_drive' && prisma.user?.updateMany) {
      await prisma.user.updateMany({
        where: { id: row.userId },
        data: { googleServicesTokens: null },
      });
    }
    if (prisma.connectorAccount.updateMany) {
      await prisma.connectorAccount.updateMany({
        where: { id: parsed.id },
        data: {
          tokenEncrypted: null,
          scopes: [],
          status: 'disconnected',
          lastHealthAt: new Date(),
        },
      });
    }
    return true;
  }
  if (parsed.kind === SECRET_KINDS.USER_GOOGLE_SERVICES) {
    if (prisma.user?.updateMany) {
      await prisma.user.updateMany({
        where: { id: parsed.id },
        data: { googleServicesTokens: null },
      });
    }
    if (prisma.connectorAccount?.updateMany) {
      await prisma.connectorAccount.updateMany({
        where: { userId: parsed.id, provider: 'google_drive' },
        data: {
          tokenEncrypted: null,
          scopes: [],
          status: 'disconnected',
          lastHealthAt: new Date(),
        },
      });
    }
    return true;
  }
  return false;
}

async function fallbackSecretRef(prisma, userId, appId) {
  const store = require('./store');
  if (appId === 'github' && prisma.githubAccount?.findUnique) {
    const account = await prisma.githubAccount.findUnique({
      where: { userId: String(userId) },
      select: { id: true },
    });
    return account ? store.githubSecretRef(account.id) : null;
  }
  if ((appId === 'onedrive' || appId === 'google-drive') && prisma.connectorAccount?.findUnique) {
    const provider = appId === 'onedrive' ? 'onedrive' : 'google_drive';
    const account = await prisma.connectorAccount.findUnique({
      where: { userId_provider: { userId: String(userId), provider } },
      select: { id: true, tokenEncrypted: true },
    });
    if (account?.id) return store.connectorSecretRef(account.id);
    if (appId === 'google-drive' && prisma.user?.findUnique) {
      const user = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: { googleServicesTokens: true },
      });
      if (user?.googleServicesTokens) return store.userGoogleServicesSecretRef(userId);
    }
    return null;
  }
  if (['linkedin', 'x', 'facebook'].includes(appId) && prisma.socialConnection?.findUnique) {
    const social = await prisma.socialConnection.findUnique({
      where: { userId_platform: { userId: String(userId), platform: appId } },
      select: { id: true },
    });
    return social ? store.socialSecretRef(social.id) : null;
  }
  return null;
}

async function disconnectApp(prisma, {
  userId,
  appId,
  req = null,
  vault = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const app = getManifest(appId);
  if (!app) return { disconnected: false, reason: 'unknown_app' };
  let row = await findByUserAndApp(prisma, userId, appId);
  if (!row) {
    const ref = await fallbackSecretRef(prisma, userId, app.id);
    if (!ref) return { disconnected: true, reason: 'already_gone' };
    row = { id: null, secretRef: ref, appId: app.id };
  }

  let revoke = { attempted: false, ok: false };
  try {
    const opened = await openSecret(prisma, row.secretRef, vault);
    if (opened?.accessToken) {
      revoke = await revokeRemote({
        appId: app.id,
        accessToken: opened.accessToken,
        env,
        fetchImpl,
      });
    }
  } catch {
    revoke = { attempted: true, ok: false };
  }

  await deleteSourceSecret(prisma, row.secretRef);
  await deleteConnection(prisma, { userId, appId: app.id });
  await auditAppEvent(prisma, {
    userId,
    action: 'app_disconnected',
    appId: app.id,
    connectionId: row.id,
    req,
    metadata: { remoteRevoke: revoke.attempted, remoteRevokeOk: revoke.ok },
  });
  return { disconnected: true, remoteRevoke: revoke };
}

module.exports = {
  revokeRemote,
  deleteSourceSecret,
  disconnectApp,
};
