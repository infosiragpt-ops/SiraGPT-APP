'use strict';

// trace_id observability: persistAgentRun stamps every step row with one
// trace id (caller-supplied or minted) + the /api/agent-runs/:traceId
// contract (ownership walk, 404 on foreign traces, 400 on bad ids).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { persistAgentRun } = require('../src/services/agent-harness/agent-steps-store');

function fakePrisma(captured) {
  return {
    agentStep: {
      createMany: async ({ data }) => { captured.rows = data; return { count: data.length }; },
    },
    message: {
      update: async (args) => { captured.metadataUpdate = args; return {}; },
    },
  };
}

const RUN = {
  steps: [
    { stepIndex: 0, type: 'reasoning', status: 'completed' },
    { stepIndex: 1, type: 'tool_call', toolName: 'web_search', args: '{"q":"x"}', result: '{"ok":true}', status: 'completed', durationMs: 12 },
  ],
  durationMs: 40, toolCallCount: 1, errorCount: 0, tokensEstimate: 100,
};

test('persistAgentRun stamps a shared traceId on rows and metadata', async () => {
  const captured = {};
  const out = await persistAgentRun({ prisma: fakePrisma(captured), messageId: 'm1', run: RUN });
  assert.equal(out.ok, true);
  assert.ok(typeof out.traceId === 'string' && out.traceId.length >= 8, 'minted traceId returned');
  assert.ok(captured.rows.every((r) => r.traceId === out.traceId), 'all rows share the trace id');
  assert.equal(captured.metadataUpdate.data.agentMetadata.traceId, out.traceId, 'metadata carries it too');
});

test('persistAgentRun honours a caller-supplied traceId (capped at 64 chars)', async () => {
  const captured = {};
  const out = await persistAgentRun({ prisma: fakePrisma(captured), messageId: 'm1', run: RUN, traceId: 'stream-abc-123' });
  assert.equal(out.traceId, 'stream-abc-123');
  const long = 'x'.repeat(200);
  const out2 = await persistAgentRun({ prisma: fakePrisma({}), messageId: 'm1', run: RUN, traceId: long });
  assert.equal(out2.traceId.length, 64);
});

test('GET /api/agent-runs/:traceId — ownership, 404 on foreign, 400 on junk', async () => {
  const routerModule = require('../src/routes/agent-runs');
  // extract the handler from the router stack
  const layer = routerModule.stack.find((l) => l.route && l.route.path === '/:traceId');
  assert.ok(layer, 'route registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const db = require('../src/config/database');
  const origFindMany = db.agentStep && db.agentStep.findMany;
  const mkRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  const steps = [{
    stepIndex: 0, type: 'tool_call', toolName: 'ping', args: null, result: null,
    status: 'completed', durationMs: 5, isError: false, createdAt: new Date(),
    message: { id: 'm1', chatId: 'c1', chat: { userId: 'owner-1' } },
  }];
  try {
    if (db.agentStep) db.agentStep.findMany = async () => steps;
    // owner sees the run
    let res = mkRes();
    await handler({ params: { traceId: 'trace-abcdef-1' }, user: { id: 'owner-1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stepCount, 1);
    assert.equal(res.body.steps[0].toolName, 'ping');
    // foreign user gets 404 (no probing)
    res = mkRes();
    await handler({ params: { traceId: 'trace-abcdef-1' }, user: { id: 'intruder' } }, res);
    assert.equal(res.statusCode, 404);
    // malformed id gets 400 before any query
    res = mkRes();
    await handler({ params: { traceId: 'x;DROP' } }, res);
    assert.equal(res.statusCode, 400);
    // unknown trace → 404
    if (db.agentStep) db.agentStep.findMany = async () => [];
    res = mkRes();
    await handler({ params: { traceId: 'trace-unknown-9' }, user: { id: 'owner-1' } }, res);
    assert.equal(res.statusCode, 404);
  } finally {
    if (db.agentStep && origFindMany) db.agentStep.findMany = origFindMany;
  }
});
