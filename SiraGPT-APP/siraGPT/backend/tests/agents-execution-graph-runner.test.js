/**
 * Tests for services/agents/execution-graph-runner.js — DAG executor
 * with retry / timeout / cancel-downstream / resume.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  runGraph,
  resumeGraph,
  compileToGraph,
  createInMemoryAdapter,
  cancelDownstream,
  INTERNAL,
} = require('../src/services/agents/execution-graph-runner');

const { buildExecutionGraph } = require('../src/services/agents/execution-graph');

// Test seam: instant-fire sleep (avoids real timer waits).
const fastSleep = () => Promise.resolve();

// ── createInMemoryAdapter ──────────────────────────────────────

describe('createInMemoryAdapter', () => {
  it('round-trips save → load (deep clone)', async () => {
    const a = createInMemoryAdapter();
    await a.save('id1', { x: 1, nested: { y: 2 } });
    const loaded = await a.load('id1');
    assert.deepEqual(loaded, { x: 1, nested: { y: 2 } });
    // Verify it's a clone (mutation doesn't bleed through).
    loaded.nested.y = 999;
    const reload = await a.load('id1');
    assert.equal(reload.nested.y, 2);
  });

  it('load returns null for unknown id', async () => {
    const a = createInMemoryAdapter();
    assert.equal(await a.load('missing'), null);
  });

  it('delete removes the entry', async () => {
    const a = createInMemoryAdapter();
    await a.save('id1', { x: 1 });
    await a.delete('id1');
    assert.equal(await a.load('id1'), null);
  });
});

// ── INTERNAL helpers ───────────────────────────────────────────

describe('INTERNAL.gatherInputs', () => {
  it('combines node.inputs with deps map from parent results', () => {
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', inputs: { x: 1 }, depends_on: ['a'] },
      ],
    });
    graph.nodes.find(n => n.id === 'a').result = 'parent-result';
    const inputs = INTERNAL.gatherInputs(graph, graph.nodes.find(n => n.id === 'b'));
    assert.equal(inputs.x, 1);
    assert.deepEqual(inputs.deps, { a: 'parent-result' });
  });

  it('deps entry is null when parent result missing', () => {
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't' },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    const inputs = INTERNAL.gatherInputs(graph, graph.nodes.find(n => n.id === 'b'));
    assert.deepEqual(inputs.deps, { a: null });
  });
});

describe('INTERNAL.jitteredBackoff', () => {
  it('returns base on first attempt without jitter', () => {
    assert.equal(INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 1), 100);
  });

  it('exponential doubles per attempt', () => {
    assert.equal(INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 2), 200);
    assert.equal(INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 3), 400);
  });

  it('caps at 60000ms', () => {
    assert.equal(INTERNAL.jitteredBackoff({ backoff_ms: 100_000, jitter_ms: 0 }, 1), 60_000);
  });

  it('jitter adds 0..jitter_ms to the base', () => {
    for (let i = 0; i < 20; i++) {
      const v = INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 50 }, 1);
      assert.ok(v >= 100 && v < 100 + 50, `jittered ${v} outside [100, 150)`);
    }
  });

  it('zero base → 0', () => {
    assert.equal(INTERNAL.jitteredBackoff({ backoff_ms: 0, jitter_ms: 0 }, 5), 0);
  });
});

describe('INTERNAL.runWithTimeout', () => {
  it('returns fn result when no timeout', async () => {
    const r = await INTERNAL.runWithTimeout(() => Promise.resolve('ok'), 0, fastSleep);
    assert.equal(r, 'ok');
  });

  it('returns fn result when fn finishes before timeout', async () => {
    const r = await INTERNAL.runWithTimeout(() => Promise.resolve('done'), 1000, fastSleep);
    assert.equal(r, 'done');
  });

  it('throws TIMEOUT error when sleep fires first', async () => {
    // Use a sleep that fires immediately and fn that never resolves.
    await assert.rejects(
      INTERNAL.runWithTimeout(() => new Promise(() => {}), 100, () => Promise.resolve()),
      /timed out after 100ms/,
    );
  });
});

// ── runGraph ──────────────────────────────────────────────────

describe('runGraph · validation', () => {
  it('throws when graph missing', async () => {
    await assert.rejects(
      () => runGraph({ tools: {} }),
      /graph required/,
    );
  });

  it('throws when tools registry missing', async () => {
    const graph = buildExecutionGraph({ nodes: [{ id: 'a', tool: 't' }] });
    await assert.rejects(
      () => runGraph({ graph }),
      /tools registry required/,
    );
  });
});

describe('runGraph · happy path', () => {
  it('runs every node in order and returns outcome=done', async () => {
    const order = [];
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't1' },
        { id: 'b', tool: 't2', depends_on: ['a'] },
        { id: 'c', tool: 't3', depends_on: ['b'] },
      ],
    });
    const tools = {
      t1: async () => { order.push('a'); return 'A'; },
      t2: async (inputs) => { order.push('b'); return `B(${inputs.deps.a})`; },
      t3: async (inputs) => { order.push('c'); return `C(${inputs.deps.b})`; },
    };
    const out = await runGraph({ graph, tools, sleep: fastSleep });
    assert.equal(out.outcome, 'done');
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(graph.nodes[2].result, 'C(B(A))');
  });

  it('runs nodes at the same depth in parallel', async () => {
    const inFlight = new Set();
    let maxConcurrent = 0;
    const tools = {
      t: async (inputs, ctx) => {
        inFlight.add(ctx.node.id);
        maxConcurrent = Math.max(maxConcurrent, inFlight.size);
        await new Promise(r => setTimeout(r, 5));
        inFlight.delete(ctx.node.id);
        return 'ok';
      },
    };
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't' },
        { id: 'b', tool: 't' },
        { id: 'c', tool: 't' },
        { id: 'd', tool: 't', depends_on: ['a', 'b', 'c'] },
      ],
    });
    await runGraph({ graph, tools, sleep: fastSleep });
    assert.ok(maxConcurrent >= 2, `expected concurrent siblings, got max ${maxConcurrent}`);
  });

  it('outcome="failed" when unknown tool name', async () => {
    const graph = buildExecutionGraph({ nodes: [{ id: 'a', tool: 'missing-tool' }] });
    const out = await runGraph({ graph, tools: {}, sleep: fastSleep });
    assert.equal(out.outcome, 'failed');
    assert.match(graph.nodes[0].error, /unknown tool "missing-tool"/);
  });

  it('emits structured onEvent events for the lifecycle', async () => {
    const events = [];
    const graph = buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't' }],
    });
    await runGraph({
      graph, tools: { t: async () => 'ok' },
      onEvent: (e) => events.push(e.type),
      sleep: fastSleep,
    });
    assert.ok(events.includes('graph_started'));
    assert.ok(events.includes('node_started'));
    assert.ok(events.includes('node_completed'));
    assert.ok(events.includes('graph_completed'));
  });

  it('saves to adapter after every transition', async () => {
    const adapter = createInMemoryAdapter();
    const graph = buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't' }],
    });
    await runGraph({
      graph, tools: { t: async () => 'ok' },
      adapter, graphId: 'g1',
      sleep: fastSleep,
    });
    const saved = await adapter.load('g1');
    assert.equal(saved.nodes[0].state, 'done');
  });
});

describe('runGraph · retry mechanics', () => {
  it('retries up to max_retries', async () => {
    let calls = 0;
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        retry_policy: { max_retries: 3, backoff_ms: 0, on_error: 'retry-then-fail' },
      }],
    });
    const tools = { t: async () => { calls++; throw new Error('flake'); } };
    await runGraph({ graph, tools, sleep: fastSleep });
    // 1 initial + 3 retries = 4 calls
    assert.equal(calls, 4);
  });

  it('succeeds on a later attempt', async () => {
    let calls = 0;
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        retry_policy: { max_retries: 3, backoff_ms: 0, on_error: 'retry-then-fail' },
      }],
    });
    const tools = {
      t: async () => {
        calls++;
        if (calls < 3) throw new Error('flake');
        return 'recovered';
      },
    };
    const out = await runGraph({ graph, tools, sleep: fastSleep });
    assert.equal(out.outcome, 'done');
    assert.equal(graph.nodes[0].result, 'recovered');
  });

  it('on_error="continue" marks failed nodes as done with result=null', async () => {
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        retry_policy: { max_retries: 0, backoff_ms: 0, on_error: 'continue' },
      }],
    });
    const tools = { t: async () => { throw new Error('boom'); } };
    const out = await runGraph({ graph, tools, sleep: fastSleep });
    assert.equal(out.outcome, 'done');
    assert.equal(graph.nodes[0].state, 'done');
    assert.equal(graph.nodes[0].result, null);
  });

  it('on_error="retry-then-skip" marks node as skipped after exhaustion', async () => {
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        retry_policy: { max_retries: 1, backoff_ms: 0, on_error: 'retry-then-skip' },
      }],
    });
    const tools = { t: async () => { throw new Error('x'); } };
    const out = await runGraph({ graph, tools, sleep: fastSleep });
    assert.equal(graph.nodes[0].state, 'skipped');
    // skipped is not failed → outcome=done (no failures).
    assert.equal(out.outcome, 'done');
  });
});

describe('runGraph · timeout policy', () => {
  it('on_timeout="fail" → node failed', async () => {
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        retry_policy: { max_retries: 0, on_error: 'retry-then-fail' },
        timeout_policy: { ms: 1, on_timeout: 'fail' },
      }],
    });
    const tools = { t: () => new Promise(() => {}) };  // never resolves
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5)));
    const out = await runGraph({ graph, tools, sleep });
    assert.equal(out.outcome, 'failed');
  });

  it('on_timeout="soft-warning" → node done with error', async () => {
    const graph = buildExecutionGraph({
      nodes: [{
        id: 'a', tool: 't',
        timeout_policy: { ms: 1, on_timeout: 'soft-warning' },
      }],
    });
    const tools = { t: () => new Promise(() => {}) };
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5)));
    const out = await runGraph({ graph, tools, sleep });
    assert.equal(graph.nodes[0].state, 'done');
    assert.match(graph.nodes[0].error, /timed out/);
    assert.equal(out.outcome, 'done');
  });

  it('on_timeout="cancel-downstream" cancels descendants', async () => {
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', timeout_policy: { ms: 1, on_timeout: 'cancel-downstream' } },
        { id: 'b', tool: 't', depends_on: ['a'] },
        { id: 'c', tool: 't', depends_on: ['b'] },
      ],
    });
    const tools = {
      t: (_inputs, ctx) => ctx.node.id === 'a'
        ? new Promise(() => {})   // hangs
        : Promise.resolve('ok'),
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5)));
    const out = await runGraph({ graph, tools, sleep });
    assert.equal(graph.nodes.find(n => n.id === 'a').state, 'failed');
    assert.equal(graph.nodes.find(n => n.id === 'b').state, 'cancelled');
    assert.equal(graph.nodes.find(n => n.id === 'c').state, 'cancelled');
    assert.equal(out.outcome, 'failed');
  });
});

describe('runGraph · deadlock detection', () => {
  it('marks pending nodes as failed when nothing is ready (upstream failure cascade)', async () => {
    // a fails, b depends on a → b stuck.
    const graph = buildExecutionGraph({
      nodes: [
        {
          id: 'a', tool: 't',
          retry_policy: { max_retries: 0, on_error: 'retry-then-fail' },
        },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    const tools = {
      t: (_inputs, ctx) => ctx.node.id === 'a'
        ? Promise.reject(new Error('fail'))
        : Promise.resolve('ok'),
    };
    const out = await runGraph({ graph, tools, sleep: fastSleep });
    assert.equal(graph.nodes.find(n => n.id === 'a').state, 'failed');
    assert.equal(graph.nodes.find(n => n.id === 'b').state, 'failed');
    assert.match(graph.nodes.find(n => n.id === 'b').error, /blocked-by-upstream-failure/);
    assert.equal(out.outcome, 'failed');
  });
});

describe('runGraph · abort signal', () => {
  it('cancels pending nodes when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const graph = buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't' }, { id: 'b', tool: 't' }],
    });
    await runGraph({
      graph, tools: { t: async () => 'ok' },
      sleep: fastSleep, signal: ac.signal,
    });
    for (const n of graph.nodes) {
      assert.equal(n.state, 'cancelled');
    }
  });
});

// ── cancelDownstream ──────────────────────────────────────────

describe('cancelDownstream', () => {
  it('marks transitive descendants as cancelled', () => {
    const graph = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't' },
        { id: 'b', tool: 't', depends_on: ['a'] },
        { id: 'c', tool: 't', depends_on: ['b'] },
        { id: 'd', tool: 't' },  // unrelated
      ],
    });
    cancelDownstream(graph, 'a');
    assert.equal(graph.nodes.find(n => n.id === 'b').state, 'cancelled');
    assert.equal(graph.nodes.find(n => n.id === 'c').state, 'cancelled');
    // Unrelated node untouched.
    assert.equal(graph.nodes.find(n => n.id === 'd').state, 'pending');
  });
});

// ── resumeGraph ───────────────────────────────────────────────

describe('resumeGraph', () => {
  it('throws when adapter or graphId missing', async () => {
    await assert.rejects(
      () => resumeGraph({ tools: {} }),
      /adapter \+ graphId required/,
    );
  });

  it('throws when no saved state exists', async () => {
    const adapter = createInMemoryAdapter();
    await assert.rejects(
      () => resumeGraph({ adapter, graphId: 'missing', tools: {} }),
      /no saved state/,
    );
  });

  it('flips "running" nodes back to "pending" and re-runs them', async () => {
    const adapter = createInMemoryAdapter();
    // Hand-craft a graph snapshot where node "a" is mid-run.
    const partial = buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't', state: 'running', attempt: 1 }],
    });
    await adapter.save('g1', partial);
    const ran = [];
    const out = await resumeGraph({
      adapter, graphId: 'g1',
      tools: { t: async () => { ran.push('a'); return 'recovered'; } },
      sleep: fastSleep,
    });
    assert.equal(out.outcome, 'done');
    assert.deepEqual(ran, ['a']);
  });
});

// ── compileToGraph ────────────────────────────────────────────

describe('compileToGraph', () => {
  it('thin wrapper around buildExecutionGraph', () => {
    const g = compileToGraph({
      nodes: [{ id: 'a', tool: 't' }],
      meta: { taskId: 'tk' },
    });
    assert.equal(g.nodes.length, 1);
    assert.equal(g.meta.taskId, 'tk');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/execution-graph-runner');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'INTERNAL', 'cancelDownstream', 'compileToGraph',
      'createInMemoryAdapter', 'resumeGraph', 'runGraph',
    ]);
  });
});
