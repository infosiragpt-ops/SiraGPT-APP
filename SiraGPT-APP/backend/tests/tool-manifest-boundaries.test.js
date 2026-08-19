/**
 * Boundary coverage for the agent tool manifest registry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authorizeToolCall,
  checkOutputFormat,
  checkTimeoutBudget,
  findToolsByOutputFormat,
  getManifest,
  getRegistryStats,
  listManifests,
  registerToolManifest,
  unregisterToolManifest,
  validateManifest,
} = require('../src/services/agents/tool-manifest');

const MANIFEST_NAME = 'boundary_tool';

const VALID_MANIFEST = {
  name: MANIFEST_NAME,
  purpose: 'A boundary-test manifest that exercises validation and registry edge cases.',
  inputs: { type: 'object', properties: { value: { type: 'string' } } },
  outputs: { type: 'object', properties: { ok: { type: 'boolean' } } },
  allowed_formats: ['json'],
  forbidden_formats: ['exe'],
  expected_errors: [{ code: 'bad_input', description: 'The supplied input was invalid.' }],
  acceptance_tests: ['returns ok:true with a JSON artifact'],
  usage_limits: {
    timeout_ms_default: 1000,
    timeout_ms_max: 2000,
    max_calls_per_task: 2,
    requires_auth: false,
    requires_network: false,
  },
  examples_positive: [{ when: 'valid payload', call: { value: 'ok' } }],
  examples_negative: [{ when: 'binary output', why: 'this tool only emits JSON.' }],
  recovery_policy: { on_timeout: 'return ok:false', on_error: 'return ok:false', max_retries: 0 },
  scopes: ['boundary.write'],
  data_classes: ['public'],
};

test('validateManifest rejects extra properties because the schema is strict', () => {
  const result = validateManifest({ ...VALID_MANIFEST, unexpected: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === 'additionalProperties'));
});

test('registerToolManifest rejects non-object inputs and invalid names', () => {
  assert.throws(() => registerToolManifest(null), /manifest must be an object/);
  assert.throws(
    () => registerToolManifest({ ...VALID_MANIFEST, name: 'Bad-Name' }),
    /invalid manifest/,
  );
});

test('registerToolManifest overwrite replaces an existing manifest and unregister reports misses', () => {
  unregisterToolManifest(MANIFEST_NAME);
  try {
    registerToolManifest({ ...VALID_MANIFEST });
    const updated = registerToolManifest({
      ...VALID_MANIFEST,
      purpose: `${VALID_MANIFEST.purpose} Updated copy for overwrite behavior.`,
      allowed_formats: ['json', 'txt'],
    }, { overwrite: true });

    assert.deepEqual(updated.allowed_formats, ['json', 'txt']);
    assert.deepEqual(getManifest(MANIFEST_NAME).allowed_formats, ['json', 'txt']);
  } finally {
    assert.equal(unregisterToolManifest(MANIFEST_NAME), true);
    assert.equal(unregisterToolManifest(MANIFEST_NAME), false);
  }
});

test('listManifests exposes discovery summaries without mutating full manifests', () => {
  const summary = listManifests().find((manifest) => manifest.name === 'python_exec');
  const full = getManifest('python_exec');

  assert.ok(summary);
  assert.equal(summary.name, full.name);
  assert.equal(summary.purpose, full.purpose);
  assert.deepEqual(summary.usage_limits, full.usage_limits);
  assert.equal(Object.hasOwn(summary, 'inputs'), false);
  assert.equal(Object.hasOwn(summary, 'examples_positive'), false);
});

test('checkOutputFormat normalizes uppercase extensions', () => {
  const denied = checkOutputFormat('web_search', 'Research.PDF');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'forbidden_format');
  assert.equal(denied.extension, 'pdf');

  const allowed = checkOutputFormat('generate_image', 'Hero.PNG');
  assert.equal(allowed.ok, true);
});

test('checkTimeoutBudget uses default timeout for invalid requests', () => {
  for (const requested of [undefined, 0, -1, Number.NaN, 'abc']) {
    const result = checkTimeoutBudget('python_exec', requested);
    assert.equal(result.ok, true);
    assert.equal(result.effectiveMs, 10000);
    assert.equal(result.clamped, false);
  }
});

test('authorizeToolCall denies non-array clearance for tools with data classes', () => {
  unregisterToolManifest(MANIFEST_NAME);
  try {
    registerToolManifest({ ...VALID_MANIFEST });
    const denied = authorizeToolCall(MANIFEST_NAME, {
      scopes: ['boundary.write'],
      dataClearance: 'public',
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'data_class_denied');
    assert.deepEqual(denied.blockedClasses, ['public']);
  } finally {
    unregisterToolManifest(MANIFEST_NAME);
  }
});

test('registry stats returns sorted unique scopes and data classes', () => {
  const stats = getRegistryStats();
  assert.deepEqual(stats.uniqueScopes, [...stats.uniqueScopes].sort());
  assert.deepEqual(stats.uniqueDataClasses, [...stats.uniqueDataClasses].sort());
});

test('findToolsByOutputFormat is case-insensitive', () => {
  assert.ok(findToolsByOutputFormat('PNG').includes('generate_image'));
});
