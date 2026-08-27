'use strict';

const { STATUSES, normalizeAppId, SECRET_KINDS } = require('./registry');
const { upsertConnection, findByUserAndApp, secretRefFor, listByUser } = require('./store');

const SOCIAL_PLATFORMS = Object.freeze(['linkedin', 'x']);
const CONNECTOR_PROVIDERS = Object.freeze({
  onedrive: 'onedrive',
  google_drive: 'google-drive',
});

function asScopes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || '').split(/[,\s]+/).filter(Boolean);
}

async function upsertFromOAuth(prisma, {
  userId,
  appId,
  sourceId,
  accountLabel = null,
  scopes = [],
  expiresAt = null,
  organizationId = null,
  secretKind = null,
}) {
  const id = normalizeAppId(appId);
  if (!id || !userId || !sourceId) return null;
  const ref = secretRefFor(id, sourceId, secretKind);
  return upsertConnection(prisma, {
    userId,
    organizationId,
    appId: id,
    status: STATUSES.CONNECTED,
    scopes: asScopes(scopes),
    expiresAt,
    secretRef: ref,
    accountLabel,
    lastError: null,
    lastHealthAt: new Date(),
    lastHealthOk: new Date(),
    stampHealth: true,
  });
}

async function linkExistingSource(prisma, {
  userId,
  appId,
  sourceId,
  accountLabel = null,
  scopes = [],
  expiresAt = null,
  secretKind = null,
}) {
  const id = normalizeAppId(appId);
  if (!id || !userId || !sourceId) return null;
  const existing = await findByUserAndApp(prisma, userId, id);
  const ref = secretRefFor(id, sourceId, secretKind);
  return upsertConnection(prisma, {
    userId,
    appId: id,
    status: existing?.status || STATUSES.ERROR,
    scopes: asScopes(scopes).length ? asScopes(scopes) : existing?.scopes || [],
    expiresAt: expiresAt || existing?.expiresAt || null,
    secretRef: ref,
    accountLabel: accountLabel || existing?.accountLabel || null,
    lastError: existing?.lastError || 'pending_health',
    lastHealthAt: existing?.lastHealthAt || null,
    lastHealthOk: existing?.lastHealthOk || null,
    stampHealth: false,
  });
}

async function syncFromExisting(prisma, userId) {
  if (!prisma || !userId) return [];
  const [github, socials, connectors, user] = await Promise.all([
    prisma.githubAccount?.findUnique
      ? prisma.githubAccount.findUnique({ where: { userId: String(userId) } })
      : null,
    prisma.socialConnection?.findMany
      ? prisma.socialConnection.findMany({
        where: { userId: String(userId), platform: { in: [...SOCIAL_PLATFORMS] } },
      })
      : [],
    prisma.connectorAccount?.findMany
      ? prisma.connectorAccount.findMany({
        where: {
          userId: String(userId),
          provider: { in: Object.keys(CONNECTOR_PROVIDERS) },
        },
      })
      : [],
    prisma.user?.findUnique
      ? prisma.user.findUnique({
        where: { id: String(userId) },
        select: { id: true, googleServicesTokens: true },
      })
      : null,
  ]);
  if (github?.id) {
    await linkExistingSource(prisma, {
      userId,
      appId: 'github',
      sourceId: github.id,
      accountLabel: github.login || github.name || null,
      scopes: github.scope,
      secretKind: SECRET_KINDS.GITHUB_ACCOUNT,
    });
  }
  for (const row of socials || []) {
    await linkExistingSource(prisma, {
      userId,
      appId: row.platform,
      sourceId: row.id,
      accountLabel: row.accountName || null,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      secretKind: SECRET_KINDS.SOCIAL_CONNECTION,
    });
  }
  let linkedGoogleDrive = false;
  for (const row of connectors || []) {
    const appId = CONNECTOR_PROVIDERS[row.provider];
    if (!appId || !row.id || !row.tokenEncrypted) continue;
    if (appId === 'google-drive') linkedGoogleDrive = true;
    await linkExistingSource(prisma, {
      userId,
      appId,
      sourceId: row.id,
      accountLabel: row.accountLabel || null,
      scopes: row.scopes,
      secretKind: SECRET_KINDS.CONNECTOR_ACCOUNT,
    });
  }
  if (!linkedGoogleDrive && user?.googleServicesTokens) {
    await linkExistingSource(prisma, {
      userId,
      appId: 'google-drive',
      sourceId: user.id,
      accountLabel: 'Google Drive',
      secretKind: SECRET_KINDS.USER_GOOGLE_SERVICES,
    });
  }
  return listByUser(prisma, userId);
}

module.exports = {
  upsertFromOAuth,
  linkExistingSource,
  syncFromExisting,
};
