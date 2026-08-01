'use strict';

/**
 * Slice E — policy journey for Project.codeWorkspace without loading the full
 * Express projects router (avoids heavy auth/jwt dep chains in unit runs).
 *
 * Covers the same product rules the HTTP handlers enforce:
 *   owner scope + soft-delete → 404 uniform
 *   empty / hydrate / save round-trip via snapshot helpers
 *   path traversal rejection
 *   distinct from knowledge File attachments
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCodeWorkspaceSnapshot,
  readStoredCodeWorkspace,
  fileCount,
} = require('../src/services/code/project-code-workspace');
const { softDeleteWhere } = require('../src/utils/prisma-soft-delete');

const OWNER = 'owner-1';
const OTHER = 'other-2';
const PROJECT_ID = 'cms2dv4ik0005qn019wtu19fl';

/**
 * Mirror of route ownership: softDeleteWhere({ id, userId }) then row lookup.
 * Returns null for missing / foreign / soft-deleted → uniform 404.
 */
function findOwnedProject(store, userId, projectId) {
  const where = softDeleteWhere({ id: projectId, userId });
  const row = store.get(where.id);
  if (!row) return null;
  if (row.userId !== where.userId) return null;
  if (where.deletedAt === null && row.deletedAt != null) return null;
  return row;
}

function getCodeWorkspace(store, userId, projectId) {
  const project = findOwnedProject(store, userId, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  const workspace = readStoredCodeWorkspace(project.codeWorkspace);
  return {
    status: 200,
    body: {
      projectId: project.id,
      workspace,
      fileCount: fileCount(workspace),
      projectUpdatedAt: project.updatedAt,
    },
  };
}

function putCodeWorkspace(store, userId, projectId, rawWorkspace) {
  const project = findOwnedProject(store, userId, projectId);
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  let workspace;
  try {
    workspace = normalizeCodeWorkspaceSnapshot(rawWorkspace);
  } catch (err) {
    const status = err && err.status ? err.status : 400;
    return { status, body: { error: err.message || 'Invalid code workspace' } };
  }
  project.codeWorkspace = workspace;
  project.updatedAt = new Date('2026-08-01T01:00:00.000Z');
  return {
    status: 200,
    body: {
      projectId: project.id,
      workspace,
      fileCount: fileCount(workspace),
      projectUpdatedAt: project.updatedAt,
    },
  };
}

function seedStore(overrides = {}) {
  const store = new Map();
  store.set(PROJECT_ID, {
    id: PROJECT_ID,
    userId: OWNER,
    name: 'Fixture',
    codeWorkspace: null,
    deletedAt: null,
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    ...overrides,
  });
  return store;
}

describe('projects · code-workspace policy journey (Slice E)', () => {
  test('GET empty workspace returns v1 empty snapshot for owner', () => {
    const store = seedStore();
    const res = getCodeWorkspace(store, OWNER, PROJECT_ID);
    assert.equal(res.status, 200);
    assert.equal(res.body.projectId, PROJECT_ID);
    assert.equal(res.body.fileCount, 0);
    assert.equal(res.body.workspace.v, 1);
    assert.deepEqual(res.body.workspace.files, {});
  });

  test('PUT then GET round-trips editor files (not knowledge attachments)', () => {
    const store = seedStore();
    const put = putCodeWorkspace(store, OWNER, PROJECT_ID, {
      files: {
        'src/main.ts': { content: 'export const n = 1\n', language: 'typescript' },
        'README.md': { content: '# demo\n' },
      },
      openTabs: ['src/main.ts'],
      activePath: 'src/main.ts',
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.fileCount, 2);
    assert.equal(put.body.workspace.files['src/main.ts'].content, 'export const n = 1\n');
    // No knowledge PDF path in the code FS.
    assert.equal(put.body.workspace.files['brief.pdf'], undefined);

    const get = getCodeWorkspace(store, OWNER, PROJECT_ID);
    assert.equal(get.status, 200);
    assert.equal(get.body.fileCount, 2);
    assert.equal(get.body.workspace.activePath, 'src/main.ts');
    assert.deepEqual(get.body.workspace.openTabs, ['src/main.ts']);
  });

  test('PUT rejects path traversal with 400', () => {
    const store = seedStore();
    const res = putCodeWorkspace(store, OWNER, PROJECT_ID, {
      files: { '../secret.env': { content: 'x' } },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error || ''), /path|invalid|not allowed/i);
  });

  test('GET soft-deleted project returns 404 (uniform with other project routes)', () => {
    const store = seedStore({ deletedAt: new Date('2026-07-01T00:00:00.000Z') });
    const res = getCodeWorkspace(store, OWNER, PROJECT_ID);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Project not found');
  });

  test('PUT for another user returns 404 (no ownership leak)', () => {
    const store = seedStore();
    const res = putCodeWorkspace(store, OTHER, PROJECT_ID, {
      files: { 'a.ts': { content: '1' } },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Project not found');
  });

  test('GET for missing project id returns 404', () => {
    const store = seedStore();
    const res = getCodeWorkspace(store, OWNER, 'does-not-exist');
    assert.equal(res.status, 404);
  });

  test('PUT missing/invalid workspace shape fails with 4xx', () => {
    const store = seedStore();
    const res = putCodeWorkspace(store, OWNER, PROJECT_ID, null);
    assert.ok(res.status >= 400 && res.status < 500);
  });
});
