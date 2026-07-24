'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publishPostToPlatform } = require('../src/services/social-company/publisher');

const vault = {
  openProviderTokens: () => ({
    accessToken: 'encrypted-opened-token',
    expiresAt: Date.now() + 60_000,
  }),
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test('publisher sends an X post with user Bearer token and stable idempotency key', async () => {
  let captured;
  const result = await publishPostToPlatform({
    platform: 'x',
    connection: { accessToken: 'sealed', accountId: 'x-user' },
    post: { id: 'post-1', caption: 'Hola X' },
    env: { SOCIAL_X_CLIENT_ID: 'client' },
    vault,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse({ data: { id: 'tweet-1', text: 'Hola X' } });
    },
  });
  assert.equal(captured.url, 'https://api.x.com/2/tweets');
  assert.equal(captured.init.headers.Authorization, 'Bearer encrypted-opened-token');
  assert.ok(captured.init.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(captured.init.body), { text: 'Hola X' });
  assert.equal(result.externalId, 'tweet-1');
});

test('publisher sends a Facebook remote image through the Page photos endpoint', async () => {
  let captured;
  const result = await publishPostToPlatform({
    platform: 'facebook',
    connection: { accessToken: 'sealed', accountId: 'page-9' },
    post: {
      id: 'post-2',
      caption: 'Nueva publicación',
      imageUrl: 'https://cdn.example.test/post.jpg',
    },
    env: {
      SOCIAL_FACEBOOK_CLIENT_ID: 'client',
      SOCIAL_FACEBOOK_CLIENT_SECRET: 'secret',
    },
    vault,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse({ id: 'photo-1', post_id: 'page-9_1' });
    },
  });
  assert.match(captured.url, /\/page-9\/photos$/);
  assert.equal(captured.init.body.get('url'), 'https://cdn.example.test/post.jpg');
  assert.equal(captured.init.body.get('caption'), 'Nueva publicación');
  assert.equal(result.media, 'remote_image');
});

test('publisher rejects X copy over 280 characters before calling the provider', async () => {
  await assert.rejects(
    () => publishPostToPlatform({
      platform: 'x',
      connection: { accessToken: 'sealed', accountId: 'x-user' },
      post: { id: 'post-long', caption: 'x'.repeat(281) },
      env: { SOCIAL_X_CLIENT_ID: 'client' },
      vault,
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    }),
    (error) => error.code === 'SOCIAL_X_TEXT_TOO_LONG',
  );
});

test('publisher refreshes an expired X token before posting and re-seals it', async () => {
  const updates = [];
  const calls = [];
  const result = await publishPostToPlatform({
    platform: 'x',
    connection: { id: 'connection-x', accessToken: 'sealed-old', accountId: 'x-user' },
    post: { id: 'post-refresh', caption: 'Token actualizado' },
    env: { SOCIAL_X_CLIENT_ID: 'client', SOCIAL_X_CLIENT_SECRET: 'secret' },
    prisma: {
      socialConnection: {
        update: async (args) => {
          updates.push(args);
          return args.data;
        },
      },
    },
    vault: {
      openProviderTokens: () => ({
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1_000,
      }),
      sealProviderTokens: (bundle) => `resealed:${bundle.accessToken}`,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/oauth2/token')) {
        return jsonResponse({
          access_token: 'fresh-token',
          refresh_token: 'next-refresh-token',
          expires_in: 7200,
        });
      }
      return jsonResponse({ data: { id: 'tweet-fresh' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fresh-token');
  assert.equal(updates[0].data.accessToken, 'resealed:fresh-token');
  assert.equal(result.externalId, 'tweet-fresh');
});
