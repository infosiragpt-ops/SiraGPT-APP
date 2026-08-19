'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  NODE_ORDER,
  ckptId,
  createLangGraphOrchestrator,
} = require('../src/orchestration/langgraph-engine');

describe('langgraph engine', () => {
  test('NODE_ORDER has all expected nodes', () => {
    assert.deepStrictEqual(NODE_ORDER, [
      'planner', 'retriever', 'tool-executor',
      'critic', 'synthesizer', 'finalizer',
    ]);
  });

  test('ckptId produces unique ids', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(ckptId());
    assert.strictEqual(ids.size, 100);
  });

  test('ckptId starts with ckpt_ prefix', () => {
    const id = ckptId();
    assert.ok(id.startsWith('ckpt_'));
  });

  test('creates orchestrator with expected shape', () => {
    const orch = createLangGraphOrchestrator({
      checkpointStore: {
        put: async () => ({}),
        get: async () => null,
        latest: async () => null,
      },
    });
    assert.strictEqual(typeof orch.run, 'function');
    assert.strictEqual(typeof orch.resume, 'function');
    assert.deepStrictEqual(orch.nodes, NODE_ORDER);
  });

  test('run returns state with stage done', async () => {
    const orch = createLangGraphOrchestrator({
      gateway: {
        complete: async () => ({
          response: { choices: [{ message: { content: 'test response' } }] },
          provider: 'test',
          model: 'test-model',
        }),
      },
      checkpointStore: {
        put: async () => ({}),
        get: async () => null,
        latest: async () => null,
      },
    });

    const result = await orch.run({
      threadId: 'test-thread-1',
      input: {
        messages: [{ role: 'user', content: 'Hello' }],
        prompt: 'Hello',
      },
      userId: 'user-1',
      metadata: { intent: 'chat' },
    });

    assert.ok(result);
    assert.ok(result.stage === 'done' || typeof result.answer === 'string');
  });

  test('run without gateway still completes', async () => {
    const orch = createLangGraphOrchestrator({
      checkpointStore: {
        put: async () => ({}),
        get: async () => null,
        latest: async () => null,
      },
    });

    const result = await orch.run({
      threadId: 'test-thread-2',
      input: { messages: [{ role: 'user', content: 'test' }] },
      userId: 'user-2',
    });

    assert.ok(result);
    assert.ok(result.stage);
  });

  test('resume returns null for missing thread', async () => {
    const orch = createLangGraphOrchestrator({
      checkpointStore: {
        put: async () => ({}),
        get: async () => null,
        latest: async () => null,
      },
    });

    const result = await orch.resume({ threadId: 'nonexistent' });
    assert.strictEqual(result, null);
  });

  test('resume returns state for existing thread', async () => {
    const savedState = { answer: 'cached response', stage: 'done' };
    const orch = createLangGraphOrchestrator({
      checkpointStore: {
        put: async () => ({}),
        get: async () => savedState,
        latest: async () => ({
          threadId: 'existing-thread',
          state: savedState,
          metadata: { node: 'finalizer' },
        }),
      },
    });

    const result = await orch.resume({ threadId: 'existing-thread' });
    assert.ok(result);
    assert.ok(result.state);
    assert.strictEqual(result.state.answer, 'cached response');
  });
});
