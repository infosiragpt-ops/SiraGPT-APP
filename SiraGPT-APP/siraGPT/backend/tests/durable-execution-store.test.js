const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const { buildEnterpriseExecutionGraph } = require('../src/services/agents/enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('../src/services/agents/enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('../src/services/agents/agentic-qa-board');
const store = require('../src/services/agents/durable-execution-store');

let oldDir;
let tmpDir;

beforeEach(() => {
  oldDir = process.env.ENTERPRISE_EXECUTION_STORE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-exec-store-'));
  process.env.ENTERPRISE_EXECUTION_STORE_DIR = tmpDir;
});

afterEach(() => {
  if (oldDir == null) delete process.env.ENTERPRISE_EXECUTION_STORE_DIR;
  else process.env.ENTERPRISE_EXECUTION_STORE_DIR = oldDir;
});

function fixture() {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Crea un Excel con KPIs y un dashboard estilo Power BI',
  });
  const graph = buildEnterpriseExecutionGraph({
    contract,
    taskId: 'task-durable-1',
    userId: 'user-a',
    chatId: 'chat-a',
  });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({ contract, graph, toolRuntimePlan });
  return { contract, graph, toolRuntimePlan, qaBoardReview };
}

test('durable execution store creates and reads graph records', () => {
  const { contract, graph, toolRuntimePlan, qaBoardReview } = fixture();
  const record = store.createDurableExecutionRecord({
    graph,
    contract,
    taskId: 'task-durable-1',
    userId: 'user-a',
    chatId: 'chat-a',
    toolRuntimePlan,
    qaBoardReview,
  });

  assert.equal(record.graphId, graph.graph_id);
  assert.equal(record.userId, 'user-a');
  assert.equal(record.nodes.length, graph.nodes.length);
  assert.equal(fs.existsSync(store.recordPathFor(graph.graph_id)), true);
  assert.equal(store.readExecutionRecord(graph.graph_id).graphId, graph.graph_id);
});

test('durable execution records are scoped by owner', () => {
  const { contract, graph, toolRuntimePlan, qaBoardReview } = fixture();
  store.createDurableExecutionRecord({
    graph,
    contract,
    taskId: 'task-durable-2',
    userId: 'user-a',
    chatId: 'chat-a',
    toolRuntimePlan,
    qaBoardReview,
  });

  assert.equal(store.getExecutionRecordForUser(graph.graph_id, 'user-a').graphId, graph.graph_id);
  assert.equal(store.getExecutionRecordForUser(graph.graph_id, 'user-b'), null);
});

test('durable execution store appends events and checkpoints node state', () => {
  const { contract, graph, toolRuntimePlan, qaBoardReview } = fixture();
  store.createDurableExecutionRecord({
    graph,
    contract,
    taskId: 'task-durable-3',
    userId: 'user-a',
    chatId: 'chat-a',
    toolRuntimePlan,
    qaBoardReview,
  });

  store.appendExecutionEvent(graph.graph_id, 'user-a', { type: 'node_started', nodeId: 'request_intelligence' });
  const checkpointed = store.checkpointNode({
    graphId: graph.graph_id,
    userId: 'user-a',
    nodeId: 'request_intelligence',
    state: 'succeeded',
    outputs: { ok: true },
  });

  assert.equal(checkpointed.nodes.find((node) => node.id === 'request_intelligence').state, 'succeeded');
  assert.equal(checkpointed.checkpoints.length, 1);
  assert.ok(checkpointed.events.some((event) => event.type === 'node_started'));
});

test('durable execution store marks terminal execution status', () => {
  const { contract, graph, toolRuntimePlan, qaBoardReview } = fixture();
  store.createDurableExecutionRecord({
    graph,
    contract,
    taskId: 'task-durable-4',
    userId: 'user-a',
    chatId: 'chat-a',
    toolRuntimePlan,
    qaBoardReview,
  });

  const updated = store.markExecutionStatus(graph.graph_id, 'user-a', 'completed', {
    stats: { steps: 3, artifacts: 1 },
  });

  assert.equal(updated.status, 'completed');
  assert.equal(updated.stats.artifacts, 1);
  assert.ok(updated.completedAt);
});
