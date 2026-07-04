'use strict';

// FileVersion history for the DocumentEditingService: each edit records an
// immutable version; the original upload is never mutated; best-effort so a
// versioning failure never breaks the edit.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { recordFileVersion, listFileVersions, getFileVersion } = require('../src/services/document-editing/versioning');

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
          && (!where?.id || r.id === where.id));
        if (orderBy?.version === 'desc') match = match.sort((a, b) => b.version - a.version);
        return match[0] || null;
      },
      async findMany({ where, orderBy } = {}) {
        let match = rows.filter((r) => (!where?.fileId || r.fileId === where.fileId)
          && (!where?.userId || r.userId === where.userId));
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

  test('best-effort: create failure returns null, never throws', async () => {
    const prisma = makeFakePrisma({ failCreate: true });
    assert.equal(await recordFileVersion(prisma, { fileId: 'f', userId: 'u', filename: 'x' }), null);
  });

  test('no-op when prisma lacks the fileVersion model (pre-migration safety)', async () => {
    assert.equal(await recordFileVersion({}, { fileId: 'f', userId: 'u', filename: 'x' }), null);
    assert.deepEqual(await listFileVersions({}, { fileId: 'f', userId: 'u' }), []);
  });
});
