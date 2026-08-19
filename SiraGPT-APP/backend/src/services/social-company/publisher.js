'use strict';

const crypto = require('node:crypto');
const { parseSafeOutboundUrl } = require('../../utils/url-ssrf-guard');
const { cleanPlatform, providerConfig } = require('./platforms');
const { openSocialTokens, sealSocialTokens } = require('./token-vault');

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SOCIAL_IMAGE_BYTES = 5 * 1024 * 1024;

function publicationError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function captionFor(post) {
  const value = String(post.caption || post.prompt || '').trim();
  if (!value) throw publicationError('SOCIAL_CONTENT_REQUIRED', 'Post content is required');
  return value;
}

function validRemoteImage(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function preparedMedia(value) {
  if (!value?.buffer) return null;
  const buffer = Buffer.isBuffer(value.buffer)
    ? value.buffer
    : Buffer.from(value.buffer);
  if (!buffer.length) return null;
  if (buffer.length > MAX_SOCIAL_IMAGE_BYTES) {
    throw publicationError(
      'SOCIAL_IMAGE_TOO_LARGE',
      'Social images must be 5 MB or smaller',
      422,
    );
  }
  const mime = String(value.mime || 'image/jpeg').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw publicationError(
      'SOCIAL_IMAGE_TYPE_UNSUPPORTED',
      'Social images must be JPEG, PNG, or WebP',
      422,
    );
  }
  return {
    buffer,
    mime,
    altText: String(value.altText || '').trim().slice(0, 120),
    generated: value.generated === true,
  };
}

async function fetchJson(url, init, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw publicationError('SOCIAL_FETCH_UNAVAILABLE', 'fetch is unavailable', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: init?.signal || controller.signal });
  } catch (error) {
    throw publicationError(
      error?.name === 'AbortError' ? 'SOCIAL_PROVIDER_TIMEOUT' : 'SOCIAL_PROVIDER_UNREACHABLE',
      error?.name === 'AbortError' ? 'Social provider request timed out' : 'Social provider is unavailable',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const providerMessage = typeof body.error === 'object'
      ? body.error.message || body.error.type
      : body.error_description || body.error;
    throw publicationError(
      'SOCIAL_PROVIDER_REJECTED',
      `Social provider rejected the post (HTTP ${response.status}${providerMessage ? `: ${String(providerMessage).slice(0, 180)}` : ''})`,
      response.status >= 500 ? 503 : 422,
    );
  }
  return { body, response };
}

async function fetchUpload(url, init, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw publicationError('SOCIAL_FETCH_UNAVAILABLE', 'fetch is unavailable', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: init?.signal || controller.signal });
  } catch (error) {
    throw publicationError(
      error?.name === 'AbortError' ? 'SOCIAL_PROVIDER_TIMEOUT' : 'SOCIAL_PROVIDER_UNREACHABLE',
      error?.name === 'AbortError' ? 'Social provider upload timed out' : 'Social provider upload is unavailable',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw publicationError(
      'SOCIAL_PROVIDER_REJECTED',
      `Social provider rejected the media upload (HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''})`,
      response.status >= 500 ? 503 : 422,
    );
  }
  return response;
}

function connectionTokens(connection, vault) {
  if (!connection?.accessToken) {
    throw publicationError('SOCIAL_CONNECTION_REQUIRED', 'A connected social account is required', 409);
  }
  const tokens = openSocialTokens(connection.accessToken, vault);
  if (!tokens?.accessToken) {
    throw publicationError('SOCIAL_CONNECTION_INVALID', 'The social connection must be reconnected', 409);
  }
  return tokens;
}

