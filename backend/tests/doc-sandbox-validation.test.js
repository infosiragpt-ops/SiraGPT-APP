const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('independent validator executes real anonymous Python fixtures and tools', () => {
  const python = process.env.DOC_VALIDATION_TEST_PYTHON || 'python3';
  const result = spawnSync(python, [path.join(__dirname, 'doc-sandbox-validation.test.py')], {
    encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  process.stdout.write(result.stderr.split('\n').slice(-5).join('\n'));
});
