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
  checkOutputFormat,
  checkTimeoutBudget,
  checkToolUsageBudget,
  findToolsByDataClass,
  findToolsByOutputFormat,
  findToolsByScope,
  findToolsBySideEffect,
  getManifest,
  getRegistryStats,
  getRemainingBudget,
  getToolsExceedingBudget,
  incrementToolUsage,
  listManifests,
  summarizeUsage,
  registerToolManifest,
  unregisterToolManifest,
  validateAllBuiltinManifests,
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

test('docintel_analyze is authorized for authenticated document-read sessions', () => {
  const result = authorizeToolCall('docintel_analyze', { scopes: ['files.read', 'rag.read'] });
  assert.equal(result.ok, true);
  assert.ok(findToolsByScope('rag.read').includes('docintel_analyze'));
  assert.equal(findToolsByScope('rag.write').includes('docintel_analyze'), false);
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

test('getRegistryStats summarises the registry', () => {
  const stats = getRegistryStats();
  assert.ok(stats.totalTools > 0);
  assert.ok(typeof stats.bySideEffect === 'object');
  assert.ok(Array.isArray(stats.uniqueScopes));
  assert.ok(Array.isArray(stats.uniqueDataClasses));
  // Several tools require auth (web_search, create_document, docintel_*)
  assert.ok(stats.requiresAuth >= 3);
});

test('checkToolUsageBudget reports remaining headroom and blocks at the cap', () => {
  // python_exec has max_calls_per_task: 120
  const fresh = checkToolUsageBudget('python_exec', {});
  assert.equal(fresh.ok, true);
  assert.equal(fresh.current, 0);
  assert.equal(fresh.max, 120);

  const exhausted = checkToolUsageBudget('python_exec', { python_exec: 120 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, 'budget_exhausted');

  const unknown = checkToolUsageBudget('not_a_real_tool', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown_tool');
});

test('checkOutputFormat enforces forbidden_formats and allowed_formats', () => {
  // web_search has forbidden_formats: ['docx','xlsx','pptx','pdf']
  const denied = checkOutputFormat('web_search', 'report.docx');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'forbidden_format');
  assert.equal(denied.extension, 'docx');

  // create_chart only allows svg
  const wrong = checkOutputFormat('create_chart', 'chart.png');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'format_not_allowed');

  const allowed = checkOutputFormat('create_chart', 'chart.svg');
  assert.equal(allowed.ok, true);
});

test('checkOutputFormat allows an extensionless filename (no false format_not_allowed)', () => {
  // create_chart has a non-empty allowed_formats. An extensionless name used to
  // be treated as extension === the whole name ('chart') via split('.').pop(),
  // so it was wrongly rejected as format_not_allowed. With no real extension
  // there is nothing to enforce → allow.
  const r = checkOutputFormat('create_chart', 'chart');
  assert.equal(r.ok, true, 'extensionless filename must not be rejected');
  // A trailing dot is still "no extension".
  assert.equal(checkOutputFormat('create_chart', 'chart.').ok, true);
  // A real disallowed extension is still rejected.
  assert.equal(checkOutputFormat('create_chart', 'chart.png').ok, false);
});

test('checkTimeoutBudget clamps timeouts that exceed the manifest max', () => {
  // python_exec has timeout_ms_max: 60000
  const within = checkTimeoutBudget('python_exec', 30000);
  assert.equal(within.ok, true);
  assert.equal(within.effectiveMs, 30000);

  const tooLong = checkTimeoutBudget('python_exec', 600000);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'timeout_exceeds_max');
  assert.equal(tooLong.effectiveMs, 60000);

  const noRequest = checkTimeoutBudget('python_exec');
  assert.equal(noRequest.ok, true);
  assert.equal(noRequest.effectiveMs, 10000);

  const unknown = checkTimeoutBudget('not_a_tool', 1000);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown_tool');
});

test('discovery helpers find tools by scope, data class, side effect, and output format', () => {
  // ai.image is held only by generate_image
  const aiImage = findToolsByScope('ai.image');
  assert.ok(aiImage.includes('generate_image'));

  // confidential class is held by docintel_*
  const confidential = findToolsByDataClass('confidential');
  assert.ok(confidential.some((n) => n.startsWith('docintel_')));

  // local-fs side effect should include create_chart
  const localFs = findToolsBySideEffect('local-fs');
  assert.ok(localFs.includes('create_chart'));

  // png output is exclusive to generate_image
  const pngTools = findToolsByOutputFormat('png');
  assert.ok(pngTools.includes('generate_image'));
});

test('validateAllBuiltinManifests reports zero invalid manifests', () => {
  const result = validateAllBuiltinManifests();
  assert.equal(result.ok, true, `invalid: ${JSON.stringify(result.invalid)}`);
});

test('incrementToolUsage tracks counter and flags exhaustion at the manifest cap', () => {
  const usage = {};
  // python_exec has max_calls_per_task: 120 in the built-in manifest.
  const first = incrementToolUsage('python_exec', usage);
  assert.equal(first.ok, true);
  assert.equal(first.current, 1);
  assert.equal(first.exhausted, false);

  // bash_exec cap is 60
  for (let i = 0; i < 60; i++) incrementToolUsage('bash_exec', usage);
  assert.equal(usage.bash_exec, 60);
  const last = incrementToolUsage('bash_exec', usage, 0);
  assert.equal(last.exhausted, true);

  const unknown = incrementToolUsage('does_not_exist', usage);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown_tool');
});

test('getRemainingBudget reports headroom and Infinity for unbounded tools', () => {
  const usage = { python_exec: 5 };
  const remain = getRemainingBudget('python_exec', usage);
  assert.equal(remain.ok, true);
  assert.equal(remain.current, 5);
  assert.equal(remain.max, 120);
  assert.equal(remain.remaining, 115);

  // No-such-tool
  const bad = getRemainingBudget('does_not_exist', usage);
  assert.equal(bad.ok, false);
});

test('create_document allowed_formats has no duplicates', () => {
  const m = getManifest('create_document');
  const seen = new Set();
  for (const ext of m.allowed_formats) {
    assert.equal(seen.has(ext), false, `duplicate ${ext}`);
    seen.add(ext);
  }
});

test('getToolsExceedingBudget surfaces saturated tools', () => {
  // bash_exec cap is 60, web_search cap is 10
  const usage = { bash_exec: 60, web_search: 10, python_exec: 1 };
  const over = getToolsExceedingBudget(usage);
  const names = over.map((row) => row.name).sort();
  assert.ok(names.includes('bash_exec'));
  assert.ok(names.includes('web_search'));
  assert.ok(!names.includes('python_exec'));
});

test('summarizeUsage sorts by saturation descending and ignores zero counts', () => {
  // bash_exec at 50% saturation (30/60), web_search at 80% (8/10), python_exec at ~0.8% (1/120)
  const usage = { bash_exec: 30, web_search: 8, python_exec: 1, never_used: 0 };
  const rows = summarizeUsage(usage);
  const names = rows.map((row) => row.name);
  assert.ok(!names.includes('never_used'));
  assert.equal(rows[0].name, 'web_search');
  assert.ok(rows[0].saturation > rows[1].saturation);
});

test('manifest schema rejects duplicate items in allowed_formats', () => {
  unregisterToolManifest('dupe_check');
  assert.throws(() => {
    registerToolManifest({
      ...VALID_MANIFEST,
      name: 'dupe_check',
      allowed_formats: ['pdf', 'pdf'],
    });
  }, /invalid manifest/);
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
