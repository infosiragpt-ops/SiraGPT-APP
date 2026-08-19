const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAGES,
  TERMINAL_STAGES,
  isValidStage,
  setStage,
  getStatus,
} = require('../src/services/file-processing-status');

function makeMockPrisma(initialRow = null) {
  const calls = { update: [], findUnique: [] };
  let row = initialRow ? { ...initialRow } : null;
  return {
    calls,
    file: {
      update: async ({ where, data }) => {
        calls.update.push({ where, data });
        if (!row || row.id !== where.id) {
          const err = new Error('Row not found');
          err.code = 'P2025';
          throw err;
        }
        row = { ...row, ...data };
        return row;
      },
      findUnique: async ({ where, select }) => {
        calls.findUnique.push({ where, select });
        if (!row || row.id !== where.id) return null;
        return row;
      },
    },
  };
}

test('STAGES exposes the canonical pipeline order with terminal markers', () => {
  assert.deepEqual(STAGES, [
    'uploaded',
    'validating',
    'extracting',
    'chunking',
    'embedding',
    'indexing',
    'ready',
    'failed',
  ]);
  assert.equal(TERMINAL_STAGES.has('ready'), true);
  assert.equal(TERMINAL_STAGES.has('failed'), true);
  assert.equal(TERMINAL_STAGES.has('extracting'), false);
});

test('isValidStage rejects unknown labels', () => {
  assert.equal(isValidStage('embedding'), true);
  assert.equal(isValidStage('done'), false);
  assert.equal(isValidStage(''), false);
  assert.equal(isValidStage(null), false);
});

test('setStage writes the new stage and clears the error on non-failed transitions', async () => {
  const prisma = makeMockPrisma({
    id: 'f_1',
    processingStage: 'extracting',
    processingError: 'previous boom',
    processingStageAt: new Date(0),
  });

  const ok = await setStage(prisma, 'f_1', 'embedding', { userId: 'u_1' });

  assert.equal(ok, true);
  assert.equal(prisma.calls.update.length, 1);
  const { where, data } = prisma.calls.update[0];
  assert.deepEqual(where, { id: 'f_1' });
  assert.equal(data.processingStage, 'embedding');
  assert.equal(data.processingError, null, 'error should be cleared on a non-failed transition');
  assert.ok(data.processingStageAt instanceof Date);
});

test('setStage records the failure reason on failed transitions', async () => {
  const prisma = makeMockPrisma({ id: 'f_2' });

  const ok = await setStage(prisma, 'f_2', 'failed', {
    userId: 'u_2',
    error: 'rag_indexing: Qdrant unreachable',
  });

  assert.equal(ok, true);
  const { data } = prisma.calls.update[0];
  assert.equal(data.processingStage, 'failed');
  assert.equal(data.processingError, 'rag_indexing: Qdrant unreachable');
});

test('setStage truncates absurdly long failure reasons so they fit in the column', async () => {
  const prisma = makeMockPrisma({ id: 'f_3' });
  const huge = 'x'.repeat(5000);

  await setStage(prisma, 'f_3', 'failed', { error: huge });

  const { data } = prisma.calls.update[0];
  assert.equal(data.processingError.length, 1000);
});

test('setStage refuses unknown stages without crashing the pipeline', async () => {
  const prisma = makeMockPrisma({ id: 'f_4' });

  const ok = await setStage(prisma, 'f_4', 'finalizing', { userId: 'u_4' });

  assert.equal(ok, false);
  assert.equal(prisma.calls.update.length, 0);
});

test('setStage returns false when the row is missing instead of throwing', async () => {
  const prisma = makeMockPrisma(null); // no row

  const ok = await setStage(prisma, 'f_missing', 'embedding');

  assert.equal(ok, false);
});

test('getStatus returns null when the row is missing', async () => {
  const prisma = makeMockPrisma(null);
  const status = await getStatus(prisma, 'nope');
  assert.equal(status, null);
});

test('getStatus exposes the stage, error and isTerminal flag for a populated row', async () => {
  const prisma = makeMockPrisma({
    id: 'f_5',
    userId: 'u_5',
    originalName: 'contract.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 12345,
    processingStage: 'ready',
    processingError: null,
    processingStageAt: new Date('2026-04-30T05:00:00Z'),
    createdAt: new Date('2026-04-30T04:59:00Z'),
  });

  const status = await getStatus(prisma, 'f_5');

  assert.equal(status.fileId, 'f_5');
  assert.equal(status.userId, 'u_5');
  assert.equal(status.name, 'contract.docx');
  assert.equal(status.stage, 'ready');
  assert.equal(status.error, null);
  assert.equal(status.isTerminal, true);
  assert.ok(status.stageAt instanceof Date);
});

test('getStatus reports legacy rows without processingStage as "uploaded"', async () => {
  const prisma = makeMockPrisma({
    id: 'f_legacy',
    userId: 'u_legacy',
    originalName: 'old.txt',
    mimeType: 'text/plain',
    size: 1,
    processingStage: null,
    processingError: null,
    processingStageAt: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
  });

  const status = await getStatus(prisma, 'f_legacy');

  assert.equal(status.stage, 'uploaded');
  assert.equal(status.isTerminal, false);
});
