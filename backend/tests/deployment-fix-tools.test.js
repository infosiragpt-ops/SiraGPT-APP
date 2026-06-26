'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReadDeploymentLogsTool } = require('../src/services/agent-harness/tools/read-deployment-logs-tool');
const { buildApplyDeploymentFixTool } = require('../src/services/agent-harness/tools/apply-deployment-fix-tool');

const readTool = buildReadDeploymentLogsTool();
const applyTool = buildApplyDeploymentFixTool();

test('tool metadata: tiers + names', () => {
  assert.equal(readTool.name, 'read_deployment_logs');
  assert.equal(readTool.permissionTier, 'auto');
  assert.equal(applyTool.name, 'apply_deployment_fix');
  assert.equal(applyTool.permissionTier, 'confirm');
});

// ── read_deployment_logs ────────────────────────────────────────────────────
test('read: returns recent logs + classification (owner-scoped)', async () => {
  const ctx = {
    userId: 'u1',
    deploymentService: {
      getDeployment: async ({ id, userId }) => (userId === 'u1' && id === 'd1' ? { deployment: { status: 'failed' } } : null),
      getLogs: async () => ({ entries: [
        { level: 'info', message: 'building…' },
        { level: 'error', message: 'docker build failed: missing API key' },
      ] }),
    },
    classifyText: () => ({ pattern: { id: 'missing_api_key', title: 'Missing API key', explanation: 'set the key' }, severity: 'blocking' }),
  };
  const res = await readTool.execute({ deploymentId: 'd1' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.deploymentStatus, 'failed');
  assert.equal(res.recent.length, 2);
  assert.equal(res.classification.id, 'missing_api_key');
});

test('read: levelFilter narrows to errors', async () => {
  const ctx = {
    userId: 'u1',
    deploymentService: {
      getDeployment: async () => ({ deployment: { status: 'failed' } }),
      getLogs: async () => ({ entries: [
        { level: 'info', message: 'a' }, { level: 'error', message: 'boom' },
      ] }),
    },
    classifyText: () => null,
  };
  const res = await readTool.execute({ deploymentId: 'd1', levelFilter: 'error' }, ctx);
  assert.equal(res.recent.length, 1);
  assert.equal(res.recent[0].message, 'boom');
  assert.equal(res.classification, null);
});

test('read: denies without auth / for unknown deployment', async () => {
  assert.equal((await readTool.execute({ deploymentId: 'd1' }, {})).ok, false);
  const ctx = { userId: 'u1', deploymentService: { getDeployment: async () => null, getLogs: async () => ({ entries: [] }) } };
  assert.equal((await readTool.execute({ deploymentId: 'nope' }, ctx)).ok, false);
});

// ── apply_deployment_fix ────────────────────────────────────────────────────
test('apply: redeploy re-publishes and reports status', async () => {
  let published = false;
  const ctx = {
    userId: 'u1',
    deploymentService: {
      getDeployment: async () => ({ deployment: { status: 'failed' } }),
      publishDeployment: async ({ id }) => { published = id; return { deployment: { status: 'running' }, url: 'https://app.com', failedPhase: null }; },
    },
  };
  const res = await applyTool.execute({ deploymentId: 'd1', action: 'redeploy' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.action, 'redeploy');
  assert.equal(res.status, 'running');
  assert.equal(published, 'd1');
});

test('apply: set_secret seals into DeployEnv (creates when absent)', async () => {
  const store = { deployEnv: null };
  const ctx = {
    userId: 'u1',
    deploymentService: { getDeployment: async () => ({ deployment: {} }) },
    creds: { openJson: () => ({}), sealJson: (o) => `SEALED:${JSON.stringify(o)}` },
    prisma: {
      deployment: { findFirst: async () => ({ id: 'd1', connectedRepositoryId: 'c1' }) },
      deployEnv: {
        findFirst: async () => store.deployEnv,
        create: async ({ data }) => { store.deployEnv = { id: 'e1', ...data }; return store.deployEnv; },
        update: async ({ data }) => { store.deployEnv = { ...store.deployEnv, ...data }; return store.deployEnv; },
      },
    },
  };
  const res = await applyTool.execute({ deploymentId: 'd1', action: 'set_secret', key: 'DATABASE_URL', value: 'postgres://x' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.key, 'DATABASE_URL');
  assert.match(store.deployEnv.encryptedEnv, /SEALED:.*DATABASE_URL/);
});

test('apply: rejects an invalid secret name', async () => {
  const ctx = { userId: 'u1', deploymentService: { getDeployment: async () => ({ deployment: {} }) } };
  const res = await applyTool.execute({ deploymentId: 'd1', action: 'set_secret', key: 'bad key', value: 'x' }, ctx);
  assert.equal(res.ok, false);
});
