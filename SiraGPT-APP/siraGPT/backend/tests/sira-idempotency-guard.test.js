/**
 * Tests for services/sira/idempotency-guard.js — per-run dedup of
 * side-effecting tool invocations.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createRunIdempotencyGuard,
  buildToolInvocationKey,
  shouldGuardTool,
  stableStringify,
} = require('../src/services/sira/idempotency-guard');

// ── stableStringify ─────────────────────────────────────────────

describe('stableStringify', () => {
  it('serialises primitives via JSON.stringify', () => {
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(42), '42');
    assert.equal(stableStringify('hi'), '"hi"');
    assert.equal(stableStringify(true), 'true');
  });

  it('serialises arrays recursively', () => {
    assert.equal(stableStringify([1, 'a', null]), '[1,"a",null]');
  });

  it('sorts object keys for canonical output', () => {
    const a = stableStringify({ b: 1, a: 2, c: 3 });
    const b = stableStringify({ a: 2, c: 3, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1,"c":3}');
  });

  it('recurses into nested objects + arrays', () => {
    const s = stableStringify({ x: { z: 1, y: 2 }, arr: [{ b: 1, a: 2 }] });
    assert.equal(s, '{"arr":[{"a":2,"b":1}],"x":{"y":2,"z":1}}');
  });

  it('two semantically-equal objects produce identical output', () => {
    const a = stableStringify({ x: 1, y: { k: 'v' } });
    const b = stableStringify({ y: { k: 'v' }, x: 1 });
    assert.equal(a, b);
  });
});

// ── shouldGuardTool ────────────────────────────────────────────

describe('shouldGuardTool', () => {
  it('returns false for null/missing tool', () => {
    assert.equal(shouldGuardTool(null), false);
    assert.equal(shouldGuardTool(undefined), false);
  });

  it('returns false for tools with no permissions', () => {
    assert.equal(shouldGuardTool({}), false);
    assert.equal(shouldGuardTool({ manifest: {} }), false);
  });

  it('returns true when permissions include "write_artifact"', () => {
    assert.equal(shouldGuardTool({
      permissionsRequired: ['write_artifact'],
    }), true);
  });

  it('returns true when permissions_required (snake_case) includes write_artifact', () => {
    assert.equal(shouldGuardTool({
      permissions_required: ['write_artifact'],
    }), true);
  });

  it('returns true when manifest.scopes includes write_artifact', () => {
    assert.equal(shouldGuardTool({
      manifest: { scopes: ['write_artifact'] },
    }), true);
  });

  it('returns true for sideEffectLevel="writes_new_artifact"', () => {
    assert.equal(shouldGuardTool({
      manifest: { sideEffectLevel: 'writes_new_artifact' },
    }), true);
  });

  it('returns true for sideEffectLevel="external_side_effect"', () => {
    assert.equal(shouldGuardTool({
      manifest: { sideEffectLevel: 'external_side_effect' },
    }), true);
  });

  it('returns false for sideEffectLevel="none"', () => {
    assert.equal(shouldGuardTool({
      manifest: { sideEffectLevel: 'none' },
    }), false);
  });

  it('returns false for read-only tools (no write_artifact, no side effects)', () => {
    assert.equal(shouldGuardTool({
      permissionsRequired: ['read_rag'],
    }), false);
  });
});

// ── buildToolInvocationKey ─────────────────────────────────────

describe('buildToolInvocationKey', () => {
  it('derives key from envelope.workflow_graph.idempotency_key when present', () => {
    const k = buildToolInvocationKey({
      envelope: { workflow_graph: { idempotency_key: 'graph-1' } },
      toolName: 'create_doc',
      input: { a: 1 },
    });
    assert.match(k, /^graph-1:/);
  });

  it('falls back to envelope.request_id when no workflow_graph.idempotency_key', () => {
    const k = buildToolInvocationKey({
      envelope: { request_id: 'req-42' },
      toolName: 't',
      input: {},
    });
    assert.match(k, /^req-42:/);
  });

  it('uses "cira:runtime" fallback when envelope is null/missing', () => {
    const k1 = buildToolInvocationKey({ envelope: null, toolName: 't', input: {} });
    const k2 = buildToolInvocationKey({ toolName: 't', input: {} });
    assert.match(k1, /^cira:runtime:/);
    assert.match(k2, /^cira:runtime:/);
  });

  it('falls back to "unknown_tool" name when toolName missing', () => {
    const k1 = buildToolInvocationKey({ envelope: { request_id: 'r' }, input: { x: 1 } });
    const k2 = buildToolInvocationKey({ envelope: { request_id: 'r' }, toolName: 'unknown_tool', input: { x: 1 } });
    assert.equal(k1, k2);
  });

  it('hash portion is exactly 24 hex chars', () => {
    const k = buildToolInvocationKey({ toolName: 't', input: { x: 1 } });
    const hash = k.split(':').slice(-1)[0];
    assert.match(hash, /^[0-9a-f]{24}$/);
  });

  it('different inputs → different keys', () => {
    const k1 = buildToolInvocationKey({ toolName: 't', input: { x: 1 } });
    const k2 = buildToolInvocationKey({ toolName: 't', input: { x: 2 } });
    assert.notEqual(k1, k2);
  });

  it('different tools → different keys', () => {
    const k1 = buildToolInvocationKey({ toolName: 'create_doc', input: {} });
    const k2 = buildToolInvocationKey({ toolName: 'send_email', input: {} });
    assert.notEqual(k1, k2);
  });

  it('input-key reordering produces SAME key (stableStringify)', () => {
    const k1 = buildToolInvocationKey({ toolName: 't', input: { a: 1, b: 2 } });
    const k2 = buildToolInvocationKey({ toolName: 't', input: { b: 2, a: 1 } });
    assert.equal(k1, k2);
  });
});

// ── createRunIdempotencyGuard ─────────────────────────────────

describe('createRunIdempotencyGuard', () => {
  const writeTool = { permissionsRequired: ['write_artifact'] };
  const readTool = { permissionsRequired: ['read_rag'] };

  it('check returns unguarded for read-only tool', () => {
    const g = createRunIdempotencyGuard();
    const out = g.check({ toolName: 'read_rag', input: {}, tool: readTool });
    assert.equal(out.guarded, false);
    assert.equal(out.duplicate, false);
    assert.equal(out.key, null);
    assert.equal(out.previous, null);
  });

  it('check returns guarded + duplicate=false for first invocation of side-effecting tool', () => {
    const g = createRunIdempotencyGuard();
    const out = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    assert.equal(out.guarded, true);
    assert.equal(out.duplicate, false);
    assert.ok(out.key);
  });

  it('check returns duplicate=true on second matching invocation after remember()', () => {
    const g = createRunIdempotencyGuard();
    const first = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    g.remember(first.key, { node: 'n1', output: 'doc-id-42' });
    const second = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.previous, {
      node: 'n1', tool: null, status: 'success',
      output: 'doc-id-42', error: null, metadata: {},
    });
  });

  it('different inputs are NOT duplicates of each other', () => {
    const g = createRunIdempotencyGuard();
    const a = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    g.remember(a.key, { node: 'n1' });
    const b = g.check({ toolName: 'create_doc', input: { x: 2 }, tool: writeTool });
    assert.equal(b.duplicate, false);
  });

  it('different tools are NOT duplicates of each other', () => {
    const g = createRunIdempotencyGuard();
    const a = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    g.remember(a.key, { node: 'n1' });
    const b = g.check({ toolName: 'send_email', input: { x: 1 }, tool: writeTool });
    assert.equal(b.duplicate, false);
  });

  it('envelope.workflow_graph.idempotency_key scopes duplicates per run', () => {
    const g1 = createRunIdempotencyGuard({
      envelope: { workflow_graph: { idempotency_key: 'run-A' } },
    });
    const g2 = createRunIdempotencyGuard({
      envelope: { workflow_graph: { idempotency_key: 'run-B' } },
    });
    const a = g1.check({ toolName: 't', input: { x: 1 }, tool: writeTool });
    g1.remember(a.key, {});
    // Different run → not a duplicate.
    const b = g2.check({ toolName: 't', input: { x: 1 }, tool: writeTool });
    assert.equal(b.duplicate, false);
  });

  it('remember() is a no-op when key is null/empty', () => {
    const g = createRunIdempotencyGuard();
    g.remember(null, { node: 'n' });
    g.remember('', { node: 'n' });
    assert.equal(g.snapshot().guarded_invocations, 0);
  });

  it('remember() freezes the stored record (cannot mutate previous)', () => {
    const g = createRunIdempotencyGuard();
    const first = g.check({ toolName: 't', input: {}, tool: writeTool });
    g.remember(first.key, { output: { mutable: 'no' } });
    const second = g.check({ toolName: 't', input: {}, tool: writeTool });
    assert.throws(() => { second.previous.node = 'hack'; }, TypeError);
  });

  it('remember() deep-clones the output (caller mutation isolated)', () => {
    const g = createRunIdempotencyGuard();
    const first = g.check({ toolName: 't', input: {}, tool: writeTool });
    const output = { nested: { value: 'original' } };
    g.remember(first.key, { output });
    output.nested.value = 'mutated';
    const second = g.check({ toolName: 't', input: {}, tool: writeTool });
    assert.equal(second.previous.output.nested.value, 'original');
  });

  it('snapshot returns { guarded_invocations, keys }', () => {
    const g = createRunIdempotencyGuard();
    const a = g.check({ toolName: 'create_doc', input: { x: 1 }, tool: writeTool });
    const b = g.check({ toolName: 'send_email', input: {}, tool: writeTool });
    g.remember(a.key, {});
    g.remember(b.key, {});
    const snap = g.snapshot();
    assert.equal(snap.guarded_invocations, 2);
    assert.equal(snap.keys.length, 2);
  });

  it('record status defaults to "success" when omitted', () => {
    const g = createRunIdempotencyGuard();
    const first = g.check({ toolName: 't', input: {}, tool: writeTool });
    g.remember(first.key, {});
    const second = g.check({ toolName: 't', input: {}, tool: writeTool });
    assert.equal(second.previous.status, 'success');
  });

  it('record metadata defaults to {} when omitted', () => {
    const g = createRunIdempotencyGuard();
    const first = g.check({ toolName: 't', input: {}, tool: writeTool });
    g.remember(first.key, {});
    const second = g.check({ toolName: 't', input: {}, tool: writeTool });
    assert.deepEqual(second.previous.metadata, {});
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/sira/idempotency-guard');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'buildToolInvocationKey', 'createRunIdempotencyGuard',
      'shouldGuardTool', 'stableStringify',
    ]);
  });
});
