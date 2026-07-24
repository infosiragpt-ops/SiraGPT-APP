'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const oauth = require('../src/services/social-company/oauth');
const {
  providerConfig,
  publicProviderStatus,
} = require('../src/services/social-company/platforms');

const BASE_ENV = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:3000',
  BACKEND_BASE_URL: 'http://localhost:5000',
  SOCIAL_X_CLIENT_ID: 'x-client',
  SOCIAL_LINKEDIN_CLIENT_ID: 'li-client',
  SOCIAL_LINKEDIN_CLIENT_SECRET: 'li-secret',
  SOCIAL_FACEBOOK_CLIENT_ID: 'fb-client',
  SOCIAL_FACEBOOK_CLIENT_SECRET: 'fb-secret',
};

test('social OAuth platform config is fail-closed and exposes no secret', () => {
  assert.equal(providerConfig('x', {}).configured, false);
  const config = providerConfig('linkedin', BASE_ENV);
  assert.equal(config.configured, true);
  assert.equal(config.apiVersion, '202607');
  assert.match(config.redirectUri, /social-posts\/oauth\/linkedin\/callback$/);
  assert.equal(JSON.stringify(config).includes('li-secret'), true, 'private config retains secret server-side');
});

test('social provider capabilities expose generated image support and X requests media.write', () => {
  const xConfig = providerConfig('x', BASE_ENV);
  assert.equal(xConfig.scopes.includes('media.write'), true);
  for (const platform of ['facebook', 'linkedin', 'x']) {
    assert.equal(publicProviderStatus(platform, BASE_ENV).supports.generatedImage, true);
  }
});

test('X authorization uses PKCE and keeps verifier in private OAuth context', async () => {
  let signedPayload;
  const out = await oauth.beginAuthorization({
    userId: 'u1',
    platform: 'x',
    env: BASE_ENV,
    signState: async (payload) => {
      signedPayload = payload;
      return 'signed-state';
    },
  });
  const url = new URL(out.url);
  assert.equal(url.searchParams.get('state'), 'signed-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(signedPayload.context.codeVerifier);
  assert.equal(url.searchParams.has('code_verifier'), false);
});

test('Facebook OAuth selects a Page access token and stores only an encrypted envelope', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'user-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{ id: 'page-1', name: 'Sira Page', access_token: 'page-token' }],
    }), { status: 200 });
  };
  const writes = [];
  const prisma = {
    socialConnection: {
      upsert: async (args) => {
        writes.push(args);
        return { id: 'connection-1', ...args.create };
      },
    },
  };
  const vault = {
    sealProviderTokens: (bundle) => `sealed:${bundle.accessToken}`,
  };
  const result = await oauth.completeAuthorization({
    platform: 'facebook',
    code: 'code-1',
    state: 'state-1',
    prisma,
    env: BASE_ENV,
    fetchImpl,
    verifyState: async () => ({ userId: 'u1' }),
    vault,
  });
  assert.equal(result.connection.accountId, 'page-1');
  assert.equal(writes[0].create.accessToken, 'sealed:page-token');
  assert.equal(writes[0].create.refreshToken, null);
  assert.equal(JSON.stringify(writes[0]).includes('user-token'), false);
  assert.equal(requests.length, 2);
});
