'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
  commandRejectionReason,
  shouldIgnoreExportPath,
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

test('isAllowedCommand blocks interactive scaffolds that should be written by tools', () => {
  assert.equal(isAllowedCommand(['bunx', 'create-next-app@latest', '.']), false);
  assert.equal(isAllowedCommand(['bunx', 'create-vite', '.']), false);
  assert.equal(isAllowedCommand(['bun', 'create', 'vite', '.']), false);
  assert.match(commandRejectionReason(['bunx', 'create-next-app@latest', '.']), /interactive_scaffold_disallowed/);
  assert.equal(commandRejectionReason(['bun', 'install']), null);
});

test('shouldIgnoreExportPath keeps source but skips generated/heavy dirs', () => {
  // Source files the user wants on disk → copied.
  assert.equal(shouldIgnoreExportPath('package.json'), false);
  assert.equal(shouldIgnoreExportPath('src/main.tsx'), false);
  assert.equal(shouldIgnoreExportPath('public/logo.svg'), false);
  assert.equal(shouldIgnoreExportPath('a/b/c.ts'), false);
  // Generated/heavy trees → never mirrored, at any depth, backslashes too.
  assert.equal(shouldIgnoreExportPath('node_modules/react/index.js'), true);
  assert.equal(shouldIgnoreExportPath('.git/HEAD'), true);
  assert.equal(shouldIgnoreExportPath('dist/bundle.js'), true);
  assert.equal(shouldIgnoreExportPath('.next/cache/x'), true);
  assert.equal(shouldIgnoreExportPath('src/node_modules/dep/x.js'), true);
  assert.equal(shouldIgnoreExportPath('build\\out.js'), true);
  // Empty/blank → ignored (nothing to copy).
  assert.equal(shouldIgnoreExportPath(''), true);
  assert.equal(shouldIgnoreExportPath(null), true);
});
