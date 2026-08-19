'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../src/services/agents/temporal/temporal-client');

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  // eslint-disable-next-line global-require
  return require(MODULE_PATH);
}

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+w==\n-----END CERTIFICATE-----';
const PEM_B64 = Buffer.from(PEM).toString('base64');

test('getTemporalConfig: disabled when TEMPORAL_ADDRESS is missing', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({ env: {} });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_address');
});

test('getTemporalConfig: disabled when no auth (no cert, no api key)', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({ env: { TEMPORAL_ADDRESS: 'foo.tmprl.cloud:7233' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_auth');
});

test('getTemporalConfig: enabled with mTLS PEM strings', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({
    env: {
      TEMPORAL_ADDRESS: 'sira-prod.tmprl.cloud:7233',
      TEMPORAL_CLIENT_CERT: PEM,
      TEMPORAL_CLIENT_KEY: PEM,
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.namespace, 'sira-prod');
  assert.equal(cfg.taskQueue, 'sira-agent-tasks');
  assert.ok(cfg.clientCert.includes('BEGIN CERTIFICATE'));
  assert.equal(cfg.apiKey, null);
});

test('getTemporalConfig: enabled with API key auth', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({
    env: { TEMPORAL_ADDRESS: 'x:7233', TEMPORAL_API_KEY: 'tk_abc' },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, 'tk_abc');
  assert.equal(cfg.clientCert, null);
});

test('getTemporalConfig: base64-encoded PEM secrets are decoded', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({
    env: {
      TEMPORAL_ADDRESS: 'x:7233',
      TEMPORAL_CLIENT_CERT: PEM_B64,
      TEMPORAL_CLIENT_KEY: PEM_B64,
    },
  });
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.clientCert.includes('BEGIN CERTIFICATE'));
});

test('getTemporalConfig: honors namespace + task queue overrides', () => {
  const { getTemporalConfig } = freshModule();
  const cfg = getTemporalConfig({
    env: {
      TEMPORAL_ADDRESS: 'x:7233',
      TEMPORAL_API_KEY: 'k',
      TEMPORAL_NAMESPACE: 'staging',
      TEMPORAL_TASK_QUEUE: 'qa-queue',
    },
  });
  assert.equal(cfg.namespace, 'staging');
  assert.equal(cfg.taskQueue, 'qa-queue');
});

test('shouldUseTemporalForTaskType: false when Temporal disabled', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  assert.equal(shouldUseTemporalForTaskType('research', { env: {} }), false);
});

test('shouldUseTemporalForTaskType: false when flag absent even if enabled', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  const env = { TEMPORAL_ADDRESS: 'x:7233', TEMPORAL_API_KEY: 'k' };
  assert.equal(shouldUseTemporalForTaskType('research', { env }), false);
});

test('shouldUseTemporalForTaskType: true when per-type flag set', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'x:7233',
    TEMPORAL_API_KEY: 'k',
    USE_TEMPORAL_FOR_RESEARCH: '1',
  };
  assert.equal(shouldUseTemporalForTaskType('research', { env }), true);
  // deep-research → DEEP_RESEARCH normalization
  assert.equal(shouldUseTemporalForTaskType('deep-research', { env }), false);
});

test('shouldUseTemporalForTaskType: normalizes hyphens, underscores, casing', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'x:7233',
    TEMPORAL_API_KEY: 'k',
    USE_TEMPORAL_FOR_DEEP_RESEARCH: 'true',
  };
  assert.equal(shouldUseTemporalForTaskType('deep-research', { env }), true);
  assert.equal(shouldUseTemporalForTaskType('deep_research', { env }), true);
  assert.equal(shouldUseTemporalForTaskType('DeepResearch', { env }), true);
});

test('shouldUseTemporalForTaskType: USE_TEMPORAL_FOR_ALL wins', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'x:7233',
    TEMPORAL_API_KEY: 'k',
    USE_TEMPORAL_FOR_ALL: '1',
  };
  assert.equal(shouldUseTemporalForTaskType('anything', { env }), true);
  assert.equal(shouldUseTemporalForTaskType('research', { env }), true);
});

test('shouldUseTemporalForTaskType: empty / falsy values do not enable', () => {
  const { shouldUseTemporalForTaskType } = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'x:7233',
    TEMPORAL_API_KEY: 'k',
    USE_TEMPORAL_FOR_RESEARCH: '0',
    USE_TEMPORAL_FOR_BATCH: '',
  };
  assert.equal(shouldUseTemporalForTaskType('research', { env }), false);
  assert.equal(shouldUseTemporalForTaskType('batch', { env }), false);
});

