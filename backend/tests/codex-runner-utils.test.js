'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
} = require('../../scripts/code-runner-utils');

test('sanitizeProjectId accepts cuid-like ids and rejects everything else', () => {
  assert.equal(sanitizeProjectId('cmbx1y2z30000abcd1234efgh'), 'cmbx1y2z30000abcd1234efgh');
  assert.equal(sanitizeProjectId('proj_1-A'), 'proj_1-A');
  assert.equal(sanitizeProjectId('../etc'), null);
  assert.equal(sanitizeProjectId('a b'), null);
  assert.equal(sanitizeProjectId(''), null);
  assert.equal(sanitizeProjectId(null), null);
  assert.equal(sanitizeProjectId('x'.repeat(65)), null);
});

test('resolveProjectRelPath normalizes and blocks traversal/absolute paths', () => {
  assert.equal(resolveProjectRelPath('src/main.js'), 'src/main.js');
  assert.equal(resolveProjectRelPath('./a//b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('a\\b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('../secret'), null);
  assert.equal(resolveProjectRelPath('a/../../b'), null);
  assert.equal(resolveProjectRelPath('/etc/passwd'), null);
  assert.equal(resolveProjectRelPath('C:/windows'), null);
  assert.equal(resolveProjectRelPath(''), null);
});

test('isAllowedCommand allows git/bun/bunx/node and blocks the rest', () => {
  assert.equal(isAllowedCommand(['git', 'init']), true);
  assert.equal(isAllowedCommand(['bun', 'install']), true);
  assert.equal(isAllowedCommand(['rm', '-rf', '/']), false);
  assert.equal(isAllowedCommand(['sh', '-c', 'echo hi']), false);
  assert.equal(isAllowedCommand([]), false);
  assert.equal(isAllowedCommand('git init'), false);
  assert.equal(isAllowedCommand(['git', 42]), false);
});