async function refreshConnectionTokens({
  platform,
  config,
  connection,
  tokens,
  prisma,
  vault,
  fetchImpl,
}) {
  if (!tokens.refreshToken || !['linkedin', 'x'].includes(platform)) {
    throw publicationError('SOCIAL_CONNECTION_EXPIRED', 'The social connection has expired', 409);
  }
  if (!prisma?.socialConnection?.update) {
    throw publicationError('SOCIAL_CONNECTION_EXPIRED', 'The social connection must be reconnected', 409);
  }
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (platform === 'x' && config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
    ...(platform === 'linkedin' && config.clientSecret ? { client_secret: config.clientSecret } : {}),
  });
  const result = await fetchJson(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
  }, fetchImpl);
  if (!result.body.access_token) {
    throw publicationError('SOCIAL_REFRESH_REJECTED', 'The social connection must be reconnected', 409);
  }
  const expiresAt = result.body.expires_in
    ? Date.now() + Number(result.body.expires_in) * 1_000
    : Date.now() + 60 * 60 * 1_000;
  const refreshed = {
    accessToken: String(result.body.access_token),
    refreshToken: String(result.body.refresh_token || tokens.refreshToken),
    tokenType: result.body.token_type || tokens.tokenType || 'Bearer',
    scope: result.body.scope || tokens.scope || config.scopes.join(' '),
    expiresAt,
  };
  await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: sealSocialTokens({
        ...refreshed,
        scopes: String(refreshed.scope).split(/\s+/).filter(Boolean),
      }, vault),
      refreshToken: null,
      expiresAt: new Date(expiresAt),
    },
  });
  return refreshed;
}

async function ensureConnectionTokens({
  platform,
  config,
  connection,
  prisma,
  vault,
  fetchImpl,
}) {
  const tokens = connectionTokens(connection, vault);
  if (!tokens.expiresAt || Number(tokens.expiresAt) > Date.now()) return tokens;
  return refreshConnectionTokens({
    platform,
    config,
    connection,
    tokens,
    prisma,
    vault,
    fetchImpl,
  });
}

async function publishFacebook({
  config,
  connection,
  post,
  accessToken,
  fetchImpl,
  media: mediaInput,
}) {
  if (!connection.accountId) {
    throw publicationError('SOCIAL_ACCOUNT_ID_REQUIRED', 'Facebook Page id is missing', 409);
  }
  const media = preparedMedia(mediaInput);
  const imageUrl = validRemoteImage(post.imageUrl);
  const endpoint = media || imageUrl
    ? `${config.apiBase}/${encodeURIComponent(connection.accountId)}/photos`
    : `${config.apiBase}/${encodeURIComponent(connection.accountId)}/feed`;
  let body;
  let headers;
  if (media) {
    body = new FormData();
    body.set('access_token', accessToken);
    body.set('caption', captionFor(post));
    body.set(
      'source',
      new Blob([media.buffer], { type: media.mime }),
      media.mime === 'image/png' ? 'siragpt-social.png' : 'siragpt-social.jpg',
    );
    headers = { Accept: 'application/json' };
  } else {
    body = new URLSearchParams({
      access_token: accessToken,
      ...(imageUrl ? { url: imageUrl, caption: captionFor(post) } : { message: captionFor(post) }),
    });
    headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  const result = await fetchJson(endpoint, {
    method: 'POST',
    headers,
    body,
  }, fetchImpl);
  return {
    externalId: String(result.body.post_id || result.body.id || ''),
    media: media
      ? (media.generated ? 'generated_image' : 'uploaded_image')
      : imageUrl ? 'remote_image' : 'text',
  };
}

async function publishLinkedIn({
  config,
  connection,
  post,
  accessToken,
  fetchImpl,
  idempotencyKey,
  media: mediaInput,
}) {
  if (!connection.accountId) {
    throw publicationError('SOCIAL_ACCOUNT_ID_REQUIRED', 'LinkedIn account id is missing', 409);
  }
  const media = preparedMedia(mediaInput);
  const commonHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Linkedin-Version': config.apiVersion,
    'X-Restli-Protocol-Version': '2.0.0',
  };
  let imageUrn = null;
  if (media) {
    const initialized = await fetchJson(`${config.apiBase}/rest/images?action=initializeUpload`, {
      method: 'POST',
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: `urn:li:person:${connection.accountId}`,
        },
      }),
    }, fetchImpl);
    const uploadUrl = initialized.body.value?.uploadUrl
      ? parseSafeOutboundUrl(initialized.body.value.uploadUrl, {
        allowHosts: ['linkedin.com'],
      }).toString()
      : null;
    imageUrn = initialized.body.value?.image;
    if (!uploadUrl || !imageUrn) {
      throw publicationError(
        'SOCIAL_LINKEDIN_IMAGE_INITIALIZATION_FAILED',
        'LinkedIn returned no image upload target',
        503,
      );
    }
    await fetchUpload(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': media.mime,
      },
      body: media.buffer,
    }, fetchImpl);
  }
  const result = await fetchJson(`${config.apiBase}/rest/posts`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
      'X-RestLi-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      author: `urn:li:person:${connection.accountId}`,
      commentary: captionFor(post),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(imageUrn ? {
        content: {
          media: {
            id: imageUrn,
            altText: media.altText || 'Imagen generada por SiraGPT',
          },
        },
      } : {}),
    }),
  }, fetchImpl);
  return {
    externalId: String(
      result.response.headers?.get?.('x-restli-id')
      || result.response.headers?.get?.('x-linkedin-id')
      || result.body.id
      || '',
    ),
    media: media
      ? (media.generated ? 'generated_image' : 'uploaded_image')
      : 'text',
    mediaOmitted: Boolean(post.imageUrl) && !media,
  };
}

