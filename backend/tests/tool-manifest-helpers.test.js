/**
 * Coverage for the runtime helpers exported by tool-manifest:
 * registerToolManifest / unregisterToolManifest / authorizeToolCall.
 *
 * These are additive APIs that the file's docstring promised but
 * the older revision only exposed validateManifest/getManifest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authorizeToolCall,
  getManifest,
  listManifests,
  registerToolManifest,
  unregisterToolManifest,
} = require('../src/services/agents/tool-manifest');

const VALID_MANIFEST = {
  name: 'test_tool_xyz',
  purpose: 'A throwaway manifest used by the registration test suite — must be at least ten chars.',
  inputs: { type: 'object', properties: { a: { type: 'string' } } },
  outputs: { type: 'object', properties: { ok: { type: 'boolean' } } },
  allowed_formats: [],
  forbidden_formats: [],
  expected_errors: [{ code: 'oops', description: 'something went wrong' }],
  acceptance_tests: ['returns ok:true on the happy path'],
  usage_limits: { timeout_ms_default: 1000, timeout_ms_max: 5000, max_calls_per_task: 1, requires_auth: false, requires_network: false },
  examples_positive: [{ when: 'unit test', call: { a: 'hi' } }],
  examples_negative: [{ when: 'integration test', why: 'this manifest is not for production' }],
  recovery_policy: { on_timeout: 'return ok:false', on_error: 'return ok:false' },
};

test('registerToolManifest accepts a valid manifest and exposes it', () => {
  unregisterToolManifest('test_tool_xyz');
  const result = registerToolManifest({ ...VALID_MANIFEST });
  assert.equal(result.name, 'test_tool_xyz');
  assert.ok(getManifest('test_tool_xyz'));
  assert.ok(listManifests().some((m) => m.name === 'test_tool_xyz'));
  unregisterToolManifest('test_tool_xyz');
});

test('registerToolManifest rejects invalid manifests', () => {
  assert.throws(() => registerToolManifest({ ...VALID_MANIFEST, purpose: '' }), /invalid manifest/);
});

test('registerToolManifest refuses duplicates unless overwrite is set', () => {
  unregisterToolManifest('test_tool_xyz');
  registerToolManifest({ ...VALID_MANIFEST });
  assert.throws(() => registerToolManifest({ ...VALID_MANIFEST }), /duplicate/);
  // Overwrite should succeed
  const updated = registerToolManifest({ ...VALID_MANIFEST, purpose: VALID_MANIFEST.purpose + ' (updated copy)' }, { overwrite: true });
  assert.match(updated.purpose, /updated copy/);
  unregisterToolManifest('test_tool_xyz');
});

test('authorizeToolCall blocks unknown tools', () => {
  const result = authorizeToolCall('does_not_exist', { scopes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_tool');
});

test('authorizeToolCall blocks missing scopes', () => {
  // generate_image declares ai.image scope
  const result = authorizeToolCall('generate_image', { scopes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_scopes');
  assert.deepEqual(result.missingScopes, ['ai.image']);
});

test('authorizeToolCall succeeds when scopes are held', () => {
  const result = authorizeToolCall('generate_image', { scopes: ['ai.image'] });
  assert.equal(result.ok, true);
});

test('authorizeToolCall blocks data classes outside clearance', () => {
  // docintel_compare touches internal+confidential
  const result = authorizeToolCall('docintel_compare', {
    scopes: ['files.read', 'rag.read'],
    dataClearance: ['public'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'data_class_denied');
  assert.ok(result.blockedClasses.length >= 1);
});

test('authorizeToolCall enforces requires_confirmation when set', () => {
  unregisterToolManifest('confirmable_tool');
  registerToolManifest({
    ...VALID_MANIFEST,
    name: 'confirmable_tool',
    requires_confirmation: true,
  });
  const denied = authorizeToolCall('confirmable_tool', { scopes: [] });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'requires_confirmation');
  const allowed = authorizeToolCall('confirmable_tool', { scopes: [], approvalGranted: true });
  assert.equal(allowed.ok, true);
  unregisterToolManifest('confirmable_tool');
});

test('authorizeToolCall enforces destructive side-effects without approval', () => {
  unregisterToolManifest('destructive_tool');
  registerToolManifest({
    ...VALID_MANIFEST,
    name: 'destructive_tool',
    side_effect_level: 'destructive',
  });
  const denied = authorizeToolCall('destructive_tool', { scopes: [] });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'destructive_requires_approval');
  unregisterToolManifest('destructive_tool');
});
