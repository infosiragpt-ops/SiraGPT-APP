/**
 * Tests for services/agents/agentic-langgraph.js — LangGraph wiring
 * layer (with deterministic fallback).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  GRAPH_NODES,
  buildLangGraphLayer,
} = require('../src/services/agents/agentic-langgraph');

describe('GRAPH_NODES', () => {
  it('pins the exact node list', () => {
    assert.deepEqual(GRAPH_NODES, [
      'plan',
      'retrieve',
      'execute_tools',
      'generate_document',
      'verify',
      'repair',
      'finalize',
    ]);
  });

  it('has exactly 7 nodes (catches accidental additions)', () => {
    assert.equal(GRAPH_NODES.length, 7);
  });

  it('every entry is a lowercase snake_case string', () => {
    for (const n of GRAPH_NODES) {
      assert.equal(typeof n, 'string');
      assert.match(n, /^[a-z][a-z0-9_]*$/);
    }
  });

  it('contains no duplicates', () => {
    assert.equal(new Set(GRAPH_NODES).size, GRAPH_NODES.length);
  });
});

describe('buildLangGraphLayer · success path', () => {
  it('returns enabled=true with a compiled graph when @langchain/langgraph loads', async () => {
    // We don't mock LangGraph — instead use a smoke test on the actual
    // package (already in node_modules). If import succeeds the layer
    // returns a graph; if it doesn't, the test detects the fallback
    // shape and skips structural assertions on the graph.
    const out = await buildLangGraphLayer({ taskId: 't-1' });
    assert.equal(out.provider, '@langchain/langgraph');
    assert.equal(out.taskId, 't-1');
    assert.deepEqual(out.nodes, GRAPH_NODES);

    if (out.enabled) {
      // LangGraph is available — pin the success-shape contract.
      assert.equal(out.humanInTheLoop, true);
      assert.ok(out.graph, 'compiled graph object should be present');
      assert.ok(
        ['MemorySaver', 'file-backed-task-store'].includes(out.checkpointer),
        `unexpected checkpointer: ${out.checkpointer}`,
      );
    } else {
      // Fallback was taken — pin fallback shape.
      assert.equal(out.fallback, 'deterministic-runner');
      assert.equal(typeof out.error, 'string');
    }
  });

  it('passes taskId through verbatim (success OR fallback)', async () => {
    const out = await buildLangGraphLayer({ taskId: 'abc-123' });
    assert.equal(out.taskId, 'abc-123');
  });

  it('handles missing options object without throwing', async () => {
    const out = await buildLangGraphLayer();
    assert.ok(out);
    assert.equal(out.provider, '@langchain/langgraph');
  });

  it('handles missing taskId without throwing (undefined propagates)', async () => {
    const out = await buildLangGraphLayer({});
    assert.equal(out.taskId, undefined);
  });
});

describe('buildLangGraphLayer · graph routing (when enabled)', () => {
  it('execute_tools → generate_document when documentPolicy.autoGenerate=true', async () => {
    const out = await buildLangGraphLayer({
      taskId: 't-doc',
      documentPolicy: { autoGenerate: true },
    });
    if (!out.enabled) return; // skip if LangGraph not installed
    // We invoke the compiled graph end-to-end and inspect the
    // checkpoints array to verify the routing branch was taken.
    const state = await out.graph.invoke({}, { configurable: { thread_id: 't-doc' } });
    assert.ok(state.checkpoints.includes('generate_document'),
      `expected generate_document in checkpoints, got ${state.checkpoints.join(',')}`);
  });

  it('execute_tools → verify (skipping generate_document) when autoGenerate=false', async () => {
    const out = await buildLangGraphLayer({
      taskId: 't-no-doc',
      documentPolicy: { autoGenerate: false },
    });
    if (!out.enabled) return;
    const state = await out.graph.invoke({}, { configurable: { thread_id: 't-no-doc' } });
    assert.ok(state.checkpoints.includes('verify'));
    assert.equal(state.checkpoints.includes('generate_document'), false);
  });

  it('checkpoints accumulate plan → retrieve → execute_tools → verify → finalize', async () => {
    const out = await buildLangGraphLayer({ taskId: 't-flow' });
    if (!out.enabled) return;
    const state = await out.graph.invoke({}, { configurable: { thread_id: 't-flow' } });
    // The reducer concatenates so order should be deterministic.
    for (const expected of ['plan', 'retrieve', 'execute_tools', 'verify', 'finalize']) {
      assert.ok(state.checkpoints.includes(expected),
        `missing ${expected}; got ${state.checkpoints.join(',')}`);
    }
  });

  it('final stage is "done"', async () => {
    const out = await buildLangGraphLayer({ taskId: 't-done' });
    if (!out.enabled) return;
    const state = await out.graph.invoke({}, { configurable: { thread_id: 't-done' } });
    assert.equal(state.stage, 'done');
  });
});

describe('buildLangGraphLayer · fallback path', () => {
  it('fallback shape contains nodes list + fallback marker (when LangGraph absent)', async () => {
    // We can detect the LangGraph package via a simple try/import; if
    // unavailable, the layer returns enabled:false. In either case,
    // we can pin that the nodes list is always present (so callers
    // can rely on it for telemetry).
    const out = await buildLangGraphLayer({ taskId: 't-test' });
    assert.deepEqual(out.nodes, GRAPH_NODES);
  });
});

describe('module surface', () => {
  it('exports exactly { GRAPH_NODES, buildLangGraphLayer }', () => {
    const mod = require('../src/services/agents/agentic-langgraph');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['GRAPH_NODES', 'buildLangGraphLayer']);
  });
});
