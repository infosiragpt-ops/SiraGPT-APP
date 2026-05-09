'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createAuthorizationGate,
  isTerminalReason,
} = require('../src/services/agents/tool-authorization-gate');

function fakeManifestStore(map) {
  return {
    getManifest: (name) => map[name] || null,
    authorizeToolCall: (name, ctx) => {
      const m = map[name];
      if (!m) return { ok: false, reason: 'unknown_tool' };
      const required = m.scopes || [];
      const held = new Set(ctx.scopes || []);
      const missing = required.filter((s) => !held.has(s));
      if (missing.length) return { ok: false, reason: 'missing_scopes', missingScopes: missing };
      return { ok: true };
    },
  };
}

describe('tool-authorization-gate', () => {
  test('rejects invalid tool name early', () => {
    const gate = createAuthorizationGate({});
    assert.deepEqual(gate.authorize(''), { ok: false, reason: 'invalid_tool_name' });
    assert.deepEqual(gate.authorize(null), { ok: false, reason: 'invalid_tool_name' });
  });

  test('passes through manifest deny verbatim', () => {
    const store = fakeManifestStore({});
    const gate = createAuthorizationGate({ getManifest: store.getManifest, authorize: store.authorizeToolCall });
    const r = gate.authorize('tavily_search', { scopes: [] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_tool');
  });

  test('denies on missing scopes from manifest', () => {
    const store = fakeManifestStore({
      tavily_search: { scopes: ['web.search'], requires_credentials: ['TAVILY_API_KEY'] },
    });
    const gate = createAuthorizationGate({ getManifest: store.getManifest, authorize: store.authorizeToolCall, resolveCredential: () => 'k' });
    const r = gate.authorize('tavily_search', { scopes: [] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_scopes');
  });

  test('resolves credentials from runtime, surfaces missing ones', () => {
    const store = fakeManifestStore({
      tavily_search: { scopes: [], requires_credentials: ['TAVILY_API_KEY', 'OPENAI_API_KEY'] },
    });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      resolveCredential: (name) => (name === 'TAVILY_API_KEY' ? 'tav-123' : null),
    });
    const r = gate.authorize('tavily_search', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_credentials');
    assert.deepEqual(r.missing, ['OPENAI_API_KEY']);
  });

  test('treats empty-string credential as missing', () => {
    const store = fakeManifestStore({
      x: { scopes: [], requires_credentials: ['K'] },
    });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      resolveCredential: () => '',
    });
    const r = gate.authorize('x', {});
    assert.equal(r.reason, 'missing_credentials');
  });

  test('returns ok with resolved credentials and manifest on success', () => {
    const manifestRow = { scopes: [], requires_credentials: ['TAVILY_API_KEY'] };
    const store = fakeManifestStore({ tavily_search: manifestRow });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      resolveCredential: (name) => `secret-${name}`,
    });
    const r = gate.authorize('tavily_search', {});
    assert.equal(r.ok, true);
    assert.equal(r.manifest, manifestRow);
    assert.deepEqual(r.credentials, { TAVILY_API_KEY: 'secret-TAVILY_API_KEY' });
  });

  test('hooks run in order and short-circuit on the first deny', () => {
    const calls = [];
    const store = fakeManifestStore({ x: { scopes: [], requires_credentials: [] } });
    const hookA = (name) => { calls.push('A'); return { ok: true }; };
    const hookB = (name) => { calls.push('B'); return { ok: false, reason: 'rate_limited' }; };
    const hookC = (name) => { calls.push('C'); return { ok: true }; };
    Object.defineProperty(hookB, 'name', { value: 'rate_limit_hook' });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      hooks: [hookA, hookB, hookC],
    });
    const r = gate.authorize('x', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rate_limited');
    assert.equal(r.hookName, 'rate_limit_hook');
    assert.deepEqual(calls, ['A', 'B']);
  });

  test('hook receives manifest and resolved credentials in ctx', () => {
    let seen = null;
    const store = fakeManifestStore({ x: { scopes: [], requires_credentials: ['K'] } });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      resolveCredential: () => 'v',
      hooks: [(_name, ctx) => { seen = ctx; return { ok: true }; }],
    });
    gate.authorize('x', { actor: 'u1' });
    assert.equal(seen.actor, 'u1');
    assert.deepEqual(seen.credentials, { K: 'v' });
    assert.ok(seen.manifest);
  });

  test('throwing hook surfaces hook_threw, not propagates', () => {
    const store = fakeManifestStore({ x: { scopes: [] } });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      hooks: [() => { throw new Error('boom'); }],
    });
    const r = gate.authorize('x', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'hook_threw');
    assert.equal(r.error, 'boom');
  });

  test('throwing resolveCredential treats credential as missing (not a crash)', () => {
    const store = fakeManifestStore({ x: { scopes: [], requires_credentials: ['K'] } });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
      resolveCredential: () => { throw new Error('vault down'); },
    });
    const r = gate.authorize('x', {});
    assert.equal(r.reason, 'missing_credentials');
    assert.deepEqual(r.missing, ['K']);
  });

  test('throwing authorize surfaces authorize_threw', () => {
    const gate = createAuthorizationGate({
      authorize: () => { throw new Error('manifest read failed'); },
    });
    const r = gate.authorize('x', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'authorize_threw');
  });

  test('isTerminalReason includes the canonical deny reasons', () => {
    assert.equal(isTerminalReason('missing_credentials'), true);
    assert.equal(isTerminalReason('hook_denied'), true);
    assert.equal(isTerminalReason('not_a_reason'), false);
  });

  test('no hooks + no required creds + manifest ok → ok:true', () => {
    const store = fakeManifestStore({ x: { scopes: [] } });
    const gate = createAuthorizationGate({
      getManifest: store.getManifest,
      authorize: store.authorizeToolCall,
    });
    const r = gate.authorize('x', {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.credentials, {});
  });
});
