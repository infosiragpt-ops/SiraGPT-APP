'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PublicationError,
  copyBundle,
  publishProject,
  rollbackPublication,
} = require('../src/services/codex/publication-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-publication-'));
  const exportRoot = path.join(root, 'exports');
  const sitesRoot = path.join(root, 'sites');
  const source = path.join(exportRoot, '.published', 'p1');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<main>version one</main>');
  fs.writeFileSync(path.join(source, 'assets', 'app.js'), 'console.log("v1")');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const state = {
    project: { id: 'p1', userId: 'u1', name: 'Mi App', deletedAt: null, brief: {} },
    checkpoint: { id: 'cp1', projectId: 'p1', commitSha: 'a'.repeat(40), createdAt: new Date() },
  };
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === state.project.id && where.userId === state.project.userId ? state.project : null
      ),
      findUnique: async () => state.project,
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        return state.project;
      },
    },
    codexCheckpoint: {
      findFirst: async () => state.checkpoint,
    },
  };
  let head = state.checkpoint.commitSha;
  const runner = {
    exec: async (_project, cmd) => {
      if (cmd[0] === 'git') return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
      if (cmd.join(' ') === 'bun install') return { exitCode: 0, stdout: 'installed', stderr: '' };
      if (cmd.join(' ') === 'npm run build') return { exitCode: 0, stdout: 'built', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    },
    readFile: async (_project, file) => {
      if (file === 'dist/index.html') return { content: '<main>built</main>' };
      throw new Error('not found');
    },
    exportBuild: async () => ({ ok: true, files: 2, bytes: 42 }),
  };
  const env = {
    PUBLISHED_SITES_DIR: sitesRoot,
    CODEX_EXPORT_CONTAINER_DIR: exportRoot,
    CODEX_APPS_BASE_DOMAIN: 'apps.example.com',
  };
  return {
    root,
    exportRoot,
    sitesRoot,
    source,
    state,
    prisma,
    runner,
    env,
    setHead(value) { head = value; },
  };
}

test('publishProject builds the exact checkpoint and atomically exposes an immutable release', async (t) => {
  const f = fixture(t);
  const result = await publishProject({
    prisma: f.prisma,
    userId: 'u1',
    projectId: 'p1',
    checkpointId: 'cp1',
    runner: f.runner,
    env: f.env,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.publication.url, 'https://mi-app-f64551.apps.example.com');
  const live = path.join(f.sitesRoot, result.publication.hostname);
  assert.equal(fs.lstatSync(live).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>version one</main>');
  assert.equal(f.state.project.brief.publication.currentReleaseId, 'a'.repeat(40));
});

test('publishing refuses a workspace whose HEAD differs from the selected checkpoint', async (t) => {
  const f = fixture(t);
  f.setHead('b'.repeat(40));
  await assert.rejects(
    () => publishProject({
      prisma: f.prisma,
      userId: 'u1',
      projectId: 'p1',
      checkpointId: 'cp1',
      runner: f.runner,
      env: f.env,
    }),
    (error) => error instanceof PublicationError && error.code === 'checkpoint_not_current',
  );
});

test('rollback re-promotes a prior immutable bundle without rebuilding', async (t) => {
  const f = fixture(t);
  await publishProject({
    prisma: f.prisma,
    userId: 'u1',
    projectId: 'p1',
    checkpointId: 'cp1',
    runner: f.runner,
    env: f.env,
  });

  f.state.checkpoint = { id: 'cp2', projectId: 'p1', commitSha: 'b'.repeat(40), createdAt: new Date() };
  f.setHead(f.state.checkpoint.commitSha);
  fs.writeFileSync(path.join(f.source, 'index.html'), '<main>version two</main>');
  await publishProject({
    prisma: f.prisma,
    userId: 'u1',
    projectId: 'p1',
    checkpointId: 'cp2',
    runner: f.runner,
    env: f.env,
  });
  const live = path.join(f.sitesRoot, f.state.project.brief.publication.hostname);
  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>version two</main>');

  await rollbackPublication({
    prisma: f.prisma,
    userId: 'u1',
    projectId: 'p1',
    releaseId: 'a'.repeat(40),
    env: f.env,
  });
  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>version one</main>');
});

test('copyBundle rejects symlinks in a generated bundle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-publication-link-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), '<main>ok</main>');
  fs.symlinkSync('/etc/passwd', path.join(source, 'leak.txt'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => copyBundle(source, dest),
    (error) => error instanceof PublicationError && error.code === 'bundle_entry_unsafe',
  );
});
