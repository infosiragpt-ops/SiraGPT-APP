'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const agentHarnessRoute = require('../src/routes/agent-harness');
const { buildAuditLogData } = require('../src/utils/audit-log');

function createFakePrisma({
  userSettings = { mcpAllowedHosts: ['mcp.example.com'] },
  organizationSettings = [{ mcpAllowedHosts: ['*.example.com'] }],
  lookupError = null,
} = {}) {
  const state = {
    rows: [],
    userSettings,
    organizationSettings,
  };
  return {
    state,
    user: {
      findUnique: async () => {
        if (lookupError) throw lookupError;
        return { settings: state.userSettings };
      },
    },
    orgMembership: {
      findMany: async () => {
        if (lookupError) throw lookupError;
        return state.organizationSettings.map((settings) => ({
          organization: { settings },
        }));
      },
    },
    mcpServer: {
      findMany: async ({ where }) => state.rows.filter((row) => row.userId === where.userId),
      findFirst: async ({ where }) => state.rows.find(
        (row) => row.id === where.id && row.userId === where.userId,
      ) || null,
      create: async ({ data }) => {
        const row = {
          id: `server-${state.rows.length + 1}`,
          ...data,
          createdAt: new Date('2026-07-11T00:00:00.000Z'),
          updatedAt: new Date('2026-07-11T00:00:00.000Z'),
        };
        state.rows.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const index = state.rows.findIndex((row) => row.id === where.id);
        state.rows[index] = {
          ...state.rows[index],
          ...data,
          updatedAt: new Date('2026-07-11T00:01:00.000Z'),
        };
        return state.rows[index];
      },
      delete: async ({ where }) => {
        const index = state.rows.findIndex((row) => row.id === where.id);
        return state.rows.splice(index, 1)[0];
      },
    },
  };
}

function mountRoute({
  prisma,
  env,
  audits,
  invalidations = [],
}) {
  assert.equal(typeof agentHarnessRoute.createAgentHarnessRouter, 'function');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentHarnessRoute.createAgentHarnessRouter({
    prisma,
    env,
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'user-1', email: 'owner@example.com' };
      next();
    },
    writeAuditLog: async (_db, entry) => {
      audits.push(buildAuditLogData(entry));
      return audits[audits.length - 1];
    },
    invalidateMcpConnections: async (serverId) => {
      invalidations.push(serverId);
    },
  }));
  return app;
}

