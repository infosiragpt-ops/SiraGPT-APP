'use strict';

const { getFrontendUrl, resolvePublicBackendUrl } = require('../../config/oauth-url-policy');

const PLATFORM_IDS = Object.freeze(['facebook', 'linkedin', 'x']);
const PLATFORM_SET = new Set(PLATFORM_IDS);

function cleanPlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'twitter') return 'x';
  return PLATFORM_SET.has(normalized) ? normalized : null;
}

function envValue(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function callbackUrl(platform, env = process.env) {
  return `${resolvePublicBackendUrl(env)}/api/social-posts/oauth/${platform}/callback`;
}

function postCallbackUrl(platform, status, env = process.env) {
  const url = new URL('/code', getFrontendUrl(env));
  url.searchParams.set('companyView', 'resources');
  url.searchParams.set('social', String(status || 'error'));
  url.searchParams.set('platform', platform);
  return url.toString();
}

function providerConfig(platformValue, env = process.env) {
  const platform = cleanPlatform(platformValue);
  if (!platform) return null;

  if (platform === 'facebook') {
    const clientId = envValue(env, 'SOCIAL_FACEBOOK_CLIENT_ID', 'FACEBOOK_APP_ID');
    const clientSecret = envValue(env, 'SOCIAL_FACEBOOK_CLIENT_SECRET', 'FACEBOOK_APP_SECRET');
    const apiVersion = envValue(env, 'SOCIAL_FACEBOOK_API_VERSION') || 'v23.0';
    return {
      id: platform,
      label: 'Facebook',
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
      redirectUri: callbackUrl(platform, env),
      authorizeUrl: `https://www.facebook.com/${apiVersion}/dialog/oauth`,
      tokenUrl: `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
      apiBase: `https://graph.facebook.com/${apiVersion}`,
      scopes: (envValue(env, 'SOCIAL_FACEBOOK_SCOPES')
        || 'pages_show_list,pages_read_engagement,pages_manage_posts')
        .split(/[,\s]+/)
        .filter(Boolean),
    };
  }

  if (platform === 'linkedin') {
    const clientId = envValue(env, 'SOCIAL_LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_ID');
    const clientSecret = envValue(env, 'SOCIAL_LINKEDIN_CLIENT_SECRET', 'LINKEDIN_CLIENT_SECRET');
    return {
      id: platform,
      label: 'LinkedIn',
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
      redirectUri: callbackUrl(platform, env),
      authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      apiBase: 'https://api.linkedin.com',
      apiVersion: envValue(env, 'SOCIAL_LINKEDIN_API_VERSION') || '202607',
      scopes: (envValue(env, 'SOCIAL_LINKEDIN_SCOPES') || 'openid profile w_member_social')
        .split(/\s+/)
        .filter(Boolean),
    };
  }

  const clientId = envValue(env, 'SOCIAL_X_CLIENT_ID', 'X_CLIENT_ID', 'TWITTER_CLIENT_ID');
  const clientSecret = envValue(
    env,
    'SOCIAL_X_CLIENT_SECRET',
    'X_CLIENT_SECRET',
    'TWITTER_CLIENT_SECRET',
  );
  return {
    id: platform,
    label: 'X',
    clientId,
    clientSecret,
    configured: Boolean(clientId),
    redirectUri: callbackUrl(platform, env),
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    apiBase: 'https://api.x.com',
    scopes: (envValue(env, 'SOCIAL_X_SCOPES') || 'tweet.read tweet.write users.read media.write offline.access')
      .split(/\s+/)
      .filter(Boolean),
  };
}

function publicProviderStatus(platform, env = process.env) {
  const config = providerConfig(platform, env);
  if (!config) return null;
  return {
    platform: config.id,
    label: config.label,
    configured: config.configured,
    scopes: config.scopes,
    supports: {
      text: true,
      remoteImage: config.id === 'facebook',
      generatedImage: true,
    },
  };
}

module.exports = {
  PLATFORM_IDS,
  cleanPlatform,
  callbackUrl,
  postCallbackUrl,
  providerConfig,
  publicProviderStatus,
};
