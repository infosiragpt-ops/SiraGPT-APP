import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDocumentSandboxConfig } from '../src/modules/doc-sandbox/config';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Deliberately synthetic model/config values: these tests never call a provider.
const baseModel = { id: 'synthetic-mechanical-model', prices: { version: 'fixture-prices-v1', inputPerMillionUsd: 1,
  outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25,
  executionPerHourUsd: 0, minimumExecutionSeconds: 0 }, maxOutputTokensPerTurn: 1024, reservationUsdPerTurn: 0.05 };
const models = { mechanical: baseModel, academic: { ...baseModel, id: 'synthetic-academic-model' } };
const key = Buffer.alloc(32, 17);
const previous = Buffer.alloc(32, 23);
const notReady = (error: unknown): boolean => error instanceof DocSandboxError && error.code === 'E_NOT_READY';
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { DOC_SANDBOX_ENGINE: 'anthropic', DOC_SANDBOX_MODELS_JSON: JSON.stringify(models),
    DOC_SANDBOX_SKILL_VERSIONS_JSON: JSON.stringify({ docx: 'version-fixture-1', xlsx: 'version-fixture-1', pptx: 'version-fixture-1', pdf: 'version-fixture-1' }),
    DOC_SANDBOX_VALIDATOR_IMAGE: `siragpt/doc-validation@sha256:${'a'.repeat(64)}`,
    DOC_SANDBOX_VALIDATION_STAGING_ROOT: '/tmp/doc-sandbox-test-staging',
    DOC_SANDBOX_ENCRYPTION_KEY: key.toString('base64'), DOC_SANDBOX_ENCRYPTION_KEY_ID: 'v2',
    DOC_SANDBOX_MAX_COST_USD: '0.25', REDIS_URL: 'redis://127.0.0.1:6388',
    ANTHROPIC_API_KEY: 'synthetic-not-a-provider-key', R2_BUCKET: 'synthetic-test-bucket',
    R2_ACCOUNT_ID: 'synthetic-test-account', R2_ACCESS_KEY_ID: 'synthetic-test-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-test-secret', ...overrides };
}

