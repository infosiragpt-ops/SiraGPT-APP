'use strict';

const crypto = require('crypto');
const rag = require('./rag-service');

const DEFAULT_MAX_COLLECTION_DOCUMENTS = 500;
const DEFAULT_MAX_RETRIEVED_CHUNKS = 24;
const HARD_MAX_RETRIEVED_CHUNKS = 80;
const DEFAULT_TOKEN_BUDGET = 12000;
const HARD_TOKEN_BUDGET = 32000;
const DEFAULT_CHUNK_SIZE_CHARS = 4800;
const DEFAULT_CHUNK_OVERLAP_CHARS = 800;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function maxCollectionDocuments() {
  return positiveInt(process.env.SIRAGPT_COLLECTION_MAX_DOCS, DEFAULT_MAX_COLLECTION_DOCUMENTS);
}

function maxRetrievedChunks(value) {
  return clampInt(
    value ?? process.env.SIRAGPT_COLLECTION_MAX_RETRIEVED_CHUNKS,
    DEFAULT_MAX_RETRIEVED_CHUNKS,
    1,
    HARD_MAX_RETRIEVED_CHUNKS,
  );
}

function tokenBudget(value) {
  return clampInt(
    value ?? process.env.SIRAGPT_COLLECTION_TOKEN_BUDGET,
    DEFAULT_TOKEN_BUDGET,
    512,
    HARD_TOKEN_BUDGET,
  );
}

function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function contentHash(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || '').replace(/\s+/g, ' ').trim())
    .digest('hex');
}

function vectorLiteral(vector) {
  if (!vector || typeof vector[Symbol.iterator] !== 'function') {
    throw new Error('embedding vector is required');
  }
  return `[${Array.from(vector).map((n) => Number(n).toFixed(6)).join(',')}]`;
}

function sqlInClause(start, values) {
  return values.map((_, index) => `$${start + index}`).join(', ');
}