test('isTemporalEnabled mirrors getTemporalConfig().enabled', () => {
  const { isTemporalEnabled } = freshModule();
  assert.equal(isTemporalEnabled({ env: {} }), false);
  assert.equal(
    isTemporalEnabled({ env: { TEMPORAL_ADDRESS: 'x:7233', TEMPORAL_API_KEY: 'k' } }),
    true
  );
});

test('getTemporalClient: returns null when disabled', async () => {
  const { getTemporalClient } = freshModule();
  const client = await getTemporalClient({ env: {} });
  assert.equal(client, null);
});

test('getTemporalClient: connects via injected SDK + caches singleton', async () => {
  const mod = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'sira-prod.tmprl.cloud:7233',
    TEMPORAL_API_KEY: 'tk_abc',
    TEMPORAL_NAMESPACE: 'sira-prod',
  };
  let connectCalls = 0;
  let clientCtorCalls = 0;
  const fakeConnection = { close: async () => {} };
  const sdk = {
    client: {
      Connection: {
        connect: async (opts) => {
          connectCalls += 1;
          assert.equal(opts.address, 'sira-prod.tmprl.cloud:7233');
          assert.equal(opts.apiKey, 'tk_abc');
          return fakeConnection;
        },
      },
      Client: class FakeClient {
        constructor(opts) {
          clientCtorCalls += 1;
          assert.equal(opts.namespace, 'sira-prod');
          assert.equal(opts.connection, fakeConnection);
          this.connection = opts.connection;
        }
      },
    },
  };
  const c1 = await mod.getTemporalClient({ env, sdk });
  const c2 = await mod.getTemporalClient({ env, sdk });
  assert.ok(c1);
  assert.equal(c1, c2);
  assert.equal(connectCalls, 1);
  assert.equal(clientCtorCalls, 1);
  await mod.closeTemporalClient();
});

test('startAgentTaskWorkflow: returns null when disabled', async () => {
  const { startAgentTaskWorkflow } = freshModule();
  const handle = await startAgentTaskWorkflow({
    taskType: 'research',
    jobData: { taskId: 't1' },
    env: {},
  });
  assert.equal(handle, null);
});

test('startAgentTaskWorkflow: passes derived workflowId + search attrs', async () => {
  const mod = freshModule();
  const env = {
    TEMPORAL_ADDRESS: 'x:7233',
    TEMPORAL_API_KEY: 'k',
    TEMPORAL_NAMESPACE: 'sira-prod',
    TEMPORAL_TASK_QUEUE: 'sira-agent-tasks',
  };
  let started;
  const fakeConnection = { close: async () => {} };
  const sdk = {
    client: {
      Connection: { connect: async () => fakeConnection },
      Client: class {
        constructor() {
          this.workflow = {
            start: async (wfType, opts) => {
              started = { wfType, opts };
              return { workflowId: opts.workflowId, firstExecutionRunId: 'run-1' };
            },
          };
        }
      },
    },
  };
  const handle = await mod.startAgentTaskWorkflow({
    taskType: 'research',
    jobData: { taskId: 'task-abc', userId: 'user-9' },
    env,
    sdk,
  });
  assert.deepEqual(handle, { workflowId: 'task-abc', runId: 'run-1' });
  assert.equal(started.wfType, 'runAgentTaskWorkflow');
  assert.equal(started.opts.taskQueue, 'sira-agent-tasks');
  assert.equal(started.opts.workflowId, 'task-abc');
  assert.equal(started.opts.workflowIdReusePolicy, 'REJECT_DUPLICATE');
  assert.deepEqual(started.opts.searchAttributes.taskType, ['research']);
  assert.deepEqual(started.opts.searchAttributes.userId, ['user-9']);
  await mod.closeTemporalClient();
});

test('startAgentTaskWorkflow: throws when taskType missing', async () => {
  const { startAgentTaskWorkflow } = freshModule();
  await assert.rejects(
    () => startAgentTaskWorkflow({ jobData: {}, env: {} }),
    /taskType is required/
  );
});

test('getTemporalClient: transient connect failure returns null and does not poison singleton', async () => {
  const mod = freshModule();
  const env = { TEMPORAL_ADDRESS: 'x:7233', TEMPORAL_API_KEY: 'k' };
  let attempt = 0;
  const sdk = {
    client: {
      Connection: {
        connect: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('boom');
          return { close: async () => {} };
        },
      },
      Client: class { constructor(o) { this.connection = o.connection; } },
    },
  };
  const first = await mod.getTemporalClient({ env, sdk });
  assert.equal(first, null);
  const second = await mod.getTemporalClient({ env, sdk });
  assert.ok(second, 'second call should retry and succeed');
  assert.equal(attempt, 2);
  await mod.closeTemporalClient();
});
