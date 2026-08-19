/**
 * Tests for document-context service.
 *
 * Run with: node --test backend/tests/document-context.test.js
 *
 * Uses Node.js built-in test runner (node:test) with describe/it.
 * Test require paths are relative to backend/ directory.
 */

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── Module under test ──────────────────────────────────────
const documentContext = require('../src/services/agents/document-context');

// ── Test doubles ───────────────────────────────────────────

/**
 * Stub file record — simulates what Prisma returns for a File row.
 */
function stubFile(overrides = {}) {
  return {
    id: 'file-001',
    userId: 'user-001',
    originalName: 'reporte-financiero.pdf',
    filename: 'reporte-financiero.pdf',
    mimeType: 'application/pdf',
    size: 245760,
    path: '/tmp/uploads/user-001/reporte-financiero.pdf',
    extractedText: 'El reporte financiero muestra un crecimiento del 15% en ingresos durante el ultimo trimestre. La utilidad neta aumento un 22% comparado con el mismo periodo del ano anterior. Los gastos operativos se redujeron en un 8%.',
    openaiFileId: 'file-abc123',
    processingStage: 'uploaded',
    processingError: null,
    processingStageAt: new Date(),
    createdAt: new Date('2025-06-01'),
    updatedAt: new Date('2025-06-01'),
    ...overrides,
  };
}

/**
 * Stub analysis record — simulates what document-intelligence returns.
 */
function stubAnalysis(overrides = {}) {
  return {
    id: 'analysis-001',
    userId: 'user-001',
    fileId: 'file-001',
    status: 'ready',
    language: 'es',
    mimeType: 'application/pdf',
    pageCount: 5,
    sheetCount: null,
    slideCount: null,
    charCount: 580,
    chunkCount: 1,
    tableCount: 1,
    summary: 'reporte-financiero.pdf: 580 caracteres extraidos en 1 fragmento(s). Incluye 1 tabla(s) detectada(s). Vista inicial: El reporte financiero muestra un crecimiento del 15%...',
    textCoverage: { status: 'complete', charCount: 580, extractionCoverage: 0.92 },
    ocr: null,
    warnings: [],
    metadata: { originalName: 'reporte-financiero.pdf', extractionSource: 'stored_text' },
    chunks: [
      {
        ordinal: 1,
        sourceType: 'page',
        sourceLabel: 'Pagina 1',
        sectionTitle: null,
        text: 'El reporte financiero muestra un crecimiento del 15% en ingresos durante el ultimo trimestre. La utilidad neta aumento un 22% comparado con el mismo periodo del ano anterior. Los gastos operativos se redujeron en un 8%.',
        charCount: 285,
      },
    ],
    tables: [],
    createdAt: new Date('2025-06-01T10:00:00Z'),
    updatedAt: new Date('2025-06-01T10:00:00Z'),
    ...overrides,
  };
}

/**
 * Creates a mock Prisma client for testing.
 */
