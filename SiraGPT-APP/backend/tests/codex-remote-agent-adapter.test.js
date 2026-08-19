'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createImplementerRequest } = require('../src/services/codex/agent-adapters/contract');
const {
  createRemoteHttpAdapter,
  resolveRemoteAgentConfig,
} = require('../src/services/codex/agent-adapters/remote-http-adapter');

const env = {
  NODE_ENV: 'test',
  CODEX_REMOTE_AGENT_URL: 'http://127.0.0.1:9901/execute',
  CODEX_REMOTE_AGENT_TOKEN: 'test-token',
  CODEX_REMOTE_AGENT_TIMEOUT_MS: '5000',
};

function request() {
  return createImplementerRequest({
    run: { id: 'run-1', mode: 'build', prompt: 'Build it' },
    project: { id: 'project-1', name: 'Demo' },
    timeoutMs: 10_000,
    maxSteps: 8,
  });
}

test('remote-http sends only the path-free v1 request and returns a validated outcome', async () => {
  let received;
  const adapter = createRemoteHttpAdapter({
    defaultEnv: env,
    fetchImpl: async (url, init) => {
      received = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ status: 'done', checkpoint: { id: 'cp-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const outcome = await adapter.execute(request(), { deps: { env }, isCancelled: async () => false });
  assert.equal(outcome.status, 'done');
  assert.equal(received.url, env.CODEX_REMOTE_AGENT_URL);
  assert.equal(received.init.headers.Authorization, 'Bearer test-token');
  assert.equal(received.body.workspace.ref, 'codex-project:project-1');
  assert.equal(JSON.stringify(received.body).includes('workspacePath'), false);
});

test('remote-http fails closed for missing config, insecure production URL, and invalid outcomes', async () => {
  assert.throws(() => resolveRemoteAgentConfig({}), /CODEX_REMOTE_AGENT_URL is required/);
  assert.throws(
    () => resolveRemoteAgentConfig({
      NODE_ENV: 'production',
      CODEX_REMOTE_AGENT_URL: 'http://agent.internal/execute',
      CODEX_REMOTE_AGENT_TOKEN: 'token',
    }),
    /must use HTTPS/,
  );

  const adapter = createRemoteHttpAdapter({
    defaultEnv: env,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'mystery' }), { status: 200 }),
  });
  await assert.rejects(
    () => adapter.execute(request(), { deps: { env } }),
    /unsupported outcome status/,
  );
});

test('remote-http respects cooperative cancellation before making a request', async () => {
  let called = false;
  const adapter = createRemoteHttpAdapter({
    defaultEnv: env,
    fetchImpl: async () => {
      called = true;
      return new Response(JSON.stringify({ status: 'done' }));
    },
  });
  assert.deepEqual(
    await adapter.execute(request(), { deps: { env }, isCancelled: async () => true }),
    { status: 'cancelled' },
  );
  assert.equal(called, false);
});