test('unconfigured feature is not admitted and does not inspect unrelated secrets', () => {
  assert.equal(loadDocumentSandboxConfig({}), null);
  assert.equal(loadDocumentSandboxConfig({ DOC_SANDBOX_ENCRYPTION_KEY: 'invalid' }), null);
});
test('phase-one engine cannot silently switch to Docker or unknown provider', () => {
  for (const engine of ['docker', 'unknown', 'Anthropic', 'true']) assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_ENGINE: engine })), notReady);
});
test('complete explicit configuration loads immutable engine settings and bounded defaults', () => {
  const config = loadDocumentSandboxConfig(env());
  assert.ok(config);
  assert.equal(config.maxCostUsd, 0.25);
  assert.equal(config.retentionDays, 30);
  assert.equal(config.maxFileBytes, 50 * 1024 * 1024);
  assert.equal(config.timeoutMs, 600_000);
  assert.equal(config.engine.apiTimeoutMs, 120_000);
  assert.equal(config.concurrency, 2);
  assert.equal(config.showCost, false);
  assert.equal(config.engine.models.mechanical.id, baseModel.id);
  assert.deepEqual(config.storageKey, key);
});
test('required credential/model/runtime fields fail admission when absent', () => {
  for (const name of ['DOC_SANDBOX_MODELS_JSON', 'DOC_SANDBOX_SKILL_VERSIONS_JSON', 'DOC_SANDBOX_VALIDATOR_IMAGE',
    'DOC_SANDBOX_ENCRYPTION_KEY', 'DOC_SANDBOX_MAX_COST_USD', 'DOC_SANDBOX_VALIDATION_STAGING_ROOT', 'REDIS_URL', 'ANTHROPIC_API_KEY', 'R2_BUCKET',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    assert.throws(() => loadDocumentSandboxConfig(env({ [name]: undefined })), notReady, name);
  }
});
test('cost must be explicitly authorized and finite, positive, within cap', () => {
  for (const cost of ['0', '-1', 'NaN', 'Infinity', '100.01', '']) assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_MAX_COST_USD: cost })), notReady);
  assert.equal(loadDocumentSandboxConfig(env({ DOC_SANDBOX_MAX_COST_USD: '0.001' }))?.maxCostUsd, 0.001);
});
test('counts and durations reject fractional/nonfinite values', () => {
  for (const [name, value] of [['DOC_SANDBOX_MAX_TURNS', '2.5'], ['DOC_SANDBOX_MAX_TOKENS', '1000.5'],
    ['DOC_SANDBOX_CONCURRENCY', '1.5'], ['DOC_SANDBOX_RETENTION_DAYS', '2.5'], ['DOC_SANDBOX_TIMEOUT_MS', '1000.5'],
    ['DOC_SANDBOX_MAX_FILE_BYTES', '10.5'], ['DOC_SANDBOX_TIMEOUT_MS', 'Infinity']]) {
    assert.throws(() => loadDocumentSandboxConfig(env({ [name!]: value })), notReady, name);
  }
});
test('configuration cannot increase file, retention, concurrency or token limits beyond approved caps', () => {
  for (const [name, value] of [['DOC_SANDBOX_MAX_FILE_BYTES', String(50 * 1024 * 1024 + 1)], ['DOC_SANDBOX_RETENTION_DAYS', '31'],
    ['DOC_SANDBOX_CONCURRENCY', '11'], ['DOC_SANDBOX_MAX_TURNS', '31'], ['DOC_SANDBOX_MAX_TOKENS', '500001'],
    ['DOC_SANDBOX_TIMEOUT_MS', '3600001']]) {
    assert.throws(() => loadDocumentSandboxConfig(env({ [name!]: value })), notReady, name);
  }
});
test('mutable validation image and latest skill versions cannot be admitted', () => {
  assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_VALIDATOR_IMAGE: 'siragpt/doc-validation:latest' })), notReady);
  const skills = JSON.parse(env().DOC_SANDBOX_SKILL_VERSIONS_JSON!);
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
    assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_SKILL_VERSIONS_JSON: JSON.stringify({ ...skills, [format]: 'latest' }) })), notReady);
  }
});
test('locally built immutable image ID is accepted but staging must be an explicit absolute shared path', () => {
  assert.equal(loadDocumentSandboxConfig(env({ DOC_SANDBOX_VALIDATOR_IMAGE: `sha256:${'b'.repeat(64)}` }))?.validatorImage, `sha256:${'b'.repeat(64)}`);
  for (const value of ['/', 'relative/path', '/tmp/../other', '/tmp/staging/', '/tmp/staging,unsafe', '/tmp/staging\n']) {
    assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_VALIDATION_STAGING_ROOT: value })), notReady, value);
  }
});
test('model configuration rejects missing prices, excessive tokens and unknown fields', () => {
  for (const mechanical of [{ ...baseModel, prices: undefined }, { ...baseModel, maxOutputTokensPerTurn: 16001 },
    { ...baseModel, allowUnsafeFallback: true }, { ...baseModel, reservationUsdPerTurn: 0 }]) {
    assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_MODELS_JSON: JSON.stringify({ ...models, mechanical }) })), notReady);
  }
});
test('previous key versions are decoded separately without replacing current master', () => {
  const config = loadDocumentSandboxConfig(env({ DOC_SANDBOX_PREVIOUS_KEYS_JSON: JSON.stringify({ v1: previous.toString('base64') }) }));
  assert.ok(config);
  assert.equal(config.keyId, 'v2');
  assert.deepEqual(config.storageKey, key);
  assert.deepEqual(config.previousKeys.v1, previous);
  for (const value of ['not json', JSON.stringify({ '../invalid': previous.toString('base64') }), JSON.stringify({ v1: 'invalid' })]) {
    assert.throws(() => loadDocumentSandboxConfig(env({ DOC_SANDBOX_PREVIOUS_KEYS_JSON: value })), notReady);
  }
});
test('bucket alias and explicit cost visibility retain deterministic behavior', () => {
  const config = loadDocumentSandboxConfig(env({ R2_BUCKET: undefined, R2_BUCKET_NAME: 'preferred-bucket', DOC_SANDBOX_SHOW_COST: 'true', DOC_SANDBOX_TIMEOUT_MS: '2000' }));
  assert.ok(config);
  assert.equal(config.bucket, 'preferred-bucket');
  assert.equal(config.showCost, true);
  assert.equal(config.engine.apiTimeoutMs, 2000);
});