function createMockPrisma(docAnalysisEnabled = true) {
  const fileStore = new Map();
  const analysisStore = new Map();
  const chunkStore = new Map();
  const tableStore = new Map();

  const prisma = {
    file: {
      findFirst: async ({ where }) => {
        if (where.id && where.userId) {
          return fileStore.get(`${where.userId}:${where.id}`) || null;
        }
        if (where.id) {
          return [...fileStore.values()].find((f) => f.id === where.id) || null;
        }
        return null;
      },
      findMany: async ({ where, orderBy, take }) => {
        const files = [...fileStore.values()]
          .filter((f) => !where || f.userId === where.userId)
          .sort((a, b) => (orderBy?.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
        return take ? files.slice(0, take) : files;
      },
      update: async ({ where, data }) => {
        const file = [...fileStore.values()].find((f) => f.id === where.id);
        if (file) {
          Object.assign(file, data);
          file.updatedAt = new Date();
          return file;
        }
        return null;
      },
    },
    documentAnalysis: docAnalysisEnabled
      ? {
          findFirst: async ({ where, include }) => {
            const analysis = [...analysisStore.values()].find(
              (a) => a.userId === where.userId && a.fileId === where.fileId,
            );
            if (!analysis) return null;
            if (include?.chunks) analysis.chunks = [...chunkStore.values()].filter((c) => c.analysisId === analysis.id).sort((a, b) => a.ordinal - b.ordinal).slice(0, include.chunks.take || 10);
            if (include?.tables) analysis.tables = [...tableStore.values()].filter((t) => t.analysisId === analysis.id).sort((a, b) => a.ordinal - b.ordinal).slice(0, include.tables.take || 10);
            if (include?._count) analysis._count = { chunks: [...chunkStore.values()].filter((c) => c.analysisId === analysis.id).length, tables: [...tableStore.values()].filter((t) => t.analysisId === analysis.id).length };
            return analysis;
          },
          findUnique: async ({ where, include }) => {
            const analysis = [...analysisStore.values()].find((a) => a.fileId === where.fileId);
            if (!analysis) return null;
            if (include?.chunks) analysis.chunks = [...chunkStore.values()].filter((c) => c.analysisId === analysis.id).sort((a, b) => a.ordinal - b.ordinal).slice(0, include.chunks.take || 10);
            if (include?.tables) analysis.tables = [...tableStore.values()].filter((t) => t.analysisId === analysis.id).sort((a, b) => a.ordinal - b.ordinal).slice(0, include.tables.take || 10);
            return analysis;
          },
          upsert: async ({ where, create, update }) => {
            const existing = [...analysisStore.values()].find((a) => a.fileId === where.fileId);
            if (existing) {
              Object.assign(existing, update);
              chunkStore.clear();
              tableStore.clear();
              return existing;
            }
            const analysis = {
              id: `analysis-${Date.now()}`,
              userId: create.userId,
              fileId: create.fileId,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            analysisStore.set(analysis.id, analysis);
            return analysis;
          },
        }
      : null,
    documentChunk: docAnalysisEnabled
      ? {
          deleteMany: async ({ where }) => {
            for (const [key, chunk] of chunkStore) {
              if (chunk.analysisId === where.analysisId) chunkStore.delete(key);
            }
          },
          createMany: async ({ data }) => {
            for (const chunk of data) {
              chunkStore.set(`chunk-${chunk.ordinal}-${Date.now()}`, {
                id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                ...chunk,
              });
            }
          },
          findMany: async ({ where, orderBy, take }) => {
            const chunks = [...chunkStore.values()]
              .filter((c) => c.analysisId === where.analysisId)
              .sort((a, b) => (orderBy?.ordinal === 'asc' ? a.ordinal - b.ordinal : b.ordinal - a.ordinal));
            return take ? chunks.slice(0, take) : chunks;
          },
        }
      : null,
    documentTable: docAnalysisEnabled
      ? {
          deleteMany: async ({ where }) => {
            for (const [key, table] of tableStore) {
              if (table.analysisId === where.analysisId) tableStore.delete(key);
            }
          },
          createMany: async ({ data }) => {
            for (const table of data) {
              tableStore.set(`table-${table.ordinal}`, {
                id: `table-${Date.now()}`,
                ...table,
              });
            }
          },
          findMany: async ({ where, orderBy, take }) => {
            const tables = [...tableStore.values()]
              .filter((t) => t.analysisId === where.analysisId)
              .sort((a, b) => (orderBy?.ordinal === 'asc' ? a.ordinal - b.ordinal : b.ordinal - a.ordinal));
            return take ? tables.slice(0, take) : tables;
          },
        }
      : null,
    $transaction: async (operations) => {
      const results = [];
      for (const op of operations) results.push(await op);
      return results;
    },
    // Add a helper for tests to seed data
    __seedFile: (file) => {
      fileStore.set(`${file.userId}:${file.id}`, { ...file });
    },
    __seedAnalysis: (analysis) => {
      analysisStore.set(analysis.id, { ...analysis });
    },
    __getChunkCount: () => chunkStore.size,
    __getTableCount: () => tableStore.size,
  };

  return prisma;
}

// ── Tests ──────────────────────────────────────────────────────

describe('document-context', () => {
  describe('hasMeaningfulContent', () => {
    it('returns false for null/undefined', () => {
      assert.equal(documentContext.hasMeaningfulContent(null), false);
      assert.equal(documentContext.hasMeaningfulContent(undefined), false);
    });

    it('returns false for empty string', () => {
      assert.equal(documentContext.hasMeaningfulContent(''), false);
      assert.equal(documentContext.hasMeaningfulContent('   '), false);
    });

    it('returns false for short strings', () => {
      assert.equal(documentContext.hasMeaningfulContent('Hola mundo'), false);
    });

    it('returns false for error messages', () => {
      assert.equal(documentContext.hasMeaningfulContent('Error processing file: corrupt PDF format'), false);
      assert.equal(documentContext.hasMeaningfulContent('No text extracted from document'), false);
      assert.equal(documentContext.hasMeaningfulContent('Failed to parse the file content'), false);
      assert.equal(documentContext.hasMeaningfulContent('Could not extract any readable text'), false);
    });

    it('returns false for pure symbols / whitespace', () => {
      const noise = '!@#$%^&*()_+=-[]{}|;:,.<>?/~`'.repeat(20);
      assert.equal(documentContext.hasMeaningfulContent(noise), false);
    });

    it('returns true for meaningful Spanish text', () => {
      const text = 'El reporte financiero muestra un crecimiento del 15% en ingresos durante el ultimo trimestre. '.repeat(5);
      assert.equal(documentContext.hasMeaningfulContent(text), true);
    });

    it('returns true for meaningful English text', () => {
      const text = 'This is a meaningful document with actual content that an LLM can analyze. '.repeat(5);
      assert.equal(documentContext.hasMeaningfulContent(text), true);
    });
  });

  describe('buildAgentContextBlock', () => {
    it('returns empty block when analysis or file is null', () => {
      const result = documentContext.buildAgentContextBlock(null, { name: 'test.pdf' });
      assert.equal(result.block, '');
      assert.equal(result.charCount, 0);
      assert.equal(result.truncated, false);

      const result2 = documentContext.buildAgentContextBlock({ chunks: [] }, null);
      assert.equal(result2.block, '');
      assert.equal(result2.charCount, 0);
    });

    it('builds a context block with header and chunks', () => {
      const file = stubFile();
      const analysis = stubAnalysis();

      const result = documentContext.buildAgentContextBlock(analysis, file);

      assert.ok(result.block.length > 0);
      assert.ok(result.block.includes('reporte-financiero.pdf'));
      assert.ok(result.block.includes('Pagina 1'));
      assert.ok(result.block.includes('crecimiento'));
      assert.ok(typeof result.charCount === 'number');
      assert.equal(result.truncated, false);
    });

    it('respects maxChars limit', () => {
      const file = stubFile({
        extractedText: 'A '.repeat(5000),
      });
      const analysis = stubAnalysis({
        charCount: 10000,
        chunks: Array.from({ length: 20 }, (_, i) => ({
          ordinal: i + 1,
          sourceType: 'page',
          sourceLabel: `Page ${i + 1}`,
          text: 'B '.repeat(500),
          charCount: 1000,
        })),
      });

      const result = documentContext.buildAgentContextBlock(analysis, file, { maxChars: 500 });

      assert.ok(result.block.length <= 520); // slight overhead for formatting
      assert.equal(result.truncated, true);
    });

    it('includes tables when present', () => {
      const file = stubFile();
      const analysis = stubAnalysis({
        tables: [
          {
            ordinal: 1,
            title: 'Financial Summary',
            columns: ['Revenue', 'Growth'],
            rowCount: 3,
          },
        ],
      });

      const result = documentContext.buildAgentContextBlock(analysis, file);
      assert.ok(result.block.includes('Tables'));
      assert.ok(result.block.includes('Financial Summary'));
    });

    it('includes summary when present', () => {
      const file = stubFile();
      const analysis = stubAnalysis({ summary: 'Este es un resumen completo del documento.' });

      const result = documentContext.buildAgentContextBlock(analysis, file);
      assert.ok(result.block.includes('Este es un resumen'));
    });
  });

  describe('diagnoseFile', () => {
    it('returns error when file is not found', async () => {
      const prisma = createMockPrisma();
      const result = await documentContext.diagnoseFile(prisma, {
        userId: 'user-001',
        fileId: 'nonexistent',
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'file_not_found');
    });

    it('returns healthy status for a good file', async () => {
      const prisma = createMockPrisma();
      const file = stubFile({ processingStage: 'ready' });
      prisma.__seedFile(file);
      prisma.__seedAnalysis(stubAnalysis());

      const result = await documentContext.diagnoseFile(prisma, {
        userId: 'user-001',
        fileId: 'file-001',
      });

      assert.equal(result.ok, true);
      assert.equal(result.result.diagnostics.health, 'healthy');
      assert.equal(result.result.canRepair, false);
    });

    it('detects stuck files', async () => {
      const prisma = createMockPrisma();
      const stuckTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const file = stubFile({
        processingStage: 'extracting',
        processingStageAt: stuckTime,
        processingError: null,
      });
      prisma.__seedFile(file);

      const result = await documentContext.diagnoseFile(prisma, {
        userId: 'user-001',
        fileId: 'file-001',
      });

      assert.equal(result.ok, true);
      assert.equal(result.result.diagnostics.health, 'stuck');
      assert.equal(result.result.canRepair, true);
      assert.ok(result.result.recommendedAction);
    });

    it('detects failed files', async () => {
      const prisma = createMockPrisma();
      const file = stubFile({
        processingStage: 'failed',
        processingError: 'extraction: file corrupt',
      });
      prisma.__seedFile(file);

      const result = await documentContext.diagnoseFile(prisma, {
        userId: 'user-001',
        fileId: 'file-001',
      });

      assert.equal(result.ok, true);
      assert.equal(result.result.diagnostics.health, 'failed');
      assert.equal(result.result.canRepair, true);
    });
  });

  describe('analyzeWithRetry', () => {
    it('returns error when no prisma client', async () => {
      const result = await documentContext.analyzeWithRetry(null, { userId: 'u1', fileRecord: stubFile() });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'no_prisma');
    });

    it('returns error when no userId', async () => {
      const prisma = createMockPrisma();
      const result = await documentContext.analyzeWithRetry(prisma, { fileRecord: stubFile() });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'no_user');
    });

    it('returns error when file not found', async () => {
      const prisma = createMockPrisma();
      const result = await documentContext.analyzeWithRetry(prisma, {
        userId: 'user-001',
        fileId: 'nonexistent',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'file_not_found');
    });

    it('returns ok with analysis for a valid file', async () => {
      const prisma = createMockPrisma();
      const file = stubFile({
        processingStage: 'uploaded',
        extractedText: 'Este es un documento de prueba valido con contenido significativo. '.repeat(10),
      });
      prisma.__seedFile(file);

      const result = await documentContext.analyzeWithRetry(prisma, {
        userId: 'user-001',
        fileRecord: file,
        force: true,
      });

      assert.equal(result.ok, true);
      assert.ok(result.result);
      assert.equal(result.result.status, 'ready');
      assert.ok(result.result.chunkCount > 0);
    });
  });

  describe('batchDiagnose', () => {
    it('returns summary for empty user files', async () => {
      const prisma = createMockPrisma();
      const result = await documentContext.batchDiagnose(prisma, 'user-empty');

      assert.equal(result.ok, true);
      assert.equal(result.result.summary.total, 0);
      assert.equal(result.result.summary.healthy, 0);
    });

    it('categorizes files correctly', async () => {
      const prisma = createMockPrisma();

      // Healthy file
      prisma.__seedFile(stubFile({ id: 'f1', processingStage: 'ready', processingStageAt: new Date() }));
      // Stuck file
      prisma.__seedFile(stubFile({ id: 'f2', processingStage: 'chunking', processingStageAt: new Date(Date.now() - 10 * 60 * 1000) }));
      // Failed file
      prisma.__seedFile(stubFile({ id: 'f3', processingStage: 'failed', processingError: 'rag_indexing: timeout' }));
      // Processing file (recent, not stuck)
      prisma.__seedFile(stubFile({ id: 'f4', processingStage: 'embedding', processingStageAt: new Date() }));

      const result = await documentContext.batchDiagnose(prisma, 'user-001');

      assert.equal(result.ok, true);
      assert.equal(result.result.summary.total, 4);
      assert.equal(result.result.summary.healthy, 1);
      assert.equal(result.result.summary.failed, 1);
      assert.equal(result.result.summary.stuck, 1);
      assert.equal(result.result.summary.processing, 1);
      assert.equal(result.result.files.length, 4);
    });
  });

  describe('repairDocument', () => {
    it('returns error when file not found', async () => {
      const prisma = createMockPrisma();
      const result = await documentContext.repairDocument(prisma, null, {
        userId: 'user-001',
        fileId: 'nonexistent',
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'file_not_found');
    });

    it('can repair a stuck file with valid content', async () => {
      const prisma = createMockPrisma();
      const file = stubFile({
        processingStage: 'extracting',
        processingStageAt: new Date(Date.now() - 10 * 60 * 1000),
        extractedText: 'Contenido de prueba valido para reparacion. '.repeat(10),
        path: null, // prevent re-extraction attempt
      });
      prisma.__seedFile(file);

      const result = await documentContext.repairDocument(prisma, null, {
        userId: 'user-001',
        fileId: 'file-001',
      });

      assert.equal(result.ok, true);
      assert.ok(result.result.analysis);
      assert.equal(result.result.analysis.status, 'ready');
    });
  });

  describe('__test__.helpers', () => {
    describe('backoffDelay', () => {
      it('produces increasing delays', () => {
        const d0 = documentContext.__test__.backoffDelay(0);
        const d1 = documentContext.__test__.backoffDelay(1);
        const d2 = documentContext.__test__.backoffDelay(2);

        assert.ok(d0 >= 400 && d0 <= 1201);
        assert.ok(d1 >= 800 && d1 <= 2401);
        assert.ok(d2 >= 1600 && d2 <= 4801);
      });
    });

    describe('isTransientError', () => {
      it('identifies timeout errors as transient', () => {
        assert.equal(documentContext.__test__.isTransientError(new Error('Timeout connecting to DB')), true);
        assert.equal(documentContext.__test__.isTransientError(new Error('Connection refused')), true);
        assert.equal(documentContext.__test__.isTransientError({ message: 'rate limit exceeded', status: 429 }), true);
      });

      it('identifies non-transient errors as permanent', () => {
        assert.equal(documentContext.__test__.isTransientError(new Error('Schema mismatch')), false);
        assert.equal(documentContext.__test__.isTransientError(new Error('Not found')), false);
      });
    });

    describe('determineHealthStatus', () => {
      it('returns healthy for ready stage with analysis', () => {
        assert.equal(
          documentContext.__test__.determineHealthStatus('ready', true, true, 5),
          'healthy',
        );
      });

      it('returns failed for failed stage', () => {
        assert.equal(
          documentContext.__test__.determineHealthStatus('failed', false, false, 0),
          'failed',
        );
      });

      it('returns stuck for non-terminal old stages', () => {
        assert.equal(
          documentContext.__test__.determineHealthStatus('extracting', false, false, 0),
          'stuck',
        );
      });

      it('returns empty_extraction when ready but no text', () => {
        assert.equal(
          documentContext.__test__.determineHealthStatus('ready', false, true, 1),
          'empty_extraction',
        );
      });
    });

    describe('getRecommendedAction', () => {
      it('returns action for known statuses', () => {
        assert.ok(documentContext.__test__.getRecommendedAction('stuck').length > 0);
        assert.ok(documentContext.__test__.getRecommendedAction('failed').length > 0);
        assert.ok(documentContext.__test__.getRecommendedAction('empty_extraction').length > 0);
      });

      it('returns fallback for unknown status', () => {
        const action = documentContext.__test__.getRecommendedAction('unknown');
        assert.ok(action.includes('Estado desconocido'));
      });
    });
  });
});
