'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

test('a default-route failover does not expose provider or model identities in the client event', async () => {
  const runtimePath = require.resolve('../src/services/doc-agent/llm-runtime');
  const agentPath = require.resolve('../src/services/doc-agent');
  const runtime = require(runtimePath);
  const originalCreate = runtime.createFailoverClient;
  const originalRoute = process.env.SIRAGPT_DOC_AGENT_ROUTE;
  const events = [];
  try {
    process.env.SIRAGPT_DOC_AGENT_ROUTE = 'auto';
    runtime.createFailoverClient = (_candidates, { onFailover }) => {
      onFailover({ from: 'DeepSeek', model: 'deepseek-v4-pro', to: 'xAI', status: 503, message: 'private provider detail' });
      throw new Error('stop before sandbox');
    };
    delete require.cache[agentPath];
    const { runDocumentAgent } = require(agentPath);
    await assert.rejects(
      () => runDocumentAgent({ files: [], instruction: 'editar un documento', onEvent: (event) => events.push(event) }),
      /stop before sandbox/,
    );
    assert.deepEqual(events, [{ type: 'llm_failover', message: 'Reintentando con otro servicio de IA.' }]);
  } finally {
    runtime.createFailoverClient = originalCreate;
    if (originalRoute === undefined) delete process.env.SIRAGPT_DOC_AGENT_ROUTE;
    else process.env.SIRAGPT_DOC_AGENT_ROUTE = originalRoute;
    delete require.cache[agentPath];
  }
});

test('/api/doc-agent/run preserves E_PROVIDER in its SSE error event', async () => {
  const router = require('../src/routes/doc-agent');
  const layer = router.stack.find((entry) => entry.route?.path === '/run');
  const handler = layer.route.stack.at(-1).handle;
  const req = Object.assign(new EventEmitter(), {
    user: { id: 'test-user' },
    body: { prompt: 'edita el archivo', fileIds: [], model: 'anthropic/claude-4' },
  });
  let wire = '';
  const res = {
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.equal(headers['Content-Type'], 'text/event-stream');
    },
    write(chunk) { wire += chunk; },
    end() {},
  };
  await handler(req, res);
  const events = wire.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(events[0].code, 'E_PROVIDER');
  assert.doesNotMatch(JSON.stringify(events), /anthropic|claude|OpenRouter|DeepSeek/i);
});
