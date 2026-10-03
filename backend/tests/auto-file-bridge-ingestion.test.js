'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const documentIntelligence = require('../src/services/document-intelligence');
const operationalRag = require('../src/services/rag/operational-runtime');

const bridgePath = path.resolve(__dirname, '../src/services/auto-file-bridge.js');
const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
const fileFields = new Set([...schema.match(/model File \{([\s\S]*?)^\}/m)[1]
  .matchAll(/^\s+(\w+)\s+[A-Z]\w*[?\[\]]*/gm)].map(match => match[1]));
const sample = '# Informe de prueba\n\n' + 'La información para la prueba tiene contenido verificable. '.repeat(30);
const privateError = new Error('private-document-content Bearer fixture-secret user@example.invalid');

function load(filename, dependencies, logger) {
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : localRequire(id),
    process: { env: {} }, Buffer, console: logger, setImmediate: dependencies.setImmediate,
  }, { filename });
  return module.exports;
}

function fixture({ createError, analyzeError, intentError, indexError, indexThrows = false } = {}) {
  const rows = [];
  const analyses = new Map();
  const chunks = [];
  const tables = [];
  const background = [];
  const logs = [];
  const writes = [];
  const calls = [];
  const logger = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, (...args) => logs.push(args)]));
  function validateFileFields(value) {
    for (const key of Object.keys(value)) assert.ok(fileFields.has(key), `File schema does not define ${key}`);
  }
  const prisma = {
    file: {
      async create({ data }) {
        if (createError) throw createError;
        validateFileFields(data);
        const row = { id: `file-${rows.length + 1}`, createdAt: new Date(), deletedAt: null, ...data };
        rows.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        validateFileFields(data);
        writes.push({ ...data });
        const row = rows.find(item => item.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async findMany({ where, select, take }) {
        validateFileFields(where);
        validateFileFields(select);
        calls.push({ where, select, take });
        return rows.filter(row => row.userId === where.userId
          && row.deletedAt === where.deletedAt
          && row.path.startsWith(where.path.startsWith)
          && row.createdAt >= where.createdAt.gte)
          .slice(0, take).map(row => ({ ...row, documentAnalysis: analyses.get(row.id) || null }));
      },
    },
    documentAnalysis: {
      async findUnique({ where }) { return analyses.get(where.fileId) || null; },
      async upsert({ where, create, update }) {
        const record = analyses.get(where.fileId);
        const next = { id: `analysis-${where.fileId}`, createdAt: new Date(), updatedAt: new Date(), ...(record ? { ...record, ...update } : create) };
        analyses.set(where.fileId, next);
        return next;
      },
      async update({ where, data }) {
        const entry = where.fileId ? analyses.get(where.fileId) : [...analyses.values()].find(item => item.id === where.id);
        assert.ok(entry, 'analysis must be persisted by the canonical analyzer first');
        Object.assign(entry, data);
        return entry;
      },
    },
    documentChunk: {
      async deleteMany() {},
      async createMany({ data }) { chunks.push(...data); },
      async findMany({ where, take }) { return chunks.filter(item => item.analysisId === where.analysisId).slice(0, take); },
    },
    documentTable: {
      async deleteMany() {},
      async createMany({ data }) { tables.push(...data); },
      async findMany({ where, take }) { return tables.filter(item => item.analysisId === where.analysisId).slice(0, take); },
    },
    async $transaction(operations) { return Promise.all(operations); },
  };
  const rag = {
    async listSources() { return []; },
    async ingest(userId, collection, docs) {
      calls.push({ userId, collection, docs });
      if (indexError) throw indexError;
      return { chunksAdded: 1, totalChunks: 1 };
    },
  };
  const stage = load(path.resolve(__dirname, '../src/services/file-processing-status.js'), {}, logger);
  const bridge = load(bridgePath, {
    '../config/database': prisma,
    './file-processing-status': stage,
    './document-intelligence': analyzeError ? { async analyzeFile() { throw analyzeError; } } : documentIntelligence,
    './document-intent-analyzer': { async analyzeSingleDocument() { if (intentError) throw intentError; return { intent: 'read' }; } },
    './rag/operational-runtime': indexThrows ? { ...operationalRag, async ensureIndexed() { throw indexError; } } : operationalRag,
    './rag-service': rag,
    setImmediate: callback => background.push(callback),
  }, logger);
  return { bridge, prisma, rows, analyses, chunks, logs, writes, calls, async flush() { while (background.length) await background.shift()(); } };
}

function assertNoPrivateData(value) {
  assert.doesNotMatch(JSON.stringify(value), /private-document-content|fixture-secret|example\.invalid|Bearer/);
}

test('pasted content persists through the real document analyzer using fields present in the File schema', async () => {
  const f = fixture();
  const result = await f.bridge.ingestPastedContent('owner-a', sample, { fileName: 'informe.md' });
  assert.equal(result.autoFiled, true);
  assert.equal(f.rows[0].extractedText, sample);
  assert.equal(f.rows[0].path, 'auto/informe.md');
  assert.equal(f.rows[0].processingStage, 'extracting');
  assert.ok(f.chunks.length > 0);
  const analysis = f.analyses.get(result.fileId);
  assert.equal(analysis.metadata.autoFiled, true);
  assert.equal(analysis.metadata.source, 'paste');
  assert.equal(analysis.metadata.detectedFormat, 'md');
  assert.equal(analysis.metadata.charCount, sample.length);
  assert.equal(analysis.metadata.lineCount, sample.split('\n').length);
  assert.equal(analysis.metadata.extractionSource, 'stored_text');
  assert.equal(result.analysis.chunkCount, analysis.chunkCount);
  await f.flush();
  assert.equal(f.rows[0].processingStage, 'ready');
  assert.deepEqual(f.writes.filter(item => item.processingStage).map(item => item.processingStage), ['extracting', 'chunking', 'embedding', 'indexing', 'ready']);
  assert.equal(f.calls.find(call => call.docs).userId, 'owner-a');
});

test('auto-file listing uses existing fields and excludes other owners, deleted, uploaded and expired files', async () => {
  const f = fixture();
  f.rows.push(
    { id: 'mine', userId: 'owner-a', path: 'auto/paste.txt', createdAt: new Date(), deletedAt: null },
    { id: 'other', userId: 'owner-b', path: 'auto/paste.txt', createdAt: new Date(), deletedAt: null },
    { id: 'deleted', userId: 'owner-a', path: 'auto/paste.txt', createdAt: new Date(), deletedAt: new Date() },
    { id: 'uploaded', userId: 'owner-a', path: 'uploads/paste.txt', createdAt: new Date(), deletedAt: null },
    { id: 'expired', userId: 'owner-a', path: 'auto/paste.txt', createdAt: new Date(0), deletedAt: null },
  );
  f.analyses.set('mine', { metadata: { autoFiled: true, source: 'paste' } });
  const listed = await f.bridge.getAutoFilesForChat('owner-a', null);
  assert.deepEqual(Array.from(listed, row => row.id), ['mine']);
  assert.equal(listed[0].metadata.autoFiled, true);
  assert.equal(Object.hasOwn(listed[0], 'documentAnalysis'), false);
});

test('ingestion errors expose a fixed actionable response and never raw Prisma arguments or pasted text', async () => {
  const f = fixture({ createError: privateError });
  const result = await f.bridge.ingestPastedContent('owner-a', sample);
  assert.equal(result.autoFiled, false);
  assert.equal(result.reason, 'ingestion_failed');
  assert.equal(result.code, 'E_FILE_INGESTION');
  assert.ok(result.error.length > 0);
  assertNoPrivateData([result, f.logs]);
});

test('analysis failure leaves the created file at a terminal failed stage with a safe reason', async () => {
  const f = fixture({ analyzeError: privateError });
  const result = await f.bridge.ingestPastedContent('owner-a', sample);
  assert.equal(result.autoFiled, false);
  assert.equal(f.rows[0]?.processingStage, 'failed');
  assert.equal(f.rows[0].processingError, 'E_FILE_INGESTION');
  assertNoPrivateData([result, f.logs, f.writes]);
});

for (const indexThrows of [false, true]) test(`RAG ${indexThrows ? 'exception' : 'negative acknowledgment'} finishes failed rather than claiming ready`, async () => {
  const f = fixture({ indexError: privateError, indexThrows });
  const result = await f.bridge.ingestPastedContent('owner-a', sample);
  assert.equal(result.autoFiled, true);
  await f.flush();
  assert.equal(f.rows[0].processingStage, 'failed');
  assert.equal(f.rows[0].processingError, 'E_FILE_INDEXING');
  assert.ok(!f.writes.some(item => item.processingStage === 'ready'));
  assertNoPrivateData([f.logs, f.writes]);
});

test('optional intent analysis failure does not prevent ingestion or echo its exception', async () => {
  const f = fixture({ intentError: privateError });
  const result = await f.bridge.ingestPastedContent('owner-a', sample);
  assert.equal(result.autoFiled, true);
  assert.equal(result.intent, null);
  await f.flush();
  assert.equal(f.rows[0].processingStage, 'ready');
  assertNoPrivateData(f.logs);
});
