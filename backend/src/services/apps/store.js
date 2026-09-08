'use strict';

const { STATUSES, normalizeAppId, secretRef, SECRET_KINDS } = require('./registry');

const PUBLIC_SELECT = Object.freeze({
  id: true,
  userId: true,
  organizationId: true,
  appId: true,
  status: true,
  scopes: true,
  expiresAt: true,
  lastHealthAt: true,
  lastHealthOk: true,
  lastError: true,
  secretRef: true,
  accountLabel: true,
  createdAt: true,
  updatedAt: true,
});

function publicConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    app: row.appId,
    connection_id: row.id,
    status: row.status,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    expiresAt: row.expiresAt || null,
    lastHealthAt: row.lastHealthAt || null,
    lastHealthOk: row.lastHealthOk || null,
    lastError: row.lastError || null,
    accountLabel: row.accountLabel || null,
    connected: row.status === STATUSES.CONNECTED,
  };
}

async function findByUserAndApp(prisma, userId, appId) {
  const id = normalizeAppId(appId);
  if (!prisma?.appConnection?.findUnique || !userId || !id) return null;
  return prisma.appConnection.findUnique({
    where: { userId_appId: { userId: String(userId), appId: id } },
    select: PUBLIC_SELECT,
  });
}

async function listByUser(prisma, userId) {
  if (!prisma?.appConnection?.findMany || !userId) return [];
  return prisma.appConnection.findMany({
    where: { userId: String(userId) },
    orderBy: { updatedAt: 'desc' },
    select: PUBLIC_SELECT,
  });
}

async function upsertConnection(prisma, {
  userId,
  organizationId = null,
  appId,
  status = STATUSES.CONNECTED,
  scopes = [],
  expiresAt = null,
  secretRef: ref,
  accountLabel = null,
  lastError = null,
  lastHealthAt = null,
  lastHealthOk = null,
  stampHealth = true,
}) {
  const id = normalizeAppId(appId);
  if (!prisma?.appConnection?.upsert || !userId || !id || !ref) return null;
  const now = new Date();
  const healthAt = stampHealth ? (lastHealthAt || now) : lastHealthAt;
  const healthOk = stampHealth
    ? (lastHealthOk || (status === STATUSES.CONNECTED ? healthAt : null))
    : lastHealthOk;
  const data = {
    organizationId: organizationId || null,
    status: String(status || STATUSES.ERROR),
    scopes: Array.isArray(scopes) ? scopes.map(String) : [],
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    secretRef: String(ref),
    accountLabel: accountLabel ? String(accountLabel).slice(0, 160) : null,
    lastError: lastError ? String(lastError).slice(0, 1000) : null,
    lastHealthAt: healthAt || null,
    lastHealthOk: healthOk || null,
  };
  return prisma.appConnection.upsert({
    where: { userId_appId: { userId: String(userId), appId: id } },
    create: { userId: String(userId), appId: id, ...data },
    update: data,
    select: PUBLIC_SELECT,
  });
}

async function updateStatus(prisma, { userId, appId, ...patch }) {
  const existing = await findByUserAndApp(prisma, userId, appId);
  if (!existing || !prisma?.appConnection?.update) return null;
  return prisma.appConnection.update({
    where: { id: existing.id },
    data: {
      ...patch,
      lastError: patch.lastError == null ? patch.lastError : String(patch.lastError).slice(0, 1000),
    },
    select: PUBLIC_SELECT,
  });
}

async function deleteConnection(prisma, { userId, appId }) {
  const existing = await findByUserAndApp(prisma, userId, appId);
  if (!existing || !prisma?.appConnection?.delete) return existing;
  await prisma.appConnection.delete({ where: { id: existing.id } });
  return existing;
}

function githubSecretRef(accountId) {
  return secretRef(SECRET_KINDS.GITHUB_ACCOUNT, accountId);
}

function socialSecretRef(connectionId) {
  return secretRef(SECRET_KINDS.SOCIAL_CONNECTION, connectionId);
}

module.exports = {
  PUBLIC_SELECT,
  publicConnection,
  findByUserAndApp,
  listByUser,
  upsertConnection,
  updateStatus,
  deleteConnection,
  githubSecretRef,
  socialSecretRef,
};
