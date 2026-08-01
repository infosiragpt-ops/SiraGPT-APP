'use strict';

/**
 * Unit tests for Project.codeWorkspace snapshot normalize/read (Slice C).
 * No DB — pure validation + path safety.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCodeWorkspaceSnapshot,
  readStoredCodeWorkspace,
  emptySnapshot,
  fileCount,
  MAX_FILES,
} = require('../src/services/code/project-code-workspace');

describe('project-code-workspace normalize', () => {
  it('accepts a minimal valid snapshot', () => {
    const snap = normalizeCodeWorkspaceSnapshot({
      files: {
        'src/app.tsx': { content: 'export default function App(){return null}' },
        'package.json': '{"name":"demo"}',
      },
      openTabs: ['src/app.tsx'],
      activePath: 'src/app.tsx',
    });
    assert.equal(snap.v, 1);
    assert.equal(fileCount(snap), 2);
    assert.equal(snap.activePath, 'src/app.tsx');
    assert.ok(snap.files['src/app.tsx'].content.includes('App'));
    assert.equal(typeof snap.files['package.json'].content, 'string');
  });

  it('rejects path traversal', () => {
    assert.throws(
      () =>
        normalizeCodeWorkspaceSnapshot({
          files: { '../etc/passwd': { content: 'x' } },
        }),
      (err) => err && err.status === 400,
    );
  });

  it('rejects absolute paths', () => {
    assert.throws(
      () =>
        normalizeCodeWorkspaceSnapshot({
          files: { '/etc/passwd': { content: 'x' } },
        }),
      (err) => err && err.status === 400,
    );
  });

  it('rejects too many files', () => {
    const files = {};
    for (let i = 0; i < MAX_FILES + 1; i++) files[`f${i}.ts`] = { content: 'x' };
    assert.throws(
      () => normalizeCodeWorkspaceSnapshot({ files }),
      (err) => err && err.status === 413,
    );
  });

  it('readStoredCodeWorkspace returns empty for corrupt rows', () => {
    assert.deepEqual(readStoredCodeWorkspace(null).files, {});
    assert.deepEqual(readStoredCodeWorkspace({ bad: true }).files, {});
    assert.equal(emptySnapshot().activePath, null);
  });

  it('drops openTabs that are not in files', () => {
    const snap = normalizeCodeWorkspaceSnapshot({
      files: { 'a.ts': { content: '1' } },
      openTabs: ['a.ts', 'missing.ts'],
      activePath: 'missing.ts',
    });
    assert.deepEqual(snap.openTabs, ['a.ts']);
    assert.equal(snap.activePath, 'a.ts');
  });
});
