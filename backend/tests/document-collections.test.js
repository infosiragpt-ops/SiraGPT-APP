'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/document-collections');

function createFakePrisma() {
  const state = {
    collections: [],
    collectionDocuments: [],
    files: [],
    nextCollection: 1,
    nextJoin: 1,
  };

  const matchesWhere = (row, where = {}) => {
    for (const [key, value] of Object.entries(where)) {
      if (value && typeof value === 'object' && Array.isArray(value.in)) {
        if (!value.in.includes(row[key])) return false;
      } else if (value === null) {
        if (row[key] !== null && row[key] !== undefined) return false;
      } else if (row[key] !== value) {
        return false;
      }
    }
    return true;
  };

  const prisma = {
    _state: state,
    documentCollection: {
      async create({ data }) {
        const row = {
          id: `col-${state.nextCollection++}`,
          ownerId: data.ownerId,
          name: data.name,
          description: data.description || null,
          status: data.status || 'ready',
          docCount: 0,
          chunkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.collections.push(row);
        return { ...row };
      },
      async findFirst({ where }) {
        const row = state.collections.find((c) => matchesWhere(c, where));
        return row ? { ...row } : null;
      },
      async findMany({ where }) {
        return state.collections.filter((c) => matchesWhere(c, where)).map((c) => ({ ...c }));
      },
      async update({ where, data }) {
        const row = state.collections.find((c) => c.id === where.id);
        if (!row) throw new Error('collection missing');
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    collectionDocument: {
      async count({ where }) {
        return state.collectionDocuments.filter((row) => matchesWhere(row, where)).length;
      },
      async findMany({ where }) {
        return state.collectionDocuments.filter((row) => matchesWhere(row, where)).map((row) => ({ ...row }));
      },
      async upsert({ where, update, create }) {
        const key = where.collectionId_documentId;
        let row = state.collectionDocuments.find((item) => item.collectionId === key.collectionId && item.documentId === key.documentId);
        if (!row) {
          row = {
            id: `join-${state.nextJoin++}`,
            collectionId: create.collectionId,
            documentId: create.documentId,
            ownerId: create.ownerId,
            status: create.status || 'queued',
            chunkCount: 0,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          state.collectionDocuments.push(row);
        } else {
          Object.assign(row, update, { updatedAt: new Date() });
        }
        return { ...row };
      },
      async update({ where, data }) {
        const key = where.collectionId_documentId;
        const row = state.collectionDocuments.find((item) => item.collectionId === key.collectionId && item.documentId === key.documentId);
        if (!row) throw new Error('collection document missing');
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    file: {
      async findMany({ where, select }) {
        return state.files
          .filter((row) => matchesWhere(row, where))
          .map((row) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
      },
      async findFirst({ where, select }) {
        const row = state.files.find((file) => matchesWhere(file, where));
        if (!row) return null;
        return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };
      },
    },
  };
  return prisma;
}

function createMemoryChunkStore() {
  const rows = [];
  return {
    rows,
    async findExistingByHash(collectionId, documentId, hashes) {
      const out = new Map();
      for (const hash of hashes) {
        const matches = rows.filter((row) => row.collectionId === collectionId && row.contentHash === hash);
        if (matches.length > 0) {
          out.set(hash, { sameDocument: matches.some((row) => row.documentId === documentId) });
        }
      }
      return out;
    },
    async insertChunk(chunk, embedding) {
      if (rows.some((row) => row.collectionId === chunk.collectionId && row.documentId === chunk.documentId && row.contentHash === chunk.contentHash)) return;
      rows.push({ ...chunk, embedding, documentName: chunk.metadata?.originalName || chunk.documentId });
    },
    async copyChunkForDocument(chunk) {
      if (rows.some((row) => row.collectionId === chunk.collectionId && row.documentId === chunk.documentId && row.contentHash === chunk.contentHash)) return false;
      const existing = rows.find((row) => row.collectionId === chunk.collectionId && row.contentHash === chunk.contentHash);
      if (!existing) return false;
      rows.push({ ...chunk, embedding: existing.embedding, documentName: chunk.metadata?.originalName || chunk.documentId });
      return true;
    },
    async countChunks({ collectionId, documentId }) {
      return rows.filter((row) => row.collectionId === collectionId && (!documentId || row.documentId === documentId)).length;
    },
    async search({ collectionId, query, limit }) {
      const q = String(query || '').toLowerCase();
      const candidates = rows
        .filter((row) => row.collectionId === collectionId)
        .map((row) => ({
          id: row.id,
          content: row.content,
          documentId: row.documentId,
          collectionId: row.collectionId,
          page: row.page,
          offset: row.offset,
          contentHash: row.contentHash,
          tokenCount: row.tokenCount,
          metadata: row.metadata,
          documentName: row.metadata?.originalName || row.documentId,
          vectorScore: row.content.toLowerCase().includes(q) ? 0.9 : 0.3,
          textScore: row.content.toLowerCase().includes(q) ? 1 : 0,
        }))
        .slice(0, limit);
      return {
        vectorRows: candidates.map((row) => ({ ...row, source: 'vector' })),
        keywordRows: candidates.filter((row) => row.textScore > 0).map((row) => ({ ...row, source: 'keyword' })),
      };
    },
  };
}

test('creates a persistent document collection for the owner', async () => {
  const prisma = createFakePrisma();
  const collection = await service.createCollection({
    prisma,
    ownerId: 'user-1',
    name: '  Expediente corporativo  ',
    description: 'Documentos de trabajo',
  });
  assert.equal(collection.ownerId, 'user-1');
  assert.equal(collection.name, 'Expediente corporativo');
  assert.equal(collection.docCount, 0);
  assert.equal(collection.chunkCount, 0);
});

test('ingests idempotently and does not re-embed an existing content hash', async () => {
  const prisma = createFakePrisma();
  const collection = await service.createCollection({ prisma, ownerId: 'user-1', name: 'Colección' });
  prisma._state.files.push(
    { id: 'file-1', userId: 'user-1', originalName: 'a.pdf', mimeType: 'application/pdf', extractedText: 'La utilidad neta fue 100 y el margen fue estable.', deletedAt: null },
    { id: 'file-2', userId: 'user-1', originalName: 'b.pdf', mimeType: 'application/pdf', extractedText: 'La utilidad neta fue 100 y el margen fue estable.', deletedAt: null },
  );
  const chunkStore = createMemoryChunkStore();
  await service.addDocumentsToCollection({
    prisma,
    ownerId: 'user-1',
    collectionId: collection.id,
    documentIds: ['file-1', 'file-2'],
    enqueue: false,
    chunkStore,
  });

  const embeddedTexts = [];
  const embedder = async (texts) => {
    embeddedTexts.push(...texts);
    return texts.map((_, i) => Float32Array.from([1, i, 0]));
  };

  const first = await service.ingestCollectionDocuments({
    prisma,
    ownerId: 'user-1',
    collectionId: collection.id,
    chunkStore,
    embedder,
  });
  assert.equal(first.failed, 0);
  assert.equal(embeddedTexts.length, 1);
  assert.equal(chunkStore.rows.length, 2, 'same content is linked to both documents without a second embedding call');

  const second = await service.ingestCollectionDocuments({
    prisma,
    ownerId: 'user-1',
    collectionId: collection.id,
    chunkStore,
    embedder,
  });
  assert.equal(second.failed, 0);
  assert.equal(embeddedTexts.length, 1, 'second ingest skips already-indexed document/hash pairs');
  assert.equal(chunkStore.rows.length, 2);
});

test('retrieval is bounded and reports omitted chunks', async () => {
  const prisma = createFakePrisma();
  const collection = await service.createCollection({ prisma, ownerId: 'user-1', name: 'Colección' });
  const chunkStore = createMemoryChunkStore();
  for (let i = 0; i < 10; i++) {
    chunkStore.rows.push({
      id: `chunk-${i}`,
      ownerId: 'user-1',
      collectionId: collection.id,
      documentId: `file-${i}`,
      content: `Ingreso operativo y margen bruto del trimestre ${i}.`,
      contentHash: `hash-${i}`,
      tokenCount: 8,
      page: i + 1,
      offset: i * 100,
      metadata: { originalName: `doc-${i}.pdf` },
    });
  }
  const out = await service.queryCollection({
    prisma,
    ownerId: 'user-1',
    collectionId: collection.id,
    question: 'ingreso operativo',
    options: { maxChunks: 3, tokenBudget: 100 },
    chunkStore,
    embedder: async () => [Float32Array.from([1, 0, 0])],
  });
  assert.equal(out.meta.returnedChunks, 3);
  assert.equal(out.citations.length, 3);
  assert.equal(out.meta.truncated, true);
  assert.ok(out.meta.omittedChunks > 0);
});

test('query returns citations or the explicit no-evidence declaration', async () => {
  const prisma = createFakePrisma();
  const collection = await service.createCollection({ prisma, ownerId: 'user-1', name: 'Vacía' });
  const empty = await service.queryCollection({
    prisma,
    ownerId: 'user-1',
    collectionId: collection.id,
    question: 'qué dice',
    chunkStore: createMemoryChunkStore(),
    embedder: async () => [Float32Array.from([1])],
  });
  assert.equal(empty.answer, 'sin evidencia en la colección');
  assert.deepEqual(empty.citations, []);

  const cited = service.buildExtractiveAnswer({
    question: 'margen',
    chunks: [{
      id: 'chunk-1',
      documentId: 'doc-1',
      documentName: 'reporte.pdf',
      page: 3,
      offset: 120,
      contentHash: 'hash',
      content: 'El margen bruto aumentó en el trimestre.',
    }],
  });
  assert.match(cited.answer, /\[1\]/);
  assert.equal(cited.citations[0].document, 'reporte.pdf');
});
