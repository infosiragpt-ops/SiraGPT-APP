'use strict';

const crypto = require('node:crypto');
const { signOAuthState, verifyOAuthState } = require('../oauth-state');
const { providerConfig } = require('./platforms');
const { sealSocialTokens } = require('./token-vault');

const REQUEST_TIMEOUT_MS = 15_000;

function serviceName(platform) {
  return `social_${platform}`;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function fetchWithTimeout(url, init = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Social OAuth requires fetch');
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
  platform,
  env = process.env,
  signState = signOAuthState,
} = {}) {
  const config = providerConfig(platform, env);
  if (!config || !config.configured) {
    const error = new Error('Social OAuth provider is not configured');
    error.code = 'SOCIAL_PROVIDER_NOT_CONFIGURED';
    throw error;
  }

  const pkce = config.id === 'x' ? createPkce() : null;
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
    scope: config.id === 'facebook' ? config.scopes.join(',') : config.scopes.join(' '),
  });
  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', 'S256');
  }
  return {
    platform: config.id,
    url: `${config.authorizeUrl}?${params.toString()}`,
  };
}

async function exchangeFacebook(config, code, fetchImpl) {
  const url = new URL(config.tokenUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  }).toString();
  const response = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' },
  }, fetchImpl);
  const data = await parseProviderResponse(response, 'Facebook token exchange');
  if (!data.access_token) throw new Error('Facebook token exchange returned no access token');

  const pagesUrl = new URL(`${config.apiBase}/me/accounts`);
  pagesUrl.searchParams.set('fields', 'id,name,access_token,picture{url}');
  pagesUrl.searchParams.set('access_token', data.access_token);
  const pagesResponse = await fetchWithTimeout(pagesUrl, {
    headers: { Accept: 'application/json' },
  }, fetchImpl);
  const pages = await parseProviderResponse(pagesResponse, 'Facebook Page lookup');
  const page = Array.isArray(pages.data)
    ? pages.data.find((candidate) => candidate?.id && candidate?.access_token)
    : null;
  if (!page) {
    const error = new Error('No Facebook Page with publishing access was found');
    error.code = 'SOCIAL_FACEBOOK_PAGE_REQUIRED';
    throw error;
  }
  return {
    accountId: String(page.id),
    accountName: String(page.name || 'Facebook Page'),
    profile: {
      status: 'connected',
      kind: 'page',
      avatarUrl: page.picture?.data?.url || null,
      availablePageCount: Array.isArray(pages.data) ? pages.data.length : 1,
    },
    accessToken: String(page.access_token),
    refreshToken: null,
    tokenType: data.token_type || 'Bearer',
    scopes: config.scopes,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

async function exchangeLinkedIn(config, code, fetchImpl) {
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
  const data = await parseProviderResponse(response, 'LinkedIn token exchange');
  if (!data.access_token) throw new Error('LinkedIn token exchange returned no access token');

  const profileResponse = await fetchWithTimeout(`${config.apiBase}/v2/userinfo`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${data.access_token}`,
    },
  }, fetchImpl);
  const profile = await parseProviderResponse(profileResponse, 'LinkedIn profile lookup');
  if (!profile.sub) throw new Error('LinkedIn profile returned no account id');
  return {
    accountId: String(profile.sub),
    accountName: String(profile.name || profile.email || 'LinkedIn'),
    profile: {
      status: 'connected',
      kind: 'person',
      avatarUrl: profile.picture || null,
      locale: profile.locale || null,
    },
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || 'Bearer',
    scopes: String(data.scope || config.scopes.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

async function exchangeX(config, code, context, fetchImpl) {
  const codeVerifier = String(context?.codeVerifier || '');
  if (!codeVerifier) throw new Error('X OAuth PKCE verifier is missing or expired');
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }
  const response = await fetchWithTimeout(config.tokenUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
      client_id: config.clientId,
    }),
  }, fetchImpl);
  const data = await parseProviderResponse(response, 'X token exchange');
  if (!data.access_token) throw new Error('X token exchange returned no access token');

  const profileResponse = await fetchWithTimeout(
    `${config.apiBase}/2/users/me?user.fields=profile_image_url,description,url,username,name`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${data.access_token}`,
      },
    },
    fetchImpl,
  );
  const profileBody = await parseProviderResponse(profileResponse, 'X profile lookup');
  const profile = profileBody.data || {};
  if (!profile.id) throw new Error('X profile returned no account id');
  return {
    accountId: String(profile.id),
    accountName: profile.username ? `@${profile.username}` : String(profile.name || 'X'),
    profile: {
      status: 'connected',
      kind: 'person',
      username: profile.username || null,
      name: profile.name || null,
      avatarUrl: profile.profile_image_url || null,
      description: profile.description || null,
    },
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || 'Bearer',
    scopes: String(data.scope || config.scopes.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : null,
  };
}

async function completeAuthorization({
  platform,
  code,
  state,
  prisma,
  env = process.env,
  fetchImpl = globalThis.fetch,
  verifyState = verifyOAuthState,
  vault = null,
} = {}) {
  const config = providerConfig(platform, env);
  if (!config || !config.configured) {
    const error = new Error('Social OAuth provider is not configured');
    error.code = 'SOCIAL_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  const verified = await verifyState(state, {
    service: serviceName(config.id),
    redirectUri: config.redirectUri,
  });
  let tokens;
  if (config.id === 'facebook') tokens = await exchangeFacebook(config, code, fetchImpl);
  else if (config.id === 'linkedin') tokens = await exchangeLinkedIn(config, code, fetchImpl);
  else tokens = await exchangeX(config, code, verified.context, fetchImpl);

  const encryptedTokens = sealSocialTokens(tokens, vault);
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
  return { userId: verified.userId, platform: config.id, connection };
}

module.exports = {
  beginAuthorization,
  completeAuthorization,
  createPkce,
  serviceName,
  _internal: {
    exchangeFacebook,
    exchangeLinkedIn,
    exchangeX,
    fetchWithTimeout,
  },
};