test('MCP create/update/delete routes enforce layered policy, encrypt headers, and audit without secrets', async (t) => {
  const previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  t.after(() => {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  const prisma = createFakePrisma();
  const audits = [];
  const invalidations = [];
  const app = mountRoute({
    prisma,
    audits,
    invalidations,
    env: {
      NODE_ENV: 'production',
      SIRAGPT_MCP_ALLOWED_HOSTS: '*.example.com',
    },
  });
  const secret = 'Bearer route-secret-must-not-leak';

  const created = await request(app)
    .post('/api/agent/mcp-servers')
    .send({
      name: 'docs',
      url: 'https://MCP.Example.com:443/mcp',
      headers: { authorization: secret },
    })
    .expect(201);
  assert.equal(created.body.server.url, 'https://mcp.example.com/mcp');
  assert.equal(created.body.server.hasHeaders, true);
  assert.equal(Object.hasOwn(created.body.server, 'headers'), false);
  assert.equal(Object.hasOwn(created.body.server, 'headersEncrypted'), false);
  assert.ok(prisma.state.rows[0].headersEncrypted);
  assert.doesNotMatch(prisma.state.rows[0].headersEncrypted, /route-secret/);

  await request(app)
    .patch('/api/agent/mcp-servers/server-1')
    .send({ enabled: false })
    .expect(200);

  await request(app)
    .post('/api/agent/mcp-servers')
    .send({ name: 'blocked', url: 'https://evil.com/mcp', headers: { authorization: secret } })
    .expect(403, { error: 'MCP_HOST_NOT_ALLOWED' });

  prisma.state.organizationSettings = [{ mcpAllowedHosts: ['other.example.com'] }];
  await request(app)
    .patch('/api/agent/mcp-servers/server-1')
    .send({ enabled: true })
    .expect(200);
  assert.equal(
    prisma.state.rows[0].enabled,
    true,
    'personal MCP registration must ignore unrelated organization restrictions',
  );

  prisma.state.organizationSettings = [{ mcpAllowedHosts: ['*.example.com'] }];
  await request(app)
    .delete('/api/agent/mcp-servers/server-1')
    .expect(200, { ok: true });

  assert.deepEqual(
    audits.map((entry) => entry.action),
    [
      'mcp_server_created',
      'mcp_server_updated',
      'mcp_server_policy_denied',
      'mcp_server_updated',
      'mcp_server_deleted',
    ],
  );
  const persistedAudit = JSON.stringify(audits);
  assert.doesNotMatch(persistedAudit, /mcp\.example\.com|evil\.com|route-secret|authorization/i);
  assert.doesNotMatch(persistedAudit, /headersEncrypted/i);
  assert.deepEqual(
    invalidations,
    ['server-1', 'server-1', 'server-1'],
    'successful disable/update/delete must immediately close every cached client generation',
  );
});

test('MCP mutation routes fail closed on production settings lookup errors and audit denial', async () => {
  const marker = 'postgresql://admin:secret@private.internal/app';
  const prisma = createFakePrisma({ lookupError: new Error(marker) });
  const audits = [];
  const app = mountRoute({
    prisma,
    audits,
    env: {
      NODE_ENV: 'production',
      SIRAGPT_MCP_ALLOWED_HOSTS: 'mcp.example.com',
    },
  });

  const response = await request(app)
    .post('/api/agent/mcp-servers')
    .send({ name: 'docs', url: 'https://mcp.example.com/mcp' })
    .expect(503);
  assert.deepEqual(response.body, { error: 'MCP_POLICY_LOOKUP_FAILED' });
  assert.equal(prisma.state.rows.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'mcp_server_policy_denied');
  assert.doesNotMatch(JSON.stringify({ response: response.body, audits }), /postgresql|secret|private\.internal/i);
});

test('MCP list route never returns encrypted or plaintext headers', async () => {
  const prisma = createFakePrisma();
  prisma.state.rows.push({
    id: 'server-1',
    userId: 'user-1',
    name: 'docs',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: 'ciphertext',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
  });
  const app = mountRoute({
    prisma,
    audits: [],
    env: { NODE_ENV: 'test' },
  });

  const response = await request(app).get('/api/agent/mcp-servers').expect(200);
  assert.equal(response.body.servers[0].hasHeaders, true);
  assert.equal(Object.hasOwn(response.body.servers[0], 'headers'), false);
  assert.equal(Object.hasOwn(response.body.servers[0], 'headersEncrypted'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /ciphertext/);
});

test('MCP list reports when a stored server becomes denied by current policy', async () => {
  const prisma = createFakePrisma();
  prisma.state.rows.push({
    id: 'server-1',
    userId: 'user-1',
    name: 'docs',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    headersEncrypted: 'ciphertext',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
  });
  const env = {
    NODE_ENV: 'production',
    SIRAGPT_MCP_ALLOWED_HOSTS: 'mcp.example.com',
  };
  const app = mountRoute({ prisma, audits: [], env });

  const allowed = await request(app).get('/api/agent/mcp-servers').expect(200);
  assert.equal(allowed.body.servers[0].policyStatus, 'allowed');
  assert.equal(allowed.body.servers[0].policyReason, null);

  env.SIRAGPT_MCP_ALLOWED_HOSTS = '';
  const denied = await request(app).get('/api/agent/mcp-servers').expect(200);
  assert.equal(denied.body.servers[0].policyStatus, 'denied');
  assert.equal(denied.body.servers[0].policyReason, 'MCP_ALLOWED_HOSTS_REQUIRED');
  assert.doesNotMatch(JSON.stringify(denied.body), /ciphertext/);
});

test('MCP list failures do not expose database URLs or secrets in logs or responses', async (t) => {
  const marker = 'postgresql://admin:route-secret@private-db.internal/app';
  const prisma = createFakePrisma();
  prisma.mcpServer.findMany = async () => {
    throw new Error(marker);
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => {
    console.error = originalConsoleError;
  });
  const app = mountRoute({
    prisma,
    audits: [],
    env: { NODE_ENV: 'test' },
  });

  const response = await request(app).get('/api/agent/mcp-servers').expect(500);
  assert.deepEqual(response.body, { error: 'mcp_servers_list_failed' });
  assert.doesNotMatch(
    JSON.stringify({ response: response.body, logged }),
    /postgresql|route-secret|private-db/i,
  );
});
