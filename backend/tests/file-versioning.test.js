'use strict';

// FileVersion history for the DocumentEditingService: each edit records an
// immutable version; the original upload is never mutated; best-effort so a
// versioning failure never breaks the edit.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getFileVersion,
  listFileVersions,
  recordFileVersion,
  restoreFileVersion,
} = require('../src/services/document-editing/versioning');

// In-memory fake of the subset of prisma.fileVersion the service uses.
function makeFakePrisma({ failCreate = false } = {}) {
  const rows = [];
  let auto = 0;
  return {
    _rows: rows,
    fileVersion: {
      async findFirst({ where, orderBy, select } = {}) {
        let match = rows.filter((r) => (!where?.fileId || r.fileId === where.fileId)
          && (!where?.userId || r.userId === where.userId)
          && (!where?.id || r.id === where.id)
          && (where?.validationPassed === undefined || r.validationPassed === where.validationPassed));
        if (orderBy?.version === 'desc') match = match.sort((a, b) => b.version - a.version);
        return match[0] || null;
      },
      async findMany({ where, orderBy } = {}) {
        let match = rows.filter((r) => (!where?.fileId || r.fileId === where.fileId)
          && (!where?.userId || r.userId === where.userId)
          && (where?.validationPassed === undefined || r.validationPassed === where.validationPassed));
        if (orderBy?.version === 'desc') match = match.sort((a, b) => b.version - a.version);
        return match;
      },
      async create({ data }) {
        if (failCreate) { const e = new Error('boom'); throw e; }
        if (rows.some((r) => r.fileId === data.fileId && r.version === data.version)) {
          const e = new Error('unique'); e.code = 'P2002'; throw e;
        }
        const row = { id: `fv_${++auto}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

describe('versioning', () => {
  test('records monotonic versions 1..N per file', async () => {
    const prisma = makeFakePrisma();
    const v1 = await recordFileVersion(prisma, { fileId: 'file-a', userId: 'u1', artifactId: 'art1', filename: 'x_editado.docx', summary: 'recolor' });
    const v2 = await recordFileVersion(prisma, { fileId: 'file-a', userId: 'u1', artifactId: 'art2', filename: 'x_editado2.docx', summary: 'texto' });
    const other = await recordFileVersion(prisma, { fileId: 'file-b', userId: 'u1', artifactId: 'art3', filename: 'y.xlsx' });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(other.version, 1, 'per-file counter is independent');
  });

  test('listFileVersions returns newest-first, ownership-scoped', async () => {
    const prisma = makeFakePrisma();
    await recordFileVersion(prisma, { fileId: 'file-a', userId: 'u1', artifactId: 'a', filename: 'a.docx' });
    await recordFileVersion(prisma, { fileId: 'file-a', userId: 'u1', artifactId: 'b', filename: 'b.docx' });
    await recordFileVersion(prisma, { fileId: 'file-a', userId: 'other', artifactId: 'c', filename: 'c.docx' });
    const list = await listFileVersions(prisma, { fileId: 'file-a', userId: 'u1' });
    assert.equal(list.length, 2, 'only the owner\'s versions');
    assert.deepEqual(list.map((v) => v.version), [2, 1]);
  });

  test('getFileVersion enforces ownership', async () => {
    const prisma = makeFakePrisma();
    const v = await recordFileVersion(prisma, { fileId: 'file-a', userId: 'u1', artifactId: 'a', filename: 'a.docx' });
    assert.ok(await getFileVersion(prisma, { versionId: v.id, userId: 'u1' }));
    assert.equal(await getFileVersion(prisma, { versionId: v.id, userId: 'intruder' }), null);
  });

  test('invalid candidates are neither recorded nor exposed as versions', async () => {
    const prisma = makeFakePrisma();
    const rejected = await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: 'invalid-new', filename: 'invalid.docx', validationPassed: false,
    });
    assert.equal(rejected, null);
    assert.equal(prisma._rows.length, 0, 'a failed validation must not create a version row');

    prisma._rows.push({
      id: 'legacy-invalid', fileId: 'file-a', userId: 'u1', version: 7,
      artifactId: 'legacy-invalid-artifact', filename: 'legacy-invalid.docx',
      validationPassed: false, createdAt: new Date(),
    });
    assert.deepEqual(await listFileVersions(prisma, { fileId: 'file-a', userId: 'u1' }), []);
    assert.equal(await getFileVersion(prisma, { versionId: 'legacy-invalid', userId: 'u1' }), null);
    assert.equal(await restoreFileVersion(prisma, {
      fileId: 'file-a', versionId: 'legacy-invalid', userId: 'u1',
    }), null);
    assert.equal(prisma._rows.length, 1, 'restoring a legacy invalid row must not create a new head');
  });

  test('restore creates a new head pointing at the selected immutable artifact', async () => {
    const prisma = makeFakePrisma();
    const first = await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: 'artifact-original-edit', filename: 'tesis.docx', summary: 'Versión revisada',
    });
    await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: 'artifact-second-edit', filename: 'tesis.docx', summary: 'Cambios posteriores',
    });

    const result = await restoreFileVersion(prisma, {
      fileId: 'file-a', versionId: first.id, userId: 'u1', createdByChatId: 'chat-1',
    });

    assert.equal(result.source.version, 1);
    assert.equal(result.restored.version, 3);
    assert.equal(result.restored.artifactId, 'artifact-original-edit');
    assert.equal(result.restored.editPlan.type, 'restore');
    assert.match(result.restored.summary, /Restaurada desde la versión 1/);
    assert.equal(await restoreFileVersion(prisma, {
      fileId: 'file-a', versionId: first.id, userId: 'intruder',
    }), null);
  });

  test('restore of a manual text edit creates a content-backed head (no artifact)', async () => {
    const prisma = makeFakePrisma();
    await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: 'artifact-edit', filename: 'tesis.docx', summary: 'edición agéntica',
    });
    const manual = await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: null, filename: 'tesis.md',
      summary: 'Edición manual desde el editor de documentos',
    });
    // Mirror the edit route: the edited Markdown is persisted on the row.
    manual.content = '# Tesis corregida\n\nPárrafo editado.';

    const result = await restoreFileVersion(prisma, {
      fileId: 'file-a', versionId: manual.id, userId: 'u1', createdByChatId: 'chat-2',
    });

    assert.ok(result, 'a text version must be restorable');
    assert.equal(result.restored.version, 3);
    assert.equal(result.restored.artifactId, null, 'text restores stay content-backed');
    assert.equal(result.restored.content, '# Tesis corregida\n\nPárrafo editado.');
    assert.equal(result.restored.editPlan.restoreKind, 'text');
    assert.match(result.restored.summary, /Restaurada desde la versión 2/);
  });

  test('restore of an artifact version carries no stray content field', async () => {
    const prisma = makeFakePrisma();
    const withArtifact = await recordFileVersion(prisma, {
      fileId: 'file-a', userId: 'u1', artifactId: 'art-9', filename: 'tesis.docx', summary: 'binario',
    });
    const result = await restoreFileVersion(prisma, { fileId: 'file-a', versionId: withArtifact.id, userId: 'u1' });
    assert.equal(result.restored.content, undefined);
    assert.equal(result.restored.editPlan.restoreKind, 'artifact');
  });

  test('restoring a version with neither artifact nor content fails explicitly', async () => {
    const prisma = makeFakePrisma();
    prisma._rows.push({
      id: 'fv-empty', fileId: 'file-a', userId: 'u1', version: 5,
      artifactId: null, content: null, filename: 'hueco.docx',
      validationPassed: true, createdAt: new Date(),
    });
    await assert.rejects(
      () => restoreFileVersion(prisma, { fileId: 'file-a', versionId: 'fv-empty', userId: 'u1' }),
      (err) => err.code === 'VERSION_NOT_RESTORABLE',
    );
    assert.equal(prisma._rows.length, 1, 'no new head is created for a non-restorable source');
  });

  test('best-effort: create failure returns null, never throws', async () => {
    const prisma = makeFakePrisma({ failCreate: true });
    assert.equal(await recordFileVersion(prisma, { fileId: 'f', userId: 'u', filename: 'x' }), null);
  });

  test('no-op when prisma lacks the fileVersion model (pre-migration safety)', async () => {
    assert.equal(await recordFileVersion({}, { fileId: 'f', userId: 'u', filename: 'x' }), null);
    assert.deepEqual(await listFileVersions({}, { fileId: 'f', userId: 'u' }), []);
  });
});
