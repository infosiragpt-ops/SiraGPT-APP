'use strict';

const { getManifest, STATUSES } = require('./registry');
const { openSecret } = require('./vault');
const { findByUserAndApp, updateStatus } = require('./store');

const REQUEST_TIMEOUT_MS = 12_000;

function hasAllScopes(granted, required) {
  const have = new Set((granted || []).map((scope) => String(scope).toLowerCase()));
  return (required || []).every((scope) => have.has(String(scope).toLowerCase()));
}

function mapHttpStatus(status, granted, app) {
  if (status === 401) return STATUSES.REVOKED;
  if (status === 403) {
    if (app && !hasAllScopes(granted, app.minScopes)) return STATUSES.MISSING_SCOPES;
    return STATUSES.REVOKED;
  }
  if (status >= 500 || status === 429) return STATUSES.DEGRADED;
  if (status >= 400) return STATUSES.ERROR;
  if (app && !hasAllScopes(granted, app.minScopes)) return STATUSES.MISSING_SCOPES;
  return STATUSES.CONNECTED;
}

async function fetchWithTimeout(url, init, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function healthTarget(appId) {
  if (appId === 'github') {
    return {
      url: 'https://api.github.com/user',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'siraGPT-apps' },
    };
  }
  if (appId === 'linkedin') {
    return {
      url: 'https://api.linkedin.com/v2/userinfo',
      headers: { Accept: 'application/json' },
    };
  }
  if (appId === 'onedrive') {
    return {
      url: 'https://graph.microsoft.com/v1.0/me/drive',
      headers: { Accept: 'application/json' },
    };
  }
  if (appId === 'google-drive') {
    return {
      url: 'https://www.googleapis.com/drive/v3/about?fields=user',
      headers: { Accept: 'application/json' },
    };
  }
  return {
    url: 'https://api.x.com/2/users/me',
    headers: { Accept: 'application/json' },
  };
}

async function probeProvider({ appId, accessToken, scopes, fetchImpl }) {
  const app = getManifest(appId);
  const target = healthTarget(appId);
  const response = await fetchWithTimeout(target.url, {
    method: 'GET',
    headers: {
      ...target.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  }, fetchImpl);
  return {
    httpStatus: response.status,
    status: mapHttpStatus(response.status, scopes, app),
    ok: response.status >= 200 && response.status < 300,
  };
}

function classifyBundle(bundle, app) {
  if (!bundle?.accessToken) return { status: STATUSES.ERROR, lastError: 'missing_secret' };
  if (bundle.expiresAt && bundle.expiresAt < Date.now() && !bundle.refreshToken) {
    return { status: STATUSES.EXPIRED, lastError: 'token_expired' };
  }
  if (app && !hasAllScopes(bundle.scopes, app.minScopes)) {
    return { status: STATUSES.MISSING_SCOPES, lastError: 'missing_scopes' };
  }
  return { status: STATUSES.CONNECTED, lastError: null };
}

async function probeHealth(prisma, {
  userId,
  appId,
  vault = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const app = getManifest(appId);
  const row = await findByUserAndApp(prisma, userId, appId);
  if (!app || !row) {
    return { status: STATUSES.ERROR, connected: false, lastError: 'not_connected' };
  }
  const opened = await openSecret(prisma, row.secretRef, vault);
  if (!opened) {
    const updated = await updateStatus(prisma, {
      userId,
      appId,
      status: STATUSES.ERROR,
      lastError: 'secret_unreadable',
      lastHealthAt: now(),
    });
    return { ...updated, status: STATUSES.ERROR, connected: false, lastError: 'secret_unreadable' };
  }

  const local = classifyBundle(opened, app);
  if (local.status !== STATUSES.CONNECTED) {
    const updated = await updateStatus(prisma, {
      userId,
      appId,
      status: local.status,
      lastError: local.lastError,
      lastHealthAt: now(),
      scopes: opened.scopes,
      expiresAt: opened.expiresAt ? new Date(opened.expiresAt) : null,
    });
    return { ...updated, connected: false };
  }

  try {
    const probe = await probeProvider({
      appId: app.id,
      accessToken: opened.accessToken,
      scopes: opened.scopes,
      fetchImpl,
    });
    const stamp = now();
    const updated = await updateStatus(prisma, {
      userId,
      appId,
      status: probe.status,
      lastError: probe.ok ? null : `http_${probe.httpStatus}`,
      lastHealthAt: stamp,
      lastHealthOk: probe.ok ? stamp : row.lastHealthOk,
      scopes: opened.scopes,
      expiresAt: opened.expiresAt ? new Date(opened.expiresAt) : null,
    });
    return { ...updated, connected: probe.status === STATUSES.CONNECTED };
  } catch (error) {
    const updated = await updateStatus(prisma, {
      userId,
      appId,
      status: STATUSES.DEGRADED,
      lastError: error?.name === 'AbortError' ? 'health_timeout' : 'health_network',
      lastHealthAt: now(),
      scopes: opened.scopes,
    });
    return { ...updated, connected: false };
  }
}

module.exports = {
  hasAllScopes,
  mapHttpStatus,
  classifyBundle,
  probeHealth,
  healthTarget,
};
