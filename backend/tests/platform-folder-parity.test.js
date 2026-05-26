'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  REQUIRED_TOP_LEVEL,
  FOLDER_PARITY_MAP,
  buildPlatformFolderReport,
  assertPlatformFolders,
} = require('../src/services/agents/platform-folder-parity');

test('required top-level matches OpenClaw/Hermes layout from screenshot', () => {
  for (const name of ['.agents', 'apps', 'config', 'deploy', 'extensions', 'qa', 'skills', 'src', 'test', 'ui']) {
    assert.ok(REQUIRED_TOP_LEVEL.includes(name), `expected ${name} in REQUIRED_TOP_LEVEL`);
  }
  assert.equal(REQUIRED_TOP_LEVEL.length, 19);
});

test('folder parity map covers all required folders', () => {
  const mapped = new Set(FOLDER_PARITY_MAP.map((f) => f.folder));
  for (const name of REQUIRED_TOP_LEVEL) {
    assert.ok(mapped.has(name), `missing parity entry for ${name}`);
  }
});

test('all required top-level folders exist in repo', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const report = buildPlatformFolderReport({ repoRoot });
  assert.equal(report.gaps.length, 0, `gaps: ${report.gaps.join(', ')}`);
  assert.equal(report.counts.presentTopLevel, 19);
});

test('assertPlatformFolders passes on full repo', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const report = assertPlatformFolders({ repoRoot });
  assert.ok(report.counts.integrated >= 15);
});

test('apps folder maps to product surfaces', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const apps = buildPlatformFolderReport({ repoRoot }).folders.find((f) => f.folder === 'apps');
  assert.ok(apps.resolvedPaths.includes('app'));
});

test('ui folder maps to app and hermes tui route file', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const ui = buildPlatformFolderReport({ repoRoot }).folders.find((f) => f.folder === 'ui');
  assert.ok(ui.resolvedPaths.includes('app'));
  assert.ok(ui.resolvedPaths.some((p) => p.includes('hermes')));
});
