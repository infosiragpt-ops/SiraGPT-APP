'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProject, listProjects, getProject } = require('../src/services/codex/project-service');

function fakeDb() {
  const rows = new Map();
  let n = 0;
  return {
    rows,
    codexProject: {
      create: async ({ data }) => {
        const row = { id: `p${++n}`, error: null, workspacePath: null, previewUrl: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = { ...rows.get(where.id), ...data, updatedAt: new Date() };
        rows.set(where.id, row);
        return { ...row };
      },
      findMany: async ({ where }) => [...rows.values()].filter((r) => r.userId === where.userId),
      findFirst: async ({ where }) => {
        const row = rows.get(where.id);
        return row && row.userId === where.userId ? { ...row } : null;
      },
    },
  };
}

function okRunner() {
  return {
    initWorkspace: async () => ({ ok: true }),
    writeFiles: async () => ({ ok: true, written: 4 }),
    exec: async (project, cmd) =>
      cmd.includes('rev-parse')
        ? { ok: true, exitCode: 0, stdout: 'sha1\n', stderr: '' }
        : { ok: true, exitCode: 0, stdout: '', stderr: '' },
  };
}

test('createProject provisions and returns a ready public projection', async () => {
  const db = fakeDb();
  const project = await createProject({ userId: 'u1', name: 'Tienda', runner: okRunner(), db, env: {} });
  assert.equal(project.status, 'ready');
  assert.equal(project.workspacePath, 'projects/p1');
  assert.equal(project.previewUrl, null);
  assert.equal(project.userId, undefined); // proyección pública: sin userId
});

test('provisioning failure persists status=error without throwing', async () => {
  const db = fakeDb();
  const badRunner = { initWorkspace: async () => { throw new Error('runner unreachable: ECONNREFUSED'); } };
  const project = await createProject({ userId: 'u1', name: 'X', runner: badRunner, db, env: {} });
  assert.equal(project.status, 'error');
  assert.match(project.error, /ECONNREFUSED/);
  assert.equal(db.rows.get(project.id).status, 'error');
});

test('a blocking provisioning failure is enriched with a remediation hint (feature 09)', async () => {
  const db = fakeDb();
  const badRunner = { initWorkspace: async () => { throw new Error('RunnerError: runner unreachable: fetch failed'); } };
  const project = await createProject({ userId: 'u1', name: 'X', runner: badRunner, db, env: {} });
  assert.equal(project.status, 'error');
  assert.match(project.error, /runner unreachable/); // raw error preserved
  assert.match(project.error, /perfil "opencode"/); // provision_failed remediation appended
});

test('getProject is scoped by userId; listProjects returns only own projects', async () => {
  const db = fakeDb();
  const mine = await createProject({ userId: 'u1', name: 'A', runner: okRunner(), db, env: {} });
  await createProject({ userId: 'u2', name: 'B', runner: okRunner(), db, env: {} });
  assert.equal(await getProject({ userId: 'u2', id: mine.id, db }), null);
  const list = await listProjects({ userId: 'u1', db });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'A');
});
