'use strict';

const { encrypt } = require('../../utils/encryption');
const { appendAudit } = require('./control-plane');

const CONNECTORS = Object.freeze([
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'communication',
    authType: 'oauth2',
    capabilities: ['read_email', 'draft_email', 'send_email'],
    connectUrl: '/api/auth/gmail',
    writeTier: 'confirm',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    category: 'files',
    authType: 'oauth2',
    capabilities: ['search_files', 'read_files', 'create_files', 'update_files'],
    connectUrl: '/api/auth/google-services',
    writeTier: 'confirm',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge',
    authType: 'mcp',
    capabilities: ['search_pages', 'read_pages', 'create_pages', 'update_pages'],
    connectUrl: '/settings?s=apps&provider=notion',
    writeTier: 'confirm',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    authType: 'oauth2_or_webhook',
    capabilities: ['read_channels', 'search_messages', 'post_message'],
    connectUrl: '/settings?s=apps&provider=slack',
    writeTier: 'confirm',
  },
]);

function catalogById(provider) {
  return CONNECTORS.find((connector) => connector.id === String(provider || '')) || null;
}

async function listConnectors(prisma, userId) {
  const [accounts, legacy] = await Promise.all([
    prisma.connectorAccount.findMany({
      where: { userId: String(userId) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        provider: true,
        accountLabel: true,
        authType: true,
        scopes: true,
        status: true,
        lastHealthAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: String(userId) },
      select: { gmailTokens: true, googleServicesTokens: true },
    }),
  ]);
  const byProvider = new Map(accounts.map((account) => [account.provider, account]));
  if (!byProvider.has('gmail') && legacy?.gmailTokens) {
    byProvider.set('gmail', {
      id: 'legacy:gmail',
      provider: 'gmail',
      accountLabel: 'Cuenta de Google',
      authType: 'oauth2',
      scopes: [],
      status: 'connected',
      lastHealthAt: null,
      lastError: null,
      createdAt: null,
      updatedAt: null,
      legacy: true,
    });
  }
  if (!byProvider.has('google_drive') && legacy?.googleServicesTokens) {
    byProvider.set('google_drive', {
      id: 'legacy:google_drive',
      provider: 'google_drive',
      accountLabel: 'Cuenta de Google',
      authType: 'oauth2',
      scopes: [],
      status: 'connected',
      lastHealthAt: null,
      lastError: null,
      createdAt: null,
      updatedAt: null,
      legacy: true,
    });
  }
  return CONNECTORS.map((connector) => ({
    ...connector,
    account: byProvider.get(connector.id) || null,
  }));
}

async function upsertConnector(prisma, {
  userId,
  provider,
  accountLabel = null,
  scopes = [],
  token = null,
  config = null,
}) {
  const connector = catalogById(provider);
  if (!connector) {
    const error = new Error('Unsupported connector provider.');
    error.code = 'connector_provider_invalid';
    error.status = 400;
    throw error;
  }
  const tokenEncrypted = token ? encrypt(JSON.stringify(token)) : undefined;
  const configEncrypted = config && typeof config === 'object'
    ? encrypt(JSON.stringify(config))
    : undefined;
  const data = {
    accountLabel: accountLabel ? String(accountLabel).slice(0, 160) : null,
    authType: connector.authType,
    scopes: Array.isArray(scopes) ? scopes.map(String).slice(0, 100) : [],
    status: token || connector.authType === 'mcp' ? 'connected' : 'disconnected',
    lastHealthAt: new Date(),
    lastError: null,
    ...(tokenEncrypted ? { tokenEncrypted } : {}),
    ...(configEncrypted ? { configEncrypted } : {}),
  };
  const account = await prisma.connectorAccount.upsert({
    where: { userId_provider: { userId: String(userId), provider: connector.id } },
    create: {
      userId: String(userId),
      provider: connector.id,
      ...data,
    },
    update: data,
  });
  await appendAudit(prisma, {
    userId,
    action: 'cowork.connector.updated',
    targetType: 'connector_account',
    targetId: account.id,
    metadata: { provider: connector.id, status: account.status },
  });
  return {
    id: account.id,
    provider: account.provider,
    accountLabel: account.accountLabel,
    scopes: account.scopes,
    status: account.status,
    lastHealthAt: account.lastHealthAt,
  };
}

async function disconnectConnector(prisma, { userId, provider }) {
  const connector = catalogById(provider);
  if (!connector) return false;
  if (connector.id === 'gmail') {
    await prisma.user.updateMany({
      where: { id: String(userId) },
      data: { gmailTokens: null },
    });
  }
  if (connector.id === 'google_drive') {
    await prisma.user.updateMany({
      where: { id: String(userId) },
      data: { googleServicesTokens: null },
    });
  }
  const existing = await prisma.connectorAccount.findUnique({
    where: { userId_provider: { userId: String(userId), provider: connector.id } },
  });
  if (!existing) return ['gmail', 'google_drive'].includes(connector.id);
  await prisma.connectorAccount.update({
    where: { id: existing.id },
    data: {
      tokenEncrypted: null,
      configEncrypted: null,
      scopes: [],
      status: 'disconnected',
      lastHealthAt: new Date(),
    },
  });
  await appendAudit(prisma, {
    userId,
    action: 'cowork.connector.disconnected',
    targetType: 'connector_account',
    targetId: existing.id,
    metadata: { provider: connector.id },
  });
  return true;
}

module.exports = {
  CONNECTORS,
  catalogById,
  listConnectors,
  upsertConnector,
  disconnectConnector,
};