async function publishX({
  config,
  post,
  accessToken,
  fetchImpl,
  idempotencyKey,
  media: mediaInput,
}) {
  const text = captionFor(post);
  if (Array.from(text).length > 280) {
    throw publicationError('SOCIAL_X_TEXT_TOO_LONG', 'X posts are limited to 280 characters', 422);
  }
  const media = preparedMedia(mediaInput);
  let mediaId = null;
  if (media) {
    const uploaded = await fetchJson(`${config.apiBase}/2/media/upload`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        media: media.buffer.toString('base64'),
        media_category: 'tweet_image',
        media_type: media.mime,
        shared: false,
      }),
    }, fetchImpl);
    mediaId = String(uploaded.body.data?.id || '');
    if (!mediaId) {
      throw publicationError(
        'SOCIAL_X_IMAGE_UPLOAD_FAILED',
        'X returned no media id',
        503,
      );
    }
  }
  const result = await fetchJson(`${config.apiBase}/2/tweets`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      text,
      ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
    }),
  }, fetchImpl);
  return {
    externalId: String(result.body.data?.id || ''),
    media: media
      ? (media.generated ? 'generated_image' : 'uploaded_image')
      : 'text',
    mediaOmitted: Boolean(post.imageUrl) && !media,
  };
}

async function publishPostToPlatform({
  platform: platformValue,
  connection,
  post,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = null,
  prisma = null,
  media = null,
} = {}) {
  const platform = cleanPlatform(platformValue);
  const config = providerConfig(platform, env);
  if (!platform || !config) throw publicationError('SOCIAL_PLATFORM_UNSUPPORTED', 'Unsupported social platform', 400);
  const tokens = await ensureConnectionTokens({
    platform,
    config,
    connection,
    prisma,
    vault,
    fetchImpl,
  });
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`siragpt-social:${post.id}:${platform}`)
    .digest('hex');
  const input = {
    config,
    connection,
    post,
    accessToken: tokens.accessToken,
    fetchImpl,
    idempotencyKey,
    media,
  };
  let result;
  if (platform === 'facebook') result = await publishFacebook(input);
  else if (platform === 'linkedin') result = await publishLinkedIn(input);
  else result = await publishX(input);
  return {
    platform,
    idempotencyKey,
    publishedAt: new Date().toISOString(),
    ...result,
  };
}

module.exports = {
  publishPostToPlatform,
  publicationError,
  validRemoteImage,
  _internal: {
    captionFor,
    connectionTokens,
    ensureConnectionTokens,
    fetchJson,
    fetchUpload,
    preparedMedia,
    publishFacebook,
    publishLinkedIn,
    publishX,
    refreshConnectionTokens,
  },
};
