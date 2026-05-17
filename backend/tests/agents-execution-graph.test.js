/**
 * Tests for services/agents/execution-graph.js — typed DAG over the
 * UniversalTaskContract.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  NODE_STATES, ON_ERROR_POLICIES, ON_TIMEOUT_POLICIES,
  DEFAULT_RETRY, DEFAULT_TIMEOUT, DEFAULT_COST_BUDGET, DEFAULT_LATENCY_BUDGET,
  makeNode, validateGraph, topoSort, buildExecutionGraph,
  countStates, readyNodes, transitionNode, isComplete, overallOutcome,
  hashIdempotency,
} = require('../src/services/agents/execution-graph');

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('NODE_STATES is the documented 7-state list', () => {
    assert.deepEqual([...NODE_STATES], [
      'pending', 'running', 'done', 'failed', 'retrying', 'cancelled', 'skipped',
    ]);
  });

  it('ON_ERROR_POLICIES is the documented 5-value list', () => {
    assert.deepEqual([...ON_ERROR_POLICIES], [
      'fail-fast', 'continue', 'retry-then-fail', 'retry-then-skip', 'rollback',
    ]);
  });

  it('ON_TIMEOUT_POLICIES is the documented 3-value list', () => {
    assert.deepEqual([...ON_TIMEOUT_POLICIES], [
      'fail', 'soft-warning', 'cancel-downstream',
    ]);
  });

  it('DEFAULT_RETRY = 2 retries, 1.5s backoff', () => {
    assert.equal(DEFAULT_RETRY.max_retries, 2);
    assert.equal(DEFAULT_RETRY.backoff_ms, 1500);
    assert.equal(DEFAULT_RETRY.on_error, 'retry-then-fail');
  });

  it('DEFAULT_TIMEOUT = 60s with on_timeout=fail', () => {
    assert.equal(DEFAULT_TIMEOUT.ms, 60000);
    assert.equal(DEFAULT_TIMEOUT.on_timeout, 'fail');
  });
});

// ── makeNode ────────────────────────────────────────────────────

describe('makeNode · validation', () => {
  it('throws on null/non-object descriptor', () => {
    assert.throws(() => makeNode(null), /descriptor required/);
    assert.throws(() => makeNode('not-object'), /descriptor required/);
  });

  it('throws on missing id', () => {
    assert.throws(() => makeNode({ tool: 't' }), /id is required/);
  });

  it('throws on non-conforming id (must be [a-zA-Z]...)', () => {
    assert.throws(() => makeNode({ id: '1bad', tool: 't' }), /must match/);
    assert.throws(() => makeNode({ id: '-bad', tool: 't' }), /must match/);
    assert.throws(() => makeNode({ id: 'has spaces', tool: 't' }), /must match/);
  });

  it('throws on missing tool', () => {
    assert.throws(() => makeNode({ id: 'n1' }), /tool required/);
  });

  it('throws on non-string depends_on entries', () => {
    assert.throws(
      () => makeNode({ id: 'n1', tool: 't', depends_on: [null, 'ok'] }),
      /depends_on must be strings/,
    );
  });

  it('throws on unknown on_error policy', () => {
    assert.throws(
      () => makeNode({ id: 'n1', tool: 't', retry_policy: { on_error: 'wat' } }),
      /unknown on_error/,
    );
  });

  it('throws on unknown on_timeout policy', () => {
    assert.throws(
      () => makeNode({ id: 'n1', tool: 't', timeout_policy: { on_timeout: 'nope' } }),
      /unknown on_timeout/,
    );
  });
});

describe('makeNode · happy path + defaults', () => {
  it('returns a fully-formed node from a minimal descriptor', () => {
    const n = makeNode({ id: 'n1', tool: 'create_document' });
    assert.equal(n.id, 'n1');
    assert.equal(n.tool, 'create_document');
    assert.equal(n.label, 'n1');  // defaults to id
    assert.deepEqual(n.inputs, {});
    assert.deepEqual(n.outputs, {});
    assert.deepEqual(n.depends_on, []);
    assert.equal(n.state, 'pending');
    assert.equal(n.attempt, 0);
    assert.ok(n.idempotency_key);
    assert.equal(n.retry_policy.max_retries, 2);
    assert.equal(n.timeout_policy.ms, 60000);
    assert.deepEqual(n.validation_gate, { tests: [], blocking: true });
    assert.deepEqual(n.release_gate, { requires_human: false, approvers: [] });
  });

  it('label override honoured', () => {
    const n = makeNode({ id: 'n1', tool: 't', label: 'Make the thing' });
    assert.equal(n.label, 'Make the thing');
  });

  it('merges custom retry policy with defaults', () => {
    const n = makeNode({ id: 'n1', tool: 't', retry_policy: { max_retries: 5 } });
    assert.equal(n.retry_policy.max_retries, 5);
    assert.equal(n.retry_policy.backoff_ms, 1500);  // default kept
  });

  it('validation_gate accepts tests array + blocking flag', () => {
    const n = makeNode({
      id: 'n1', tool: 't',
      validation_gate: { tests: ['t1', 't2'], blocking: false },
    });
    assert.deepEqual(n.validation_gate.tests, ['t1', 't2']);
    assert.equal(n.validation_gate.blocking, false);
  });

  it('release_gate accepts requires_human + approvers', () => {
    const n = makeNode({
      id: 'n1', tool: 't',
      release_gate: { requires_human: true, approvers: ['alice', 'bob'] },
    });
    assert.equal(n.release_gate.requires_human, true);
    assert.deepEqual(n.release_gate.approvers, ['alice', 'bob']);
  });

  it('idempotency_key is stable for identical descriptors', () => {
    const a = makeNode({ id: 'n1', tool: 't', inputs: { x: 1 } });
    const b = makeNode({ id: 'n2', tool: 't', inputs: { x: 1 } });
    assert.equal(a.idempotency_key, b.idempotency_key);
  });

  it('different inputs → different idempotency_key', () => {
    const a = makeNode({ id: 'n1', tool: 't', inputs: { x: 1 } });
    const b = makeNode({ id: 'n2', tool: 't', inputs: { x: 2 } });
    assert.notEqual(a.idempotency_key, b.idempotency_key);
  });

  it('honours explicit idempotency_key override', () => {
    const n = makeNode({ id: 'n1', tool: 't', idempotency_key: 'custom-key' });
    assert.equal(n.idempotency_key, 'custom-key');
  });

  it('unknown initial state falls back to "pending"', () => {
    const n = makeNode({ id: 'n1', tool: 't', state: 'wat' });
    assert.equal(n.state, 'pending');
  });
});

// ── hashIdempotency ────────────────────────────────────────────

describe('hashIdempotency', () => {
  it('produces a 16-hex-char hash', () => {
    const h = hashIdempotency({ tool: 't', inputs: {}, depends_on: [] });
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('different tools → different hashes', () => {
    const a = hashIdempotency({ tool: 't1', inputs: {} });
    const b = hashIdempotency({ tool: 't2', inputs: {} });
    assert.notEqual(a, b);
  });
});

// ── validateGraph ──────────────────────────────────────────────

describe('validateGraph', () => {
  it('throws on non-array input', () => {
    assert.throws(() => validateGraph('not-array'), /must be an array/);
  });

  it('throws on non-object node', () => {
    assert.throws(() => validateGraph([null]), /node must be an object/);
  });

  it('throws on duplicate id', () => {
    assert.throws(
      () => validateGraph([{ id: 'n1' }, { id: 'n1' }]),
      /duplicate node id/,
    );
  });

  it('throws when node depends on itself', () => {
    assert.throws(
      () => validateGraph([{ id: 'n1', depends_on: ['n1'] }]),
      /depends on itself/,
    );
  });

  it('throws when node depends on missing id', () => {
    assert.throws(
      () => validateGraph([{ id: 'n1', depends_on: ['missing'] }]),
      /depends on missing/,
    );
  });

  it('detects cycles', () => {
    assert.throws(
      () => validateGraph([
        { id: 'a', depends_on: ['c'] },
        { id: 'b', depends_on: ['a'] },
        { id: 'c', depends_on: ['b'] },
      ]),
      /cycle detected/,
    );
  });

  it('accepts a valid DAG', () => {
    assert.equal(validateGraph([
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a', 'b'] },
    ]), true);
  });
});

// ── topoSort ───────────────────────────────────────────────────

describe('topoSort', () => {
  it('returns ids in legal execution order', () => {
    const order = topoSort([
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['b'] },
    ]);
    assert.deepEqual(order, ['a', 'b', 'c']);
  });

  it('throws on cycle (via validateGraph)', () => {
    assert.throws(() => topoSort([
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['a'] },
    ]), /cycle/);
  });
});

// ── buildExecutionGraph ───────────────────────────────────────

describe('buildExecutionGraph', () => {
  it('returns a fully-formed graph with version + meta + nodes + order + counts', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't1' },
        { id: 'b', tool: 't2', depends_on: ['a'] },
      ],
      meta: { taskId: 'tk-1' },
    });
    assert.equal(g.version, '1.0');
    assert.deepEqual(g.meta, { taskId: 'tk-1' });
    assert.equal(g.nodes.length, 2);
    assert.deepEqual(g.order, ['a', 'b']);
    assert.equal(g.counts.pending, 2);
    assert.ok(!isNaN(new Date(g.createdAt).getTime()));
  });

  it('meta defaults to {}', () => {
    const g = buildExecutionGraph({ nodes: [{ id: 'a', tool: 't' }] });
    assert.deepEqual(g.meta, {});
  });
});

// ── countStates ───────────────────────────────────────────────

describe('countStates', () => {
  it('counts each state bucket', () => {
    const counts = countStates([
      { state: 'pending' }, { state: 'pending' },
      { state: 'running' },
      { state: 'done' }, { state: 'done' }, { state: 'done' },
      { state: 'failed' },
    ]);
    assert.equal(counts.pending, 2);
    assert.equal(counts.running, 1);
    assert.equal(counts.done, 3);
    assert.equal(counts.failed, 1);
    assert.equal(counts.retrying, 0);
    assert.equal(counts.cancelled, 0);
    assert.equal(counts.skipped, 0);
  });

  it('ignores unknown state values', () => {
    const counts = countStates([{ state: 'made-up' }, { state: 'done' }]);
    assert.equal(counts.done, 1);
    // No throw, no key for "made-up".
    assert.ok(!('made-up' in counts));
  });

  it('returns zero map for empty input', () => {
    assert.deepEqual(countStates([]), {
      pending: 0, running: 0, done: 0, failed: 0,
      retrying: 0, cancelled: 0, skipped: 0,
    });
  });
});

// ── readyNodes ────────────────────────────────────────────────

describe('readyNodes', () => {
  it('returns root nodes (no deps) initially', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't' },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    assert.deepEqual(readyNodes(g), ['a']);
  });

  it('returns dependents once their parents are done', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    assert.deepEqual(readyNodes(g), ['b']);
  });

  it('skipped parents also unblock dependents', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'skipped' },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    assert.deepEqual(readyNodes(g), ['b']);
  });

  it('failed parent does NOT unblock dependents', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'failed' },
        { id: 'b', tool: 't', depends_on: ['a'] },
      ],
    });
    assert.deepEqual(readyNodes(g), []);
  });
});

// ── transitionNode ────────────────────────────────────────────

describe('transitionNode', () => {
  function freshGraph() {
    return buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't' }, { id: 'b', tool: 't' }],
    });
  }

  it('throws on unknown node id', () => {
    assert.throws(
      () => transitionNode(freshGraph(), 'missing', 'running'),
      /not found/,
    );
  });

  it('throws on unknown next state', () => {
    assert.throws(
      () => transitionNode(freshGraph(), 'a', 'invalid'),
      /unknown state/,
    );
  });

  it('throws on illegal pending → done transition', () => {
    assert.throws(
      () => transitionNode(freshGraph(), 'a', 'done'),
      /illegal transition/,
    );
  });

  it('legal pending → running → done', () => {
    const g = freshGraph();
    transitionNode(g, 'a', 'running');
    transitionNode(g, 'a', 'done', { result: 'ok' });
    const n = g.nodes.find(x => x.id === 'a');
    assert.equal(n.state, 'done');
    assert.equal(n.result, 'ok');
    assert.ok(n.startedAt);
    assert.ok(n.finishedAt);
  });

  it('legal running → failed → retrying → running', () => {
    const g = freshGraph();
    transitionNode(g, 'a', 'running');
    transitionNode(g, 'a', 'failed', { error: 'oops' });
    const n1 = g.nodes.find(x => x.id === 'a');
    assert.equal(n1.error, 'oops');
    transitionNode(g, 'a', 'retrying');
    transitionNode(g, 'a', 'running');
    const n2 = g.nodes.find(x => x.id === 'a');
    assert.equal(n2.state, 'running');
  });

  it('terminal states (done/cancelled/skipped) reject further transitions', () => {
    const g = freshGraph();
    transitionNode(g, 'a', 'running');
    transitionNode(g, 'a', 'done');
    assert.throws(() => transitionNode(g, 'a', 'running'), /illegal/);
    assert.throws(() => transitionNode(g, 'a', 'failed'), /illegal/);
  });

  it('updates graph.counts after transition', () => {
    const g = freshGraph();
    assert.equal(g.counts.pending, 2);
    transitionNode(g, 'a', 'running');
    assert.equal(g.counts.pending, 1);
    assert.equal(g.counts.running, 1);
  });

  it('pending → cancelled / skipped / failed all legal', () => {
    for (const next of ['cancelled', 'skipped', 'failed']) {
      const g = freshGraph();
      assert.doesNotThrow(() => transitionNode(g, 'a', next));
    }
  });
});

// ── isComplete + overallOutcome ───────────────────────────────

describe('isComplete', () => {
  it('false when any node is pending/running/retrying', () => {
    const g = buildExecutionGraph({
      nodes: [{ id: 'a', tool: 't' }, { id: 'b', tool: 't' }],
    });
    assert.equal(isComplete(g), false);
    transitionNode(g, 'a', 'running');
    assert.equal(isComplete(g), false);
  });

  it('true when every node is done/failed/cancelled/skipped', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', state: 'failed' },
        { id: 'c', tool: 't', state: 'cancelled' },
        { id: 'd', tool: 't', state: 'skipped' },
      ],
    });
    assert.equal(isComplete(g), true);
  });
});

describe('overallOutcome', () => {
  it('returns "in-progress" when not complete', () => {
    const g = buildExecutionGraph({ nodes: [{ id: 'a', tool: 't' }] });
    assert.equal(overallOutcome(g), 'in-progress');
  });

  it('returns "failed" when any node failed', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', state: 'failed' },
      ],
    });
    assert.equal(overallOutcome(g), 'failed');
  });

  it('returns "cancelled" when any cancelled (and none failed)', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', state: 'cancelled' },
      ],
    });
    assert.equal(overallOutcome(g), 'cancelled');
  });

  it('returns "done" when all done/skipped (no failures, no cancellations)', () => {
    const g = buildExecutionGraph({
      nodes: [
        { id: 'a', tool: 't', state: 'done' },
        { id: 'b', tool: 't', state: 'skipped' },
      ],
    });
    assert.equal(overallOutcome(g), 'done');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/execution-graph');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'DEFAULT_COST_BUDGET', 'DEFAULT_LATENCY_BUDGET',
      'DEFAULT_RETRY', 'DEFAULT_TIMEOUT',
      'NODE_STATES', 'ON_ERROR_POLICIES', 'ON_TIMEOUT_POLICIES',
      'buildExecutionGraph', 'countStates', 'hashIdempotency',
      'isComplete', 'makeNode', 'overallOutcome', 'readyNodes',
      'topoSort', 'transitionNode', 'validateGraph',
    ]);
  });
});
