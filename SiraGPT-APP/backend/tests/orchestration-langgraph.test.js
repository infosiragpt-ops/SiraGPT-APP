'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLangGraphOrchestrator } = require('../src/orchestration/langgraph-engine');
const { createAgentCheckpointStore } = require('../src/orchestration/agent-checkpoint-store');

test('langgraph orchestrator has 6 standard nodes', () => {
  const orchestrator = createLangGraphOrchestrator({});
  assert.deepEqual(orchestrator.nodes, [
    'planner', 'retriever', 'tool-executor', 'critic', 'synthesizer', 'finalizer',
  ]);
});

test('langgraph orchestrator runs full pipeline and returns state', async () => {
  const checkpointStore = createAgentCheckpointStore({
    prisma: {
      $executeRawUnsafe: async () => {},
      $queryRawUnsafe: async () => [],
    },
  });

  const orchestrator = createLangGraphOrchestrator({
    checkpointStore,
    gateway: {
      async complete({ messages }) {
        return {
          response: { choices: [{ message: { content: 'Orchestrated response' } }] },
          provider: 'test',
          model: 'test-model',
        };
      },
    },
  });

  const state = await orchestrator.run({
    threadId: 'thread-1',
    input: { messages: [{ role: 'user', content: 'Hello' }] },
    userId: 'user-1',
  });

  assert.ok(state.plan);
  assert.ok(Array.isArray(state.retrieval));
  assert.ok(Array.isArray(state.toolResults));
  assert.ok(state.critique);
  assert.equal(state.answer, 'Orchestrated response');
  assert.equal(state.model.provider, 'test');
});

test('langgraph orchestrator works without gateway', async () => {
  const checkpointStore = createAgentCheckpointStore({
    prisma: {
      $executeRawUnsafe: async () => {},
      $queryRawUnsafe: async () => [],
    },
  });

  const orchestrator = createLangGraphOrchestrator({ checkpointStore });
  const state = await orchestrator.run({
    threadId: 'thread-2',
    input: { messages: [] },
    userId: 'user-2',
  });

  assert.ok(state.plan);
  assert.equal(state.answer, null);
});

test('langgraph orchestrator passes metadata to checkpoints', async () => {
  const putCalls = [];
  const checkpointStore = createAgentCheckpointStore({
    prisma: {
      $executeRawUnsafe: async (_sql, threadId, checkpointId, parentId, state, metadata) => {
        putCalls.push({ threadId, checkpointId, parentId, metadata: JSON.parse(metadata) });
      },
      $queryRawUnsafe: async () => [],
    },
  });

  const orchestrator = createLangGraphOrchestrator({ checkpointStore });
  await orchestrator.run({
    threadId: 'thread-3',
    input: { messages: [{ role: 'user', content: 'test' }] },
    userId: 'user-3',
    metadata: { intent: 'chat', priority: 'high' },
  });

  assert.ok(putCalls.length >= 1, `expected at least 1 checkpoint, got ${putCalls.length}`);
  const lastCall = putCalls[putCalls.length - 1];
  assert.ok(lastCall.metadata, 'metadata should be present');
});

test('checkpoint store put creates entry with correct fields', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const store = createAgentCheckpointStore({
    prisma: {
      $executeRawUnsafe(sql, ...params) {
        capturedSql = sql;
        capturedParams = params;
      },
    },
  });

  await store.put({
    threadId: 't1',
    checkpointId: 'ckpt_1',
    parentCheckpointId: 'ckpt_0',
    state: { field: 'value' },
    metadata: { node: 'planner' },
  });

  assert.ok(capturedSql.includes('INSERT INTO agent_checkpoints'));
  assert.equal(capturedParams[0], 't1');
  assert.equal(capturedParams[1], 'ckpt_1');
  assert.equal(capturedParams[2], 'ckpt_0');
});

test('checkpoint store get retrieves state', async () => {
  const store = createAgentCheckpointStore({
    prisma: {
      async $queryRawUnsafe(sql, threadId, checkpointId) {
        return [{
          threadId,
          checkpointId,
          parentCheckpointId: 'ckpt_0',
          state: { key: 'val' },
          metadata: { node: 'test' },
          createdAt: new Date(),
        }];
      },
    },
  });

  const result = await store.get('t1', 'ckpt_1');
  assert.ok(result);
  assert.equal(result.threadId, 't1');
  assert.deepEqual(result.state, { key: 'val' });
});

test('checkpoint store get returns null for missing checkpoint', async () => {
  const store = createAgentCheckpointStore({
    prisma: { $queryRawUnsafe: async () => [] },
  });
  const result = await store.get('t1', 'missing');
  assert.equal(result, null);
});

test('checkpoint store latest returns most recent', async () => {
  const expected = {
    threadId: 't1',
    checkpointId: 'ckpt_latest',
    parentCheckpointId: null,
    state: { final: true },
    metadata: { node: 'finalizer' },
    createdAt: new Date(),
  };

  const store = createAgentCheckpointStore({
    prisma: { $queryRawUnsafe: async () => [expected] },
  });

  const result = await store.latest('t1');
  assert.ok(result);
  assert.equal(result.checkpointId, 'ckpt_latest');
  assert.deepEqual(result.state, { final: true });
});
