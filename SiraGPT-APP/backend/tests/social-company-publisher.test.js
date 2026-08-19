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

test('publisher uploads one generated image to Facebook as multipart media', async () => {
  let captured;
  const result = await publishPostToPlatform({
    platform: 'facebook',
    connection: { accessToken: 'sealed', accountId: 'page-10' },
    post: { id: 'post-fb-generated', caption: 'Contenido con imagen propia' },
    media: {
      buffer: Buffer.from('generated-image'),
      mime: 'image/jpeg',
      altText: 'Equipo trabajando',
      generated: true,
    },
    env: {
      SOCIAL_FACEBOOK_CLIENT_ID: 'client',
      SOCIAL_FACEBOOK_CLIENT_SECRET: 'secret',
    },
    vault,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse({ id: 'photo-generated', post_id: 'page-10_1' });
    },
  });
  assert.match(captured.url, /\/page-10\/photos$/);
  assert.equal(captured.init.headers['Content-Type'], undefined);
  assert.equal(captured.init.body.get('caption'), 'Contenido con imagen propia');
  assert.ok(captured.init.body.get('source'));
  assert.equal(result.media, 'generated_image');
});

test('publisher initializes, uploads, and attaches a generated LinkedIn image', async () => {
  const calls = [];
  const result = await publishPostToPlatform({
    platform: 'linkedin',
    connection: { accessToken: 'sealed', accountId: 'member-1' },
    post: { id: 'post-linkedin-image', caption: 'Avance verificable' },
    media: {
      buffer: Buffer.from('linkedin-image'),
      mime: 'image/jpeg',
      altText: 'Panel de métricas',
      generated: true,
    },
    env: {
      SOCIAL_LINKEDIN_CLIENT_ID: 'client',
      SOCIAL_LINKEDIN_CLIENT_SECRET: 'secret',
    },
    vault,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/rest/images?action=initializeUpload')) {
        return jsonResponse({
          value: {
            uploadUrl: 'https://www.linkedin.com/dms-uploads/image-1',
            image: 'urn:li:image:image-1',
          },
        });
      }
      if (String(url).includes('/dms-uploads/')) {
        return new Response(null, { status: 201 });
      }
      return jsonResponse(
        {},
        201,
        { 'x-restli-id': 'urn:li:share:post-1' },
      );
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer encrypted-opened-token');
  const payload = JSON.parse(calls[2].init.body);
  assert.equal(payload.content.media.id, 'urn:li:image:image-1');
  assert.equal(payload.content.media.altText, 'Panel de métricas');
  assert.equal(result.externalId, 'urn:li:share:post-1');
  assert.equal(result.media, 'generated_image');
});

test('publisher blocks a LinkedIn upload target outside the provider domain', async () => {
  await assert.rejects(
    () => publishPostToPlatform({
      platform: 'linkedin',
      connection: { accessToken: 'sealed', accountId: 'member-1' },
      post: { id: 'post-linkedin-ssrf', caption: 'Contenido' },
      media: {
        buffer: Buffer.from('linkedin-image'),
        mime: 'image/jpeg',
        generated: true,
      },
      env: {
        SOCIAL_LINKEDIN_CLIENT_ID: 'client',
        SOCIAL_LINKEDIN_CLIENT_SECRET: 'secret',
      },
      vault,
      fetchImpl: async () => jsonResponse({
        value: {
          uploadUrl: 'http://127.0.0.1:5000/private',
          image: 'urn:li:image:image-1',
        },
      }),
    }),
    (error) => ['bad_scheme', 'blocked_ip'].includes(error.code),
  );
});

test('publisher uploads generated media to X before creating the post', async () => {
  const calls = [];
  const result = await publishPostToPlatform({
    platform: 'x',
    connection: { accessToken: 'sealed', accountId: 'x-user' },
    post: { id: 'post-x-image', caption: 'Resultado con evidencia visual' },
    media: {
      buffer: Buffer.from('x-image'),
      mime: 'image/jpeg',
      generated: true,
    },
    env: { SOCIAL_X_CLIENT_ID: 'client' },
    vault,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/2/media/upload')) {
        return jsonResponse({ data: { id: 'media-1' } });
      }
      return jsonResponse({ data: { id: 'tweet-image-1' } });
    },
  });

  assert.equal(calls.length, 2);
  const upload = JSON.parse(calls[0].init.body);
  assert.equal(upload.media, Buffer.from('x-image').toString('base64'));
  assert.equal(upload.media_category, 'tweet_image');
  const post = JSON.parse(calls[1].init.body);
  assert.deepEqual(post.media, { media_ids: ['media-1'] });
  assert.equal(result.externalId, 'tweet-image-1');
  assert.equal(result.media, 'generated_image');
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
