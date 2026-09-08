'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { localCliCommand } = require('../src/services/codex/local-cli');

test('local JavaScript CLIs use Node entrypoints instead of bunx', () => {
  assert.deepEqual(
    localCliCommand('tsc', '--noEmit', '--pretty', 'false'),
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'],
  );
  assert.deepEqual(
    localCliCommand('vitest', 'run', '--reporter=json'),
    ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json'],
  );
  assert.deepEqual(
    localCliCommand('eslint', '.', '--format', 'json'),
    ['node', 'node_modules/eslint/bin/eslint.js', '.', '--format', 'json'],
  );
});

test('local JavaScript CLI rejects unknown entrypoints', () => {
  assert.throws(() => localCliCommand('unknown'), /unsupported local CLI/);
});
