'use strict';

const crypto = require('node:crypto');
const { getFrontendUrl, resolvePublicBackendUrl } = require('../../config/oauth-url-policy');
const { normalizeAppId, getManifest } = require('./registry');
const { upsertFromOAuth } = require('./sync');

function defaultSignState(...args) {
  // eslint-disable-next-line global-require
  return require('../oauth-state').signOAuthState(...args);
}

function defaultVerifyState(...args) {
  // eslint-disable-next-line global-require
  return require('../oauth-state').verifyOAuthState(...args);
}

function sealTokens(tokens, vault) {
  // eslint-disable-next-line global-require
  return require('../social-company/token-vault').sealSocialTokens(tokens, vault);
}

const FILE_APP_IDS = Object.freeze(['onedrive', 'google-drive']);
const REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_ONEDRIVE_SCOPES = Object.freeze(['Files.ReadWrite', 'offline_access', 'User.Read']);
const DEFAULT_GDRIVE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
]);

function envValue(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function splitScopes(value, fallback) {
  const raw = String(value || '').trim();
  const source = raw || (Array.isArray(fallback) ? fallback.join(' ') : String(fallback || ''));
  return source.split(/[,\s]+/).filter(Boolean);
}

function notConfigured(appId) {
  const app = getManifest(appId);
  const error = new Error(`Faltan las credenciales OAuth en el servidor para ${app?.name || appId}.`);
  error.code = 'APP_PROVIDER_NOT_CONFIGURED';
  error.status = 503;
  return error;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function callbackPath(appId) {
  return `/api/apps/oauth/${appId}/callback`;
}

function callbackUrl(appId, env = process.env) {
  return `${resolvePublicBackendUrl(env)}${callbackPath(appId)}`;
}

function postCallbackUrl(appId, status, env = process.env) {
  const url = new URL('/conexiones', getFrontendUrl(env));
  url.searchParams.set('app', appId);
  url.searchParams.set('oauth', String(status || 'error'));
  return url.toString();
}

function serviceName(appId) {
  return `app_${appId}`;
}

function providerConfig(appIdValue, env = process.env) {
  const appId = normalizeAppId(appIdValue);
  if (!FILE_APP_IDS.includes(appId)) return null;

  if (appId === 'onedrive') {
    const clientId = envValue(env, 'ONEDRIVE_CLIENT_ID', 'MICROSOFT_CLIENT_ID');
    const clientSecret = envValue(env, 'ONEDRIVE_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET');
    const tenant = envValue(env, 'MICROSOFT_TENANT', 'ONEDRIVE_TENANT') || 'consumers';
    return {
      id: appId,
      label: 'OneDrive',
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
      pkce: true,
      tenant,
      redirectUri: callbackUrl(appId, env),
      authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      apiBase: 'https://graph.microsoft.com/v1.0',
      scopes: splitScopes(envValue(env, 'ONEDRIVE_SCOPES', 'MICROSOFT_SCOPES'), DEFAULT_ONEDRIVE_SCOPES),
    };
  }

  const clientId = envValue(env, 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_CLIENT_ID');
  const clientSecret = envValue(env, 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET');
  return {
    id: appId,
    label: 'Google Drive',
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    pkce: false,
    redirectUri: callbackUrl(appId, env),
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiBase: 'https://www.googleapis.com/drive/v3',
    scopes: splitScopes(envValue(env, 'GOOGLE_DRIVE_SCOPES'), DEFAULT_GDRIVE_SCOPES),
  };
}

async function fetchWithTimeout(url, init = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Apps OAuth requires fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseProviderResponse(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const providerError = typeof body.error === 'object'
      ? body.error.message || body.error.type
      : body.error_description || body.error;
    throw new Error(`${label} failed (HTTP ${response.status}${providerError ? `: ${providerError}` : ''})`);
  }
  return body;
}

async function beginAuthorization({
  userId,
  appId,
  env = process.env,
  signState = defaultSignState,
} = {}) {
  const config = providerConfig(appId, env);
  if (!config) {
    const error = new Error('App OAuth desconocida');
    error.code = 'APP_UNKNOWN';
    error.status = 400;
    throw error;
  }
  if (!config.configured) throw notConfigured(config.id);

  const pkce = config.pkce ? createPkce() : null;
  const state = await signState({
    userId,
    service: serviceName(config.id),
    redirectUri: config.redirectUri,
    ...(pkce ? { context: { codeVerifier: pkce.verifier } } : {}),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: config.scopes.join(' '),
  });
  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', 'S256');
  }
  if (config.id === 'google-drive') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'false');
  }
  if (config.id === 'onedrive') {
    params.set('response_mode', 'query');
  }
  return {
    app: config.id,
    url: `${config.authorizeUrl}?${params.toString()}`,
  };
}

async function exchangeMicrosoft(config, code, context, fetchImpl) {
  const codeVerifier = String(context?.codeVerifier || '');
  if (!codeVerifier) throw new Error('OneDrive OAuth PKCE verifier is missing or expired');
  const response = await fetchWithTimeout(config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: codeVerifier,
      scope: config.scopes.join(' '),
    }),
  }, fetchImpl);
  const data = await parseProviderResponse(response, 'OneDrive token exchange');
  if (!data.access_token) throw new Error('OneDrive token exchange returned no access token');

  const profileResponse = await fetchWithTimeout(`${config.apiBase}/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${data.access_token}` },
  }, fetchImpl);
  const profile = await parseProviderResponse(profileResponse, 'OneDrive profile lookup');
  await fetchWithTimeout(`${config.apiBase}/me/drive`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${data.access_token}` },
  }, fetchImpl).catch(() => null);

  return {
    accountId: String(profile.id || profile.userPrincipalName || 'onedrive'),
    accountName: String(profile.displayName || profile.userPrincipalName || profile.mail || 'OneDrive'),
    profile: {
      status: 'connected',
      kind: 'person',
      email: profile.mail || profile.userPrincipalName || null,
    },
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || 'Bearer',
    scopes: String(data.scope || config.scopes.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

async function exchangeGoogleDrive(config, code, fetchImpl) {
  const response = await fetchWithTimeout(config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  }, fetchImpl);
  const data = await parseProviderResponse(response, 'Google Drive token exchange');
  if (!data.access_token) throw new Error('Google Drive token exchange returned no access token');

  const aboutResponse = await fetchWithTimeout(`${config.apiBase}/about?fields=user`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${data.access_token}` },
  }, fetchImpl);
  const about = await parseProviderResponse(aboutResponse, 'Google Drive about');
  const user = about.user || {};
  return {
    accountId: String(user.permissionId || user.emailAddress || 'google-drive'),
    accountName: String(user.displayName || user.emailAddress || 'Google Drive'),
    profile: {
      status: 'connected',
      kind: 'person',
      email: user.emailAddress || null,
    },
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || 'Bearer',
    scopes: String(data.scope || config.scopes.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

async function completeAuthorization({
  appId,
  code,
  state,
  prisma,
  env = process.env,
  fetchImpl = globalThis.fetch,
  verifyState = defaultVerifyState,
  vault = null,
} = {}) {
  const config = providerConfig(appId, env);
  if (!config || !config.configured) throw notConfigured(appId);
  const verified = await verifyState(state, {
    service: serviceName(config.id),
    redirectUri: config.redirectUri,
  });
  const tokens = config.id === 'onedrive'
    ? await exchangeMicrosoft(config, code, verified.context, fetchImpl)
    : await exchangeGoogleDrive(config, code, fetchImpl);

  const encryptedTokens = sealTokens(tokens, vault);
  const connection = await prisma.socialConnection.upsert({
    where: { userId_platform: { userId: verified.userId, platform: config.id } },
    create: {
      userId: verified.userId,
      platform: config.id,
      accountId: tokens.accountId,
      accountName: tokens.accountName,
      accessToken: encryptedTokens,
      refreshToken: null,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      profile: tokens.profile,
      scopes: tokens.scopes,
    },
    update: {
      accountId: tokens.accountId,
      accountName: tokens.accountName,
      accessToken: encryptedTokens,
      refreshToken: null,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      profile: tokens.profile,
      scopes: tokens.scopes,
    },
  });
  await upsertFromOAuth(prisma, {
    userId: verified.userId,
    appId: config.id,
    sourceId: connection.id,
    accountLabel: connection.accountName || null,
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
  });
  return { userId: verified.userId, app: config.id, connection };
}

async function refreshAccessToken({
  appId,
  refreshToken,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = providerConfig(appId, env);
  if (!config?.configured || !refreshToken) return null;
  const response = await fetchWithTimeout(config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  }, fetchImpl);
  const data = await parseProviderResponse(response, `${config.label} refresh`);
  if (!data.access_token) return null;
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token || refreshToken,
    tokenType: data.token_type || 'Bearer',
    scopes: String(data.scope || config.scopes.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

module.exports = {
  FILE_APP_IDS,
  DEFAULT_ONEDRIVE_SCOPES,
  DEFAULT_GDRIVE_SCOPES,
  providerConfig,
  callbackUrl,
  postCallbackUrl,
  beginAuthorization,
  completeAuthorization,
  refreshAccessToken,
  notConfigured,
  createPkce,
};
