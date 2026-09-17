'use strict';

const { STATUSES, normalizeAppId } = require('./registry');
const { upsertConnection, findByUserAndApp, githubSecretRef, socialSecretRef, listByUser } = require('./store');

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
}) {
  const id = normalizeAppId(appId);
  if (!id || !userId || !sourceId) return null;
  const ref = id === 'github' ? githubSecretRef(sourceId) : socialSecretRef(sourceId);
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
}) {
  const id = normalizeAppId(appId);
  if (!id || !userId || !sourceId) return null;
  const existing = await findByUserAndApp(prisma, userId, id);
  const ref = id === 'github' ? githubSecretRef(sourceId) : socialSecretRef(sourceId);
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
  const [github, socials] = await Promise.all([
    prisma.githubAccount?.findUnique
      ? prisma.githubAccount.findUnique({ where: { userId: String(userId) } })
      : null,
    prisma.socialConnection?.findMany
      ? prisma.socialConnection.findMany({
        where: { userId: String(userId), platform: { in: ['linkedin', 'x'] } },
      })
      : [],
  ]);
  if (github?.id) {
    await linkExistingSource(prisma, {
      userId,
      appId: 'github',
      sourceId: github.id,
      accountLabel: github.login || github.name || null,
      scopes: github.scope,
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
    });
  }
  return listByUser(prisma, userId);
}

module.exports = {
  upsertFromOAuth,
  linkExistingSource,
  syncFromExisting,
};
