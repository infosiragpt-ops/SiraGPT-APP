'use strict';

// Prod 2026-10-03: «[cowork] artifact import failed: Artifact content is not
// available.» — importAgentArtifact read the R2 ref first (object not
// uploaded yet) and the local file second (already unlinked by the mirror
// that finished in between). It now reads the local copy first, then the
// bucket, and retries once so the mirror gets a chance to land.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-artifacts-'));
process.env.AGENT_ARTIFACT_DIR = dir;
process.env.SIRAGPT_ARTIFACT_IMPORT_RETRY_MS = '60';

const store = require('../src/services/cowork/workspace-store');

const ID = 'abcdef0123456789';
function writeMeta(extra = {}) {
  fs.writeFileSync(path.join(dir, `${ID}.json`), JSON.stringify({
    id: ID,
    filename: 'informe.txt',
    mime: 'text/plain',
    ownerUserId: 'user_1',
    storedRelPath: `${ID}-informe.txt`,
    storageRef: 'r2://bucket/agent-artifacts/never-uploaded.txt',
    ...extra,
  }));
}

function fakePrisma(captured) {
  const workspace = { id: 'ws_1', userId: 'user_1' };
  const tx = {
    coworkFile: {
      async findUnique() { return null; },
      async create({ data }) { captured.push(data); return { id: 'cf_1', path: data.path, currentVersion: 1, mime: data.mime, size: data.size, versions: [] }; },
    },
  };
  return {
    coworkWorkspace: { async findFirst() { return workspace; } },
    coworkFile: { async findUnique() { return null; } },
    async $transaction(fn) { return fn(tx); },
  };
}

test('reads the local binary first even when the R2 ref is unreadable', async () => {
  writeMeta();
  fs.writeFileSync(path.join(dir, `${ID}-informe.txt`), 'contenido local');
  const captured = [];
  const file = await store.importAgentArtifact(fakePrisma(captured), {
    workspaceId: 'ws_1', userId: 'user_1', artifactId: ID, targetPath: 'deliverables/informe.txt',
  });
  assert.equal(file.path, 'deliverables/informe.txt');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].size, Buffer.byteLength('contenido local'));
});

test('retries once so a binary that appears a moment later is imported', async () => {
  writeMeta();
  const local = path.join(dir, `${ID}-informe.txt`);
  fs.rmSync(local, { force: true });
  setTimeout(() => fs.writeFileSync(local, 'llegó tarde'), 25);
  const captured = [];
  const file = await store.importAgentArtifact(fakePrisma(captured), {
    workspaceId: 'ws_1', userId: 'user_1', artifactId: ID,
  });
  assert.equal(file.path, 'deliverables/informe.txt');
  assert.equal(captured[0].size, Buffer.byteLength('llegó tarde'));
});

test('still reports artifact_content_unavailable when nothing ever appears', async () => {
  writeMeta();
  fs.rmSync(path.join(dir, `${ID}-informe.txt`), { force: true });
  await assert.rejects(
    () => store.importAgentArtifact(fakePrisma([]), { workspaceId: 'ws_1', userId: 'user_1', artifactId: ID }),
    (err) => err.code === 'artifact_content_unavailable',
  );
});
