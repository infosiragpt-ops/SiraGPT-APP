'use strict';

/**
 * A stored Slack webhook that no longer decrypts (saved under a key this
 * process no longer has — before 2026-09-28 the key was random per process,
 * so every deploy broke saved webhooks) must ask the user to paste the
 * webhook again: 409 slack_reconnect_required with a Spanish message on both
 * the org and the user test routes, never a raw 500 «failed to decrypt
 * stored webhook». Uses the REAL slack-integration module.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const slackServicePath = path.resolve(__dirname, '../src/services/slack-integration.js');
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');
const userSlackRoutePath = path.resolve(__dirname, '../src/routes/integrations/slack.js');

const KEY_ENV = ['SLACK_ENCRYPTION_KEY', 'SIRAGPT_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'NODE_ENV'];

// A well-formed AES-256-GCM envelope sealed with some OTHER key: base64 of
// iv(12) + tag(16) + ciphertext. The auth tag never verifies here.
const UNDECRYPTABLE = Buffer.concat([Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from('stale-webhook')]).toString('base64');

const prismaState = { rows: [] };

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== 'org-1' || userId !== 'u-admin') return null;
      return { id: 'm1', orgId, userId, role: 'ADMIN', organization: { id: orgId, billingPlan: 'PRO' } };
    },
  },
  slackIntegration: {
    findFirst: async ({ where }) => prismaState.rows.find((row) => (
      where.organizationId ? row.organizationId === where.organizationId : row.userId === where.userId
    )) || null,
    update: async ({ where, data }) => Object.assign(prismaState.rows.find((row) => row.id === where.id) || {}, data),
  },
};

const rateLimitMock = {
  async consume(_key, limit, windowMs) {
    return { allowed: true, remaining: limit, resetAt: new Date(Date.now() + windowMs) };
  },
  createRateLimitStore: () => ({ store: null, redis: null, mode: 'memory', reason: 'test' }),
  shouldUseRedis: () => false,
  setLogger: () => {},
  _resetForTests: () => {},
};

function stub(filePath, exports) {
  require.cache[filePath] = { id: filePath, filename: filePath, loaded: true, exports };
}

let savedEnv = {};

// Fresh routers + a fresh slack-integration (empty key cache) under `env`.
function loadRouters(env) {
  for (const name of KEY_ENV) delete process.env[name];
  Object.assign(process.env, env);
  stub(authPath, {
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() };
      next();
    },
  });
  stub(dbPath, prismaMock);
  stub(auditPath, { writeAuditLog: () => {} });
  stub(triggersPath, {
    TRIGGERS: [],
    isKnownTrigger: () => true,
    publish: async () => ({ dispatched: 0, deduped: false, errors: [] }),
    publishDebounced: async () => {},
    resetForTests: () => {},
  });
  stub(rateLimitStorePath, rateLimitMock);
  for (const p of [slackServicePath, orgsRoutePath, userSlackRoutePath]) delete require.cache[p];
  return { orgs: require(orgsRoutePath), user: require(userSlackRoutePath) };
}

function callRoute(router, mount, urlPath) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(mount, router);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => { buf += chunk; });
          res.on('end', () => {
            server.close();
            let json = null;
            try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end('{}');
    });
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const name of KEY_ENV) savedEnv[name] = process.env[name];
  prismaState.rows = [
    { id: 'slk-org', userId: 'u-admin', organizationId: 'org-1', webhookUrl: UNDECRYPTABLE, isEnabled: true },
    { id: 'slk-user', userId: 'u-admin', organizationId: null, webhookUrl: UNDECRYPTABLE, isEnabled: true },
  ];
});

afterEach(() => {
  for (const name of KEY_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  delete require.cache[slackServicePath];
});

function assertReconnect(res) {
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'slack_reconnect_required');
  assert.equal(res.body.error, 'slack_reconnect_required');
  assert.match(res.body.message, /Slack caducó; vuelve a pegar el webhook/);
  assert.doesNotMatch(JSON.stringify(res.body), /failed to decrypt/);
}

describe('undecryptable stored Slack webhook', () => {
  test('org test route answers 409 slack_reconnect_required, never 500', async () => {
    const { orgs } = loadRouters({ ENCRYPTION_KEY: 'f'.repeat(64), NODE_ENV: 'production' });
    assertReconnect(await callRoute(orgs, '/api/orgs', '/api/orgs/org-1/slack/test'));
  });

  test('user test route answers 409 slack_reconnect_required, never 500', async () => {
    const { user } = loadRouters({ ENCRYPTION_KEY: 'f'.repeat(64), NODE_ENV: 'production' });
    assertReconnect(await callRoute(user, '/api/integrations/slack', '/api/integrations/slack/test'));
  });

  test('production without any encryption key answers a Spanish 503, not a reconnect', async () => {
    const { orgs, user } = loadRouters({ NODE_ENV: 'production' });
    for (const res of [
      await callRoute(orgs, '/api/orgs', '/api/orgs/org-1/slack/test'),
      await callRoute(user, '/api/integrations/slack', '/api/integrations/slack/test'),
    ]) {
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'slack_encryption_unconfigured');
      assert.match(res.body.message, /clave de cifrado/);
    }
  });
});