function errorWithStatus(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function requireOwnedCollection(prisma, ownerId, collectionId) {
  const collection = await prisma.documentCollection.findFirst({
    where: { id: collectionId, ownerId },
  });
  if (!collection) {
    throw errorWithStatus('collection not found', 404, 'document_collection_not_found');
  }
  return collection;
}

function normalizeDocumentIds(documentIds) {
  return Array.from(new Set((documentIds || []).map(String).map((id) => id.trim()).filter(Boolean)));
}

function makeChunkRecords(file, options = {}) {
  const text = String(file?.extractedText || '').trim();
  if (!text) return [];
  const pieces = rag.chunk(text, {
    size: positiveInt(options.chunkSizeChars, DEFAULT_CHUNK_SIZE_CHARS),
    overlap: positiveInt(options.chunkOverlapChars, DEFAULT_CHUNK_OVERLAP_CHARS),
  });
  let cursor = 0;
  return pieces.map((piece, ordinal) => {
    const probe = piece.slice(0, Math.min(80, piece.length));
    const foundAt = probe ? text.indexOf(probe, cursor) : -1;
    const offset = foundAt >= 0 ? foundAt : cursor;
    cursor = Math.max(offset + piece.length, cursor);
    return {
      content: piece,
      contentHash: contentHash(piece),
      page: null,
      offset,
      tokenCount: approxTokens(piece),
      metadata: {
        ordinal,
        source: 'file.extractedText',
        mimeType: file.mimeType || null,
        originalName: file.originalName || null,
      },
    };
  });
}

function createPostgresChunkStore(prisma) {
  return {
    async findExistingByHash(collectionId, documentId, hashes) {
      if (!hashes.length) return new Map();
      const placeholders = sqlInClause(3, hashes);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT content_hash AS "contentHash",
                BOOL_OR(document_id = $2) AS "sameDocument"
         FROM document_collection_chunks
         WHERE collection_id = $1 AND content_hash IN (${placeholders})
         GROUP BY content_hash`,
        collectionId,
        documentId,
        ...hashes,
      );
      return new Map(rows.map((row) => [row.contentHash, { sameDocument: Boolean(row.sameDocument) }]));
    },

    async insertChunk(chunk, embedding) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO document_collection_chunks
          (id, collection_id, document_id, owner_id, content, embedding, page, "offset", token_count, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (collection_id, document_id, content_hash) DO NOTHING`,
        chunk.id,
        chunk.collectionId,
        chunk.documentId,
        chunk.ownerId,
        chunk.content,
        vectorLiteral(embedding),
        chunk.page,
        chunk.offset,
        chunk.tokenCount,
        chunk.contentHash,
        JSON.stringify(chunk.metadata || {}),
      );
    },

    async copyChunkForDocument(chunk) {
      const inserted = await prisma.$queryRawUnsafe(
        `INSERT INTO document_collection_chunks
          (id, collection_id, document_id, owner_id, content, embedding, page, "offset", token_count, content_hash, metadata)
         SELECT $1, $2, $3, $4, $5, existing.embedding, $6, $7, $8, $9, $10::jsonb
         FROM document_collection_chunks existing
         WHERE existing.collection_id = $2 AND existing.content_hash = $9
         ORDER BY existing.created_at ASC
         LIMIT 1
         ON CONFLICT (collection_id, document_id, content_hash) DO NOTHING
         RETURNING id`,
        chunk.id,
        chunk.collectionId,
        chunk.documentId,
        chunk.ownerId,
        chunk.content,
        chunk.page,
        chunk.offset,
        chunk.tokenCount,
        chunk.contentHash,
        JSON.stringify(chunk.metadata || {}),
      );
      return Array.isArray(inserted) && inserted.length > 0;
    },

    async countChunks({ collectionId, documentId }) {
      const whereDoc = documentId ? 'AND document_id = $2' : '';
      const params = documentId ? [collectionId, documentId] : [collectionId];
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM document_collection_chunks WHERE collection_id = $1 ${whereDoc}`,
        ...params,
      );
      return Number(rows?.[0]?.count || 0);
    },

    async search({ ownerId, collectionId, query, queryVector, limit }) {
      const semanticLimit = Math.max(1, Math.min(limit, 120));
      const keywordLimit = Math.max(1, Math.min(limit, 120));
      const vectorRows = queryVector
        ? await prisma.$queryRawUnsafe(
          `SELECT c.id,
                  c.content,
                  c.document_id AS "documentId",
                  c.collection_id AS "collectionId",
                  c.page,
                  c."offset",
                  c.content_hash AS "contentHash",
                  c.token_count AS "tokenCount",
                  c.metadata,
                  f."originalName" AS "documentName",
                  (1 - (c.embedding <=> $3::vector))::float AS "vectorScore",
                  0::float AS "textScore",
                  'vector' AS "source"
           FROM document_collection_chunks c
           JOIN files f ON f.id = c.document_id
           WHERE c.owner_id = $1 AND c.collection_id = $2
           ORDER BY c.embedding <=> $3::vector
           LIMIT $4`,
          ownerId,
          collectionId,
          vectorLiteral(queryVector),
          semanticLimit,
        )
        : [];
      const keywordRows = await prisma.$queryRawUnsafe(
        `WITH q AS (
           SELECT plainto_tsquery('spanish', $3) || plainto_tsquery('simple', $3) AS query
         )
         SELECT c.id,
                c.content,
                c.document_id AS "documentId",
                c.collection_id AS "collectionId",
                c.page,
                c."offset",
                c.content_hash AS "contentHash",
                c.token_count AS "tokenCount",
                c.metadata,
                f."originalName" AS "documentName",
                0::float AS "vectorScore",
                ts_rank_cd(c.content_tsv, q.query)::float AS "textScore",
                'keyword' AS "source"
         FROM document_collection_chunks c
         JOIN files f ON f.id = c.document_id
         CROSS JOIN q
         WHERE c.owner_id = $1
           AND c.collection_id = $2
           AND numnode(q.query) > 0
           AND c.content_tsv @@ q.query
         ORDER BY "textScore" DESC
         LIMIT $4`,
        ownerId,
        collectionId,
        query,
        keywordLimit,
      ).catch(() => []);
      return { vectorRows, keywordRows };
    },
  };
}

async function createCollection({ prisma, ownerId, name, description = null }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw errorWithStatus('collection name is required', 400, 'document_collection_name_required');
  return prisma.documentCollection.create({
    data: {
      ownerId,
      name: cleanName.slice(0, 180),
      description: description ? String(description).slice(0, 2000) : null,
      status: 'ready',
    },
  });
}

async function listCollections({ prisma, ownerId, take = 100 }) {
  return prisma.documentCollection.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: clampInt(take, 100, 1, 200),
  });
}

async function syncCollectionCounts({ prisma, chunkStore, collectionId }) {
  const [docCount, chunkCount] = await Promise.all([
    prisma.collectionDocument.count({ where: { collectionId } }),
    chunkStore.countChunks({ collectionId }),
  ]);
  await prisma.documentCollection.update({
    where: { id: collectionId },
    data: { docCount, chunkCount },
  });
  return { docCount, chunkCount };
}

async function addDocumentsToCollection({
  prisma,
  ownerId,
  collectionId,
  documentIds,
  queue = null,
  enqueue = true,
  chunkStore = null,
}) {
  await requireOwnedCollection(prisma, ownerId, collectionId);
  const ids = normalizeDocumentIds(documentIds);
  if (!ids.length) throw errorWithStatus('documentIds must be a non-empty array', 400, 'document_collection_documents_required');

  const files = await prisma.file.findMany({
    where: { id: { in: ids }, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  const found = new Set(files.map((f) => f.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw errorWithStatus('one or more documents were not found', 404, 'document_collection_document_not_found');
  }

  const existing = await prisma.collectionDocument.findMany({
    where: { collectionId, documentId: { in: ids } },
    select: { documentId: true },
  });
  const existingIds = new Set(existing.map((d) => d.documentId));
  const currentCount = await prisma.collectionDocument.count({ where: { collectionId } });
  const nextCount = currentCount + ids.filter((id) => !existingIds.has(id)).length;
  const maxDocs = maxCollectionDocuments();
  if (nextCount > maxDocs) {
    throw errorWithStatus(`collection document limit exceeded (${maxDocs})`, 413, 'document_collection_limit_exceeded');
  }

  await prisma.documentCollection.update({ where: { id: collectionId }, data: { status: 'indexing' } });
  for (const documentId of ids) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.collectionDocument.upsert({
      where: { collectionId_documentId: { collectionId, documentId } },
      update: { status: 'queued', lastError: null },
      create: { collectionId, documentId, ownerId, status: 'queued' },
    });
  }
  const store = chunkStore || createPostgresChunkStore(prisma);
  await syncCollectionCounts({ prisma, chunkStore: store, collectionId });

  let queued = false;
  if (enqueue && queue && typeof queue.enqueueCollectionIngest === 'function') {
    await queue.enqueueCollectionIngest({ ownerId, collectionId, documentIds: ids });
    queued = true;
  }
  return { collectionId, documentIds: ids, queued };
}

async function indexOneDocument({
  prisma,
  ownerId,
  collectionId,
  documentId,
  chunkStore,
  embedder = rag.embed,
  options = {},
}) {
  const file = await prisma.file.findFirst({
    where: { id: documentId, userId: ownerId, deletedAt: null },
    select: { id: true, originalName: true, mimeType: true, extractedText: true },
  });
  if (!file) throw errorWithStatus('document not found', 404, 'document_collection_document_not_found');

  await prisma.collectionDocument.update({
    where: { collectionId_documentId: { collectionId, documentId } },
    data: { status: 'indexing', lastError: null },
  });

  const chunks = makeChunkRecords(file, options).map((chunk) => ({
    ...chunk,
    id: crypto.randomUUID(),
    ownerId,
    collectionId,
    documentId,
  }));

  if (chunks.length === 0) {
    await prisma.collectionDocument.update({
      where: { collectionId_documentId: { collectionId, documentId } },
      data: { status: 'ready', chunkCount: 0 },
    });
    return { documentId, embedded: 0, copied: 0, skipped: 0, chunks: 0, noText: true };
  }

  const existing = await chunkStore.findExistingByHash(
    collectionId,
    documentId,
    Array.from(new Set(chunks.map((chunk) => chunk.contentHash))),
  );
  const toEmbed = [];
  let copied = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const existingHit = existing.get(chunk.contentHash);
    if (existingHit?.sameDocument) {
      skipped += 1;
      continue;
    }
    if (existingHit) {
      // eslint-disable-next-line no-await-in-loop
      const didCopy = await chunkStore.copyChunkForDocument(chunk);
      if (didCopy) copied += 1;
      else toEmbed.push(chunk);
      continue;
    }
    toEmbed.push(chunk);
  }

  if (toEmbed.length > 0) {
    const vectors = await embedder(toEmbed.map((chunk) => chunk.content));
    if (!Array.isArray(vectors) || vectors.length !== toEmbed.length) {
      throw new Error(`collection embedder returned ${Array.isArray(vectors) ? vectors.length : 'non-array'} vectors for ${toEmbed.length} chunks`);
    }
    for (let i = 0; i < toEmbed.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await chunkStore.insertChunk(toEmbed[i], vectors[i]);
    }
  }

  const chunkCount = await chunkStore.countChunks({ collectionId, documentId });
  await prisma.collectionDocument.update({
    where: { collectionId_documentId: { collectionId, documentId } },
    data: { status: 'ready', chunkCount, lastError: null },
  });
  return { documentId, embedded: toEmbed.length, copied, skipped, chunks: chunkCount, noText: false };
}

async function ingestCollectionDocuments({
  prisma,
  ownerId,
  collectionId,
  documentIds = null,
  chunkStore = null,
  embedder = rag.embed,
  progress = null,
  options = {},
}) {
  await requireOwnedCollection(prisma, ownerId, collectionId);
  const store = chunkStore || createPostgresChunkStore(prisma);
  const where = { collectionId, ownerId };
  const ids = normalizeDocumentIds(documentIds);
  if (ids.length) where.documentId = { in: ids };
  const docs = await prisma.collectionDocument.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    select: { documentId: true },
  });
  await prisma.documentCollection.update({ where: { id: collectionId }, data: { status: 'indexing' } });

  const results = [];
  for (let i = 0; i < docs.length; i++) {
    const documentId = docs[i].documentId;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await indexOneDocument({
        prisma,
        ownerId,
        collectionId,
        documentId,
        chunkStore: store,
        embedder,
        options,
      });
      results.push(result);
      if (progress && typeof progress === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await progress({ completed: i + 1, total: docs.length, documentId, status: 'ready' });
      }
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.collectionDocument.update({
        where: { collectionId_documentId: { collectionId, documentId } },
        data: { status: 'failed', lastError: err?.message || String(err) },
      }).catch(() => {});
      results.push({ documentId, failed: true, error: err?.message || String(err) });
      if (progress && typeof progress === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await progress({ completed: i + 1, total: docs.length, documentId, status: 'failed' });
      }
    }
  }

  const counts = await syncCollectionCounts({ prisma, chunkStore: store, collectionId });
  const failed = results.filter((r) => r.failed).length;
  await prisma.documentCollection.update({
    where: { id: collectionId },
    data: { status: failed > 0 ? 'partial' : 'ready' },
  });
  return { collectionId, processed: results.length, failed, results, ...counts };
}

function queryTokens(query) {
  return new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

function lexicalOverlapScore(text, tokens) {
  if (!tokens || tokens.size === 0) return 0;
  const textTokens = queryTokens(text);
  let hits = 0;
  for (const token of tokens) if (textTokens.has(token)) hits += 1;
  return hits / tokens.size;
}

function fuseSearchRows(vectorRows, keywordRows, question) {
  const byId = new Map();
  const qTokens = queryTokens(question);
  const add = (row, rank, kind) => {
    const existing = byId.get(row.id) || {
      ...row,
      vectorRank: null,
      keywordRank: null,
      vectorScore: Number(row.vectorScore || 0),
      textScore: Number(row.textScore || 0),
      fusionScore: 0,
    };
    existing[`${kind}Rank`] = rank + 1;
    if (kind === 'vector') existing.vectorScore = Math.max(existing.vectorScore || 0, Number(row.vectorScore || 0));
    if (kind === 'keyword') existing.textScore = Math.max(existing.textScore || 0, Number(row.textScore || 0));
    existing.fusionScore += 1 / (60 + rank + 1);
    existing.lexicalScore = lexicalOverlapScore(existing.content, qTokens);
    byId.set(row.id, existing);
  };
  vectorRows.forEach((row, rank) => add(row, rank, 'vector'));
  keywordRows.forEach((row, rank) => add(row, rank, 'keyword'));
  return Array.from(byId.values());
}

function rerankCandidates(candidates, question) {
  const qTokens = queryTokens(question);
  return candidates
    .map((candidate) => ({
      ...candidate,
      rerankScore:
        (Number(candidate.fusionScore || 0) * 4) +
        (Number(candidate.vectorScore || 0) * 0.35) +
        (Number(candidate.textScore || 0) * 0.2) +
        (lexicalOverlapScore(candidate.content, qTokens) * 1.2),
    }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
}

function boundCandidates(candidates, { maxChunks, budget }) {
  const selected = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxChunks) break;
    const t = Number(candidate.tokenCount) || approxTokens(candidate.content);
    if (usedTokens + t > budget && selected.length > 0) break;
    selected.push({ ...candidate, tokenCount: t });
    usedTokens += t;
  }
  return {
    selected,
    usedTokens,
    omitted: Math.max(0, candidates.length - selected.length),
    truncated: candidates.length > selected.length,
  };
}

function bestEvidenceSentence(content, question) {
  const tokens = queryTokens(question);
  const sentences = String(content || '')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const pool = sentences.length ? sentences : [String(content || '').replace(/\s+/g, ' ').trim()];
  const ranked = pool
    .map((sentence) => ({ sentence, score: lexicalOverlapScore(sentence, tokens) }))
    .sort((a, b) => b.score - a.score);
  const picked = ranked[0]?.sentence || '';
  return picked.length > 700 ? `${picked.slice(0, 697).trim()}...` : picked;
}

function citationFor(candidate, index) {
  return {
    index,
    chunkId: candidate.id,
    documentId: candidate.documentId,
    document: candidate.documentName || candidate.documentId,
    page: candidate.page ?? null,
    offset: candidate.offset ?? null,
    contentHash: candidate.contentHash,
  };
}

function buildExtractiveAnswer({ question, chunks }) {
  if (!chunks || chunks.length === 0) {
    return {
      answer: 'sin evidencia en la colección',
      citations: [],
      supported: false,
    };
  }
  const citations = chunks.map((chunk, i) => citationFor(chunk, i + 1));
  const claims = chunks.map((chunk, i) => {
    const evidence = bestEvidenceSentence(chunk.content, question);
    return `${evidence} [${i + 1}]`;
  });
  return {
    answer: claims.join('\n'),
    citations,
    supported: true,
  };
}

async function queryCollection({
  prisma,
  ownerId,
  collectionId,
  question,
  options = {},
  chunkStore = null,
  embedder = rag.embed,
}) {
  const cleanQuestion = String(question || '').trim();
  if (cleanQuestion.length < 2) throw errorWithStatus('question is required', 400, 'document_collection_question_required');
  await requireOwnedCollection(prisma, ownerId, collectionId);

  const store = chunkStore || createPostgresChunkStore(prisma);
  const boundedMaxChunks = maxRetrievedChunks(options.maxChunks || options.k);
  const boundedBudget = tokenBudget(options.tokenBudget);
  const searchLimit = Math.min(Math.max(boundedMaxChunks * 3, 12), 120);

  let queryVector = null;
  let vectorError = null;
  try {
    const vectors = await embedder([cleanQuestion]);
    queryVector = vectors?.[0] || null;
  } catch (err) {
    vectorError = err?.message || String(err);
  }

  const { vectorRows, keywordRows } = await store.search({
    ownerId,
    collectionId,
    query: cleanQuestion,
    queryVector,
    limit: searchLimit,
  });
  const fused = fuseSearchRows(vectorRows || [], keywordRows || [], cleanQuestion);
  const reranked = rerankCandidates(fused, cleanQuestion);
  const bounded = boundCandidates(reranked, {
    maxChunks: boundedMaxChunks,
    budget: boundedBudget,
  });
  const answer = buildExtractiveAnswer({ question: cleanQuestion, chunks: bounded.selected });

  return {
    collectionId,
    question: cleanQuestion,
    answer: answer.answer,
    citations: answer.citations,
    supported: answer.supported,
    evidence: bounded.selected.map((chunk, i) => ({
      citationIndex: i + 1,
      chunkId: chunk.id,
      documentId: chunk.documentId,
      document: chunk.documentName || chunk.documentId,
      page: chunk.page ?? null,
      offset: chunk.offset ?? null,
      score: Number((chunk.rerankScore || 0).toFixed(6)),
      preview: String(chunk.content || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    })),
    meta: {
      retrievalMode: 'hybrid_vector_keyword_rrf',
      totalCandidates: fused.length,
      returnedChunks: bounded.selected.length,
      omittedChunks: bounded.omitted,
      truncated: bounded.truncated,
      maxChunks: boundedMaxChunks,
      tokenBudget: boundedBudget,
      usedTokens: bounded.usedTokens,
      vectorAvailable: Boolean(queryVector),
      ...(vectorError ? { vectorError } : {}),
    },
  };
}

module.exports = {
  createCollection,
  listCollections,
  addDocumentsToCollection,
  ingestCollectionDocuments,
  indexOneDocument,
  queryCollection,
  createPostgresChunkStore,
  makeChunkRecords,
  buildExtractiveAnswer,
  boundCandidates,
  rerankCandidates,
  contentHash,
  positiveInt,
  maxCollectionDocuments,
  maxRetrievedChunks,
  tokenBudget,
  _internals: {
    approxTokens,
    vectorLiteral,
    fuseSearchRows,
    lexicalOverlapScore,
    bestEvidenceSentence,
  },
};
