'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

async function runRouteHandler(handler, model) {
  const req = Object.assign(new EventEmitter(), {
    user: { id: 'test-user' },
    body: { prompt: 'edita el archivo', fileIds: [], model },
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
  return wire.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

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
  const events = await runRouteHandler(handler, 'anthropic/claude-4');
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(events[0].code, 'E_PROVIDER');
  assert.doesNotMatch(JSON.stringify(events), /anthropic|claude|OpenRouter|DeepSeek/i);
});

test('/api/doc-agent/run hides provider SDK details and does not misclassify unrelated failures', async () => {
  const agentPath = require.resolve('../src/services/doc-agent');
  const routePath = require.resolve('../src/routes/doc-agent');
  const agent = require(agentPath);
  const originalRun = agent.runDocumentAgent;
  let thrown = Object.assign(new Error('DeepSeek deepseek-v4-pro rejected sk-abcdefghijklmnopqrstuv'), { code: 'E_PROVIDER' });
  const originalLog = console.error;
  const logs = [];
  try {
    console.error = (...args) => logs.push(args.join(' '));
    agent.runDocumentAgent = async () => { throw thrown; };
    delete require.cache[routePath];
    const router = require(routePath);
    const handler = router.stack.find((entry) => entry.route?.path === '/run').route.stack.at(-1).handle;
    const [providerEvent] = await runRouteHandler(handler, 'DeepSeek:deepseek-v4-pro');
    assert.deepEqual(providerEvent, {
      type: 'error',
      code: 'E_PROVIDER',
      message: 'El servicio de IA no pudo completar la edición. Reintenta o elige otro modelo.',
    });
    assert.doesNotMatch(JSON.stringify(providerEvent), /DeepSeek|deepseek-v4-pro|sk-abcdefghijklmnopqrstuv/i);
    assert.match(logs.join('\n'), /DeepSeek deepseek-v4-pro/);
    assert.doesNotMatch(logs.join('\n'), /sk-abcdefghijklmnopqrstuv/);

    thrown = new Error('unrelated disk error');
    const [otherEvent] = await runRouteHandler(handler, 'DeepSeek:deepseek-v4-pro');
    assert.equal(otherEvent.code, 'doc_agent_failed');
    assert.equal(otherEvent.message, 'No se pudo completar la edición.');
  } finally {
    console.error = originalLog;
    agent.runDocumentAgent = originalRun;
    delete require.cache[routePath];
  }
});
