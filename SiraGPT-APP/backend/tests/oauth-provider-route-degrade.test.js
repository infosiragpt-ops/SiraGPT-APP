'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/database');
const githubAccounts = require('../src/repositories/GithubAccountRepository');
const { installAuthSessionMock } = require('./http-test-utils');

const ENV_KEYS = [
  'NODE_ENV',
  'FRONTEND_URL',
  'PUBLIC_FRONTEND_URL',
  'NEXT_PUBLIC_URL',
  'GOOGLE_AUTH_BASE_URL',
  'OAUTH_POST_CALLBACK_ALLOWED_ORIGINS',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
  'GITHUB_OAUTH_SUCCESS_REDIRECT',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI',
  'SPOTIFY_OAUTH_SUCCESS_REDIRECT',
  'SPOTIFY_OAUTH_FAILURE_REDIRECT',
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function replaceOAuthEnv(values) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function buildApp() {
  const app = express();
  app.use('/api/github', require('../src/routes/github'));
  app.use('/api/spotify', require('../src/routes/spotify'));
  return app;
}

describe('optional OAuth provider route degradation', () => {
  let app;

  before(() => {
    app = buildApp();
  });

  after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('Spotify connect and callback return actionable 503 for the production localhost fixture', async () => {
    replaceOAuthEnv({
      NODE_ENV: 'production',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'http://localhost:5000/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://siragpt.com/connections',
    });

    const [connect, callback] = await Promise.all([
      request(app).get('/api/spotify/connect'),
      request(app).get('/api/spotify/callback?code=unsafe-code&state=unsafe-state'),
    ]);

    for (const response of [connect, callback]) {
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'OAUTH_PROVIDER_CONFIG_INVALID');
      assert.equal(response.body.provider, 'spotify');
      assert.equal(response.body.reason, 'callback_localhost_in_production');
      assert.ok(response.body.requiredEnv.includes('SPOTIFY_REDIRECT_URI'));
      assert.equal(response.headers.location, undefined);
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /localhost:5000|http:\/\/|spotify-secret|unsafe-code|unsafe-state/,
      );
    }
  });

  test('GitHub connect and callback return actionable 503 when post-callback is missing', async () => {
    replaceOAuthEnv({
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.siragpt.com/api/github/callback',
    });

    const [connect, callback] = await Promise.all([
      request(app).get('/api/github/connect'),
      request(app).get('/api/github/callback?code=unused-code&state=unused-state'),
    ]);

    for (const response of [connect, callback]) {
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'OAUTH_PROVIDER_CONFIG_INVALID');
      assert.equal(response.body.provider, 'github');
      assert.equal(response.body.reason, 'post_callback_url_missing');
      assert.ok(response.body.requiredEnv.includes('GITHUB_OAUTH_SUCCESS_REDIRECT'));
      assert.equal(response.headers.location, undefined);
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /github-secret|unused-code|unused-state/,
      );
    }
  });

  test('status endpoints separate unsafe provider config from existing account connections', async () => {
    replaceOAuthEnv({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.test',
      GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
      GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://attacker.example/settings',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'https://api.example.test/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://attacker.example/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://attacker.example/connections',
    });

    const auth = installAuthSessionMock();
    const originalGithubFind = githubAccounts.findByUserId;
    const originalUserFind = prisma.user.findUnique;
    githubAccounts.findByUserId = async () => ({
      login: 'connected-user',
      name: 'Connected User',
      avatarUrl: null,
      scope: 'repo read:user',
      connectedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    prisma.user.findUnique = async () => ({ spotifyTokens: 'stored-token-ciphertext' });

    try {
      const [github, spotify] = await Promise.all([
        request(app)
          .get('/api/github/status')
          .set('Authorization', auth.authHeader),
        request(app)
          .get('/api/spotify/status')
          .set('Authorization', auth.authHeader),
      ]);

      assert.equal(github.status, 200);
      assert.deepEqual(
        {
          configured: github.body.configured,
          enabled: github.body.enabled,
          status: github.body.status,
          reasons: github.body.reasons,
        },
        {
          configured: true,
          enabled: false,
          status: 'degraded',
          reasons: ['post_callback_origin_not_allowed'],
        },
      );
      assert.equal(github.body.connected, true);

      assert.equal(spotify.status, 200);
      assert.deepEqual(
        {
          configured: spotify.body.configured,
          enabled: spotify.body.enabled,
          status: spotify.body.status,
          reasons: spotify.body.reasons,
        },
        {
          configured: true,
          enabled: false,
          status: 'degraded',
          reasons: [
            'success_post_callback_origin_not_allowed',
            'failure_post_callback_origin_not_allowed',
          ],
        },
      );
      assert.equal(spotify.body.isConnected, true);
      assert.doesNotMatch(
        JSON.stringify({ github: github.body, spotify: spotify.body }),
        /attacker\.example|stored-token-ciphertext|github-secret|spotify-secret/,
      );
    } finally {
      githubAccounts.findByUserId = originalGithubFind;
      prisma.user.findUnique = originalUserFind;
      auth.restore();
    }
  });

  test('status endpoints report safe providers enabled without claiming account connection', async () => {
    replaceOAuthEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_URL: 'https://app.example.test',
      GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
      GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://app.example.test/settings',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'https://api.example.test/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://app.example.test/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://app.example.test/connections',
    });

    const auth = installAuthSessionMock();
    const originalGithubFind = githubAccounts.findByUserId;
    const originalUserFind = prisma.user.findUnique;
    githubAccounts.findByUserId = async () => null;
    prisma.user.findUnique = async () => ({ spotifyTokens: null });

    try {
      const [github, spotify] = await Promise.all([
        request(app)
          .get('/api/github/status')
          .set('Authorization', auth.authHeader),
        request(app)
          .get('/api/spotify/status')
          .set('Authorization', auth.authHeader),
      ]);

      for (const response of [github, spotify]) {
        assert.equal(response.status, 200);
        assert.equal(response.body.configured, true);
        assert.equal(response.body.enabled, true);
        assert.equal(response.body.status, 'healthy');
        assert.deepEqual(response.body.reasons, []);
      }
      assert.equal(github.body.connected, false);
      assert.equal(spotify.body.isConnected, false);
    } finally {
      githubAccounts.findByUserId = originalGithubFind;
      prisma.user.findUnique = originalUserFind;
      auth.restore();
    }
  });
});
