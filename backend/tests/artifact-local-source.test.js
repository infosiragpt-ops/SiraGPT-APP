'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  materializeArtifactSource,
  resolveLocalArtifactPath,
} = require('../src/services/agents/artifact-local-source');

function writeMeta(dir, id, extra = {}) {
  const meta = {
    id,
    filename: extra.filename || 'informe.docx',
    format: extra.format || 'docx',
    ownerUserId: extra.ownerUserId || 'user-1',
    storedRelPath: extra.storedRelPath,
    storageRef: extra.storageRef || null,
    ...extra,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

describe('artifact-local-source hydrate', () => {
  it('returns the local binary when it is still on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-local-'));
    const id = 'abc123def456';
    const stored = `${id}-informe.docx`;
    fs.writeFileSync(path.join(dir, stored), Buffer.from('PK local'));
    writeMeta(dir, id, { storedRelPath: stored });
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-1',
    });
    assert.equal(out.ok, true);
    assert.equal(out.fromR2, false);
    assert.equal(out.format, 'docx');
    assert.equal(fs.readFileSync(out.sourcePath).toString(), 'PK local');
  });

  it('hydrates from R2 when the local binary was offloaded (no 409)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-r2-'));
    const id = 'fff111aaa222';
    writeMeta(dir, id, {
      storedRelPath: `${id}-informe.docx`,
      storageRef: 'r2:agent-artifacts/fff111aaa222-informe.docx',
    });
    assert.equal(resolveLocalArtifactPath(
      { storedRelPath: `${id}-informe.docx` },
      dir,
      id,
    ), null);

    const tmp = path.join(dir, 'hydrated.docx');
    fs.writeFileSync(tmp, Buffer.from('PK from-r2'));
    let cleaned = false;
    const storage = {
      async toLocalTemp(ref) {
        assert.equal(ref, 'r2:agent-artifacts/fff111aaa222-informe.docx');
        return { path: tmp, cleanup: async () => { cleaned = true; } };
      },
    };
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-1',
      storage,
    });
    assert.equal(out.ok, true);
    assert.equal(out.fromR2, true);
    assert.equal(out.isPdf, false);
    assert.equal(fs.readFileSync(out.sourcePath).toString(), 'PK from-r2');
    await out.cleanup();
    assert.equal(cleaned, true);
  });

  it('hydrates a native PDF from R2 so preview.pdf can stream it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-pdf-'));
    const id = 'pdf999abc111';
    writeMeta(dir, id, {
      filename: 'paper.pdf',
      format: 'pdf',
      storedRelPath: `${id}-paper.pdf`,
      storageRef: 'r2:agent-artifacts/pdf999abc111-paper.pdf',
    });
    const tmp = path.join(dir, 'paper.pdf');
    fs.writeFileSync(tmp, Buffer.from('%PDF-1.4 r2'));
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-1',
      storage: {
        async toLocalTemp() {
          return { path: tmp, cleanup: async () => {} };
        },
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.fromR2, true);
    assert.equal(out.isPdf, true);
  });

  it('returns 502 (not 409) when R2 hydrate fails for an existing artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-fail-'));
    const id = 'deadbeef0001';
    writeMeta(dir, id, { storageRef: 'r2:agent-artifacts/missing' });
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-1',
      storage: {
        async toLocalTemp() { throw new Error('NoSuchKey'); },
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(out.error, 'artifact hydrate failed');
    assert.notEqual(out.status, 409);
  });

  it('returns 404 when there is no local file and no storageRef', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-gone-'));
    const id = 'cafebabe0001';
    writeMeta(dir, id, { storageRef: null });
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-1',
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 404);
  });

  it('rejects a different owner without leaking the artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-art-own-'));
    const id = 'own000111222';
    writeMeta(dir, id, { ownerUserId: 'user-a' });
    const out = await materializeArtifactSource({
      id,
      artifactDir: dir,
      ownerUserId: 'user-b',
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
  });
});
