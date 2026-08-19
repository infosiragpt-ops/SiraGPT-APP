'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beforeToolCall,
  resolveSecrets,
  stripSecretRefs,
  scopeRank,
  maxScopeRank,
  DEFAULT_TOOL_SCOPES,
} = require('../src/auth/hooks');

const memberCtx = { userId: 'u1', scopes: ['member'] };
const ownerCtx = { userId: 'u2', scopes: ['owner'] };
const adminCtx = { userId: 'u3', scopes: ['admin'] };

test('scope hierarchy ranks admin > owner > member', () => {
  assert.equal(scopeRank('member'), 0);
  assert.equal(scopeRank('owner'), 1);
  assert.equal(scopeRank('admin'), 2);
  assert.equal(scopeRank('unknown'), -1);
  assert.equal(maxScopeRank(['member', 'admin']), 2);
  assert.equal(maxScopeRank([]), -1);
});

test('denies when ctx lacks userId', () => {
  const r = beforeToolCall({}, { name: 'web_search' }, { q: 'hi' });
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'UNAUTHENTICATED');
});

test('denies an unknown tool with no name', () => {
  const r = beforeToolCall(memberCtx, null, {});
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'UNKNOWN_TOOL');
});

test('allows a member-scope tool to a member', () => {
  const r = beforeToolCall(memberCtx, { name: 'web_search' }, { q: 'cats' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.tool, 'web_search');
  assert.deepEqual(r.args, { q: 'cats' });
});

test('denies bash_exec to non-admin (privilege escalation block)', () => {
  const r = beforeToolCall(ownerCtx, { name: 'bash_exec' }, { cmd: 'ls' });
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'SCOPE_DENIED');
  assert.match(r.reason, /admin/);
});

test('allows bash_exec to admin', () => {
  const r = beforeToolCall(adminCtx, { name: 'bash_exec' }, { cmd: 'ls' });
  assert.equal(r.decision, 'allow');
});

test('per-tool metadata.scope overrides static default', () => {
  // run_tests defaults to 'owner'; here we tighten it to 'admin'
  const tool = { name: 'run_tests', metadata: { scope: 'admin' } };
  assert.equal(beforeToolCall(ownerCtx, tool, {}).decision, 'deny');
  assert.equal(beforeToolCall(adminCtx, tool, {}).decision, 'allow');
});

test('unknown tool name defaults to member scope', () => {
  const r = beforeToolCall(memberCtx, { name: 'brand_new_tool' }, {});
  assert.equal(r.decision, 'allow');
});

test('allowlist denies arg outside the allowlist', () => {
  const tool = {
    name: 'web_search',
    metadata: { allow: { domain: ['example.com', 're:^docs\\.'] } },
  };
  const denied = beforeToolCall(memberCtx, tool, { q: 'x', domain: 'evil.com' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.code, 'ALLOWLIST_DENIED');

  const allowed = beforeToolCall(memberCtx, tool, { q: 'x', domain: 'example.com' });
  assert.equal(allowed.decision, 'allow');

  const regexAllowed = beforeToolCall(memberCtx, tool, { q: 'x', domain: 'docs.python.org' });
  assert.equal(regexAllowed.decision, 'allow');
});

test('allowlist ignores keys not present in args', () => {
  const tool = {
    name: 'web_search',
    metadata: { allow: { domain: ['only.com'] } },
  };
  const r = beforeToolCall(memberCtx, tool, { q: 'no domain' });
  assert.equal(r.decision, 'allow');
});

test('stripSecretRefs replaces $secret nodes and tracks pointers', () => {
  const input = {
    headers: { Authorization: { $secret: 'OPENAI_KEY' } },
    nested: [{ $secret: 'AWS_KEY' }],
    plain: 'unchanged',
  };
  const { args, refs } = stripSecretRefs(input);
  assert.equal(args.headers.Authorization.__secret_ref__, 'OPENAI_KEY');
  assert.equal(args.nested[0].__secret_ref__, 'AWS_KEY');
  assert.equal(args.plain, 'unchanged');
  assert.equal(refs.length, 2);
  const names = refs.map((r) => r.name).sort();
  assert.deepEqual(names, ['AWS_KEY', 'OPENAI_KEY']);
});

test('beforeToolCall returns transform when args carry secret refs', () => {
  const args = { headers: { Authorization: { $secret: 'OPENAI_KEY' } }, q: 'hi' };
  const r = beforeToolCall(memberCtx, { name: 'web_search' }, args);
  assert.equal(r.decision, 'transform');
  assert.equal(r.refs.length, 1);
  assert.equal(r.args.headers.Authorization.__secret_ref__, 'OPENAI_KEY');
  // crucial: original raw secret marker stripped from sanitized args
  assert.equal(r.args.headers.Authorization.$secret, undefined);
});

test('resolveSecrets replaces sentinels using a function store', () => {
  const args = { headers: { Authorization: { __secret_ref__: 'KEY' } } };
  const refs = [{ pointer: '/headers/Authorization', name: 'KEY' }];
  const out = resolveSecrets(args, refs, (name) => (name === 'KEY' ? 'sk-secret' : undefined));
  assert.equal(out.headers.Authorization, 'sk-secret');
  // original arg object is not mutated
  assert.deepEqual(args.headers.Authorization, { __secret_ref__: 'KEY' });
});

test('resolveSecrets supports an object store with .get', () => {
  const refs = [{ pointer: '/token', name: 'X' }];
  const out = resolveSecrets({ token: { __secret_ref__: 'X' } }, refs, {
    get: (n) => (n === 'X' ? 'val' : undefined),
  });
  assert.equal(out.token, 'val');
});

test('resolveSecrets fails closed when secret missing', () => {
  const refs = [{ pointer: '/token', name: 'NOPE' }];
  assert.throws(
    () => resolveSecrets({ token: { __secret_ref__: 'NOPE' } }, refs, () => undefined),
    /not found/,
  );
});

test('escalation: superAdmin flag implies admin scope', () => {
  const ctx = { userId: 'su', isSuperAdmin: true };
  const r = beforeToolCall(ctx, { name: 'bash_exec' }, { cmd: 'ls' });
  assert.equal(r.decision, 'allow');
});

test('default scope map covers the tools wired into the runtime', () => {
  for (const name of ['bash_exec', 'python_exec', 'run_tests', 'web_search', 'create_document']) {
    assert.ok(DEFAULT_TOOL_SCOPES[name], `missing default scope for ${name}`);
  }
});

test('transform path is itself subject to scope check', () => {
  const args = { cmd: 'ls', env: { TOKEN: { $secret: 'X' } } };
  const r = beforeToolCall(ownerCtx, { name: 'bash_exec' }, args);
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'SCOPE_DENIED');
});
