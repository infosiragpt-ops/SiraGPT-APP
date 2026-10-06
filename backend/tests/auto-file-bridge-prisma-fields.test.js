'use strict';

// Regression — prod 2026-10-03: every pasted document (≥200 chars of
// structured text, e.g. a class-recording link + instructions) died with
//   [auto-file-bridge] ingestPastedContent failed: Invalid prisma.file.create()
//   invocation … Unknown argument `source`
// because the File model has neither `source` nor `metadata` columns. Right
// behind it, documentIntelligence.analyzeFile was called as (fileRecord,
// content) instead of (prisma, { userId, fileId, fileRecord }) and would have
// thrown next. #990 moved the provenance to DocumentAnalysis.metadata; this
// test pins the contract by driving ingestPastedContent against a Prisma
// double that only accepts the columns declared in schema.prisma.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const fileModel = /model File \{([\s\S]*?)\n\}/.exec(schema);
assert.ok(fileModel, 'File model present in schema.prisma');
const FILE_FIELDS = new Set(
  fileModel[1].split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/)[0]),
);

function assertOnlySchemaFields(label, obj) {
  for (const key of Object.keys(obj || {})) {
    assert.ok(FILE_FIELDS.has(key), `${label}: \`${key}\` is not a column of File`);
  }
}

function loadBridgeWithDoubles() {
  const calls = { create: [], update: [], findMany: [] };
  const prisma = {
    file: {
      async create({ data }) {
        assertOnlySchemaFields('prisma.file.create.data', data);
        calls.create.push(data);
        return { id: 'file_1', createdAt: new Date(), ...data };
      },
      async update({ data }) {
        assertOnlySchemaFields('prisma.file.update.data', data);
        calls.update.push(data);
        return { id: 'file_1', ...data };
      },
      async findMany(args) {
        assertOnlySchemaFields('prisma.file.findMany.where', args.where);
        assertOnlySchemaFields('prisma.file.findMany.select', args.select);
        calls.findMany.push(args);
        return [];
      },
    },
    documentAnalysis: {
      async update({ data }) {
        calls.analysisUpdate = calls.analysisUpdate || [];
        calls.analysisUpdate.push(data);
        return { fileId: 'file_1', ...data };
      },
    },
  };
  const analyzeCalls = [];
  const doubles = {
    '../config/database': prisma,
    './document-intelligence': {
      async analyzeFile(prismaArg, opts) {
        analyzeCalls.push({ prismaArg, opts });
        assert.equal(prismaArg, prisma, 'analyzeFile must receive the prisma client first');
        assert.equal(opts.fileId, 'file_1');
        assert.equal(opts.userId, 'user_1');
        assert.ok(opts.fileRecord && opts.fileRecord.extractedText, 'fileRecord carries the pasted text');
        return { status: 'ready', language: 'es', chunkCount: 3, tableCount: 0, metadata: { originalName: 'x' } };
      },
    },
    './document-intent-analyzer': { async analyzeSingleDocument() { return { intent: 'reference' }; } },
    './rag/operational-runtime': { normaliseDocs: () => [] },
    './rag-service': {},
  };
  const original = Module.prototype.require;
  const bridgePath = path.join(__dirname, '..', 'src', 'services', 'auto-file-bridge.js');
  Module.prototype.require = function patched(id) {
    if (this.filename === bridgePath && doubles[id]) return doubles[id];
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[bridgePath];
    const bridge = require(bridgePath);
    return { bridge, calls, analyzeCalls };
  } finally {
    Module.prototype.require = original;
  }
}

const PASTE = [
  'Transcribe la grabación de la clase del minuto 1.5 al minuto 10.',
  'URL: https://upn.class.com/recordings/abc123',
  '',
  ...Array.from({ length: 14 }, (_, i) => `- Punto ${i + 1}: detalle de la clase con suficiente texto para contar como documento.`),
].join('\n');

test('ingestPastedContent only writes File columns that exist in schema.prisma', async () => {
  const { bridge, calls, analyzeCalls } = loadBridgeWithDoubles();
  const result = await bridge.ingestPastedContent('user_1', PASTE);
  assert.equal(result.autoFiled, true, `expected autoFiled, got ${JSON.stringify(result)}`);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].path.startsWith('auto/'), true);
  assert.equal('source' in calls.create[0], false);
  assert.equal('metadata' in calls.create[0], false);
  assert.equal(analyzeCalls.length, 1);
  // Provenance lives on DocumentAnalysis.metadata (it has a Json column), not on File.
  assert.equal(calls.analysisUpdate.length, 1);
  assert.equal(calls.analysisUpdate[0].metadata.source, 'paste');
  assert.equal(calls.analysisUpdate[0].metadata.lineCount, PASTE.split('\n').length);
  assert.deepEqual(result.analysis, { language: 'es', chunkCount: 3, tableCount: 0 });
  assert.equal(result.lineCount, PASTE.split('\n').length);
});

test('getAutoFilesForChat filters by the auto/ path namespace, not a source column', async () => {
  const { bridge, calls } = loadBridgeWithDoubles();
  await bridge.getAutoFilesForChat('user_1', 'chat_1');
  assert.equal(calls.findMany.length, 1);
  assert.deepEqual(calls.findMany[0].where.path, { startsWith: 'auto/' });
  assert.equal(calls.findMany[0].where.deletedAt, null);
});

test('auto-file-bridge calls analyzeFile with the prisma-first signature', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auto-file-bridge.js'), 'utf8');
  assert.match(src, /documentIntelligence\.analyzeFile\(prisma,\s*\{/);
  assert.doesNotMatch(src, /analyzeFile\(fileRecord/);
});
