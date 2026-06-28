const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DOCUMENT_FAMILY_LIMITS,
  MAX_SIMULTANEOUS_DOCUMENTS,
  validateDocumentBatch,
} = require('../src/config/document-batch-limits');
const { buildPlan } = require('../src/services/document-pipeline/advanced-document-pipeline');
const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
} = require('../src/services/message-attachments');
const taskStore = require('../src/services/agents/task-store');

function makeReferenceFiles(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${String(index + 1).padStart(3, '0')}`,
    originalName: `documento-${String(index + 1).padStart(3, '0')}.pdf`,
    mimeType: 'application/pdf',
    size: 2048 + index,
    extractedText: `Documento ${index + 1}: evidencia resumida para lectura simultánea y comparación multi-documento.`,
  }));
}

function fakePrismaForFiles(rows) {
  return {
    file: {
      findMany: async ({ where }) => {
        const wanted = new Set((where?.id?.in || []).map(String));
        return rows.filter((row) => wanted.has(row.id));
      },
    },
  };
}

test('document batch limit defaults to exactly 400 simultaneous documents', () => {
  assert.equal(MAX_SIMULTANEOUS_DOCUMENTS, 400);
  assert.equal(DOCUMENT_FAMILY_LIMITS.pdf, 100);
  assert.equal(DOCUMENT_FAMILY_LIMITS.word, 100);
  assert.equal(DOCUMENT_FAMILY_LIMITS.presentation, 100);
  assert.equal(DOCUMENT_FAMILY_LIMITS.spreadsheet, 100);
});

test('document batch policy accepts 100 PDFs + 100 Word + 100 PowerPoint + 100 Excel files', () => {
  const files = [
    ...Array.from({ length: 100 }, (_, i) => ({ originalname: `pdf-${i}.pdf`, mimetype: 'application/pdf' })),
    ...Array.from({ length: 100 }, (_, i) => ({ originalname: `word-${i}.docx`, mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })),
    ...Array.from({ length: 100 }, (_, i) => ({ originalname: `deck-${i}.pptx`, mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })),
    ...Array.from({ length: 100 }, (_, i) => ({ originalname: `sheet-${i}.xlsx`, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
  ];

  const result = validateDocumentBatch(files);
  assert.equal(result.ok, true);
  assert.equal(result.total, 400);
  assert.deepEqual(result.counts, {
    pdf: 100,
    word: 100,
    presentation: 100,
    spreadsheet: 100,
    other: 0,
  });
});

test('document batch policy rejects more than 100 files in a document family', () => {
  const files = Array.from({ length: 101 }, (_, i) => ({ originalname: `pdf-${i}.pdf`, mimetype: 'application/pdf' }));
  const result = validateDocumentBatch(files);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pdf_document_batch_too_large');
});

test('document batch policy rejects more than 400 files in one turn', () => {
  const files = Array.from({ length: 401 }, (_, i) => ({ originalname: `image-${i}.png`, mimetype: 'image/png' }));
  const result = validateDocumentBatch(files);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'document_batch_too_large');
});

test('document pipeline accepts and plans across 400 reference documents', () => {
  const plan = buildPlan({
    prompt: 'lee y compara todos los documentos adjuntos',
    format: 'docx',
    referenceFiles: makeReferenceFiles(MAX_SIMULTANEOUS_DOCUMENTS),
  });

  assert.equal(plan.referenceFiles.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(plan.referenceBriefs.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(plan.referenceFiles[0].name, 'documento-001.pdf');
  assert.equal(plan.referenceFiles[399].name, 'documento-400.pdf');
});

test('agent task snapshots preserve 400 file ids for long multi-document reads', () => {
  const fileIds = Array.from({ length: 450 }, (_, index) => `file-${index + 1}`);
  const out = taskStore.sanitizeTaskRecord({
    taskId: 'task-400-docs',
    userId: 'user-1',
    fileIds,
  });

  assert.equal(out.fileIds.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(out.fileIds[0], 'file-1');
  assert.equal(out.fileIds[399], 'file-400');
});

test('uploaded file context includes all 400 document attachments within a bounded prompt budget', async () => {
  const rows = makeReferenceFiles(MAX_SIMULTANEOUS_DOCUMENTS).map((file) => ({
    ...file,
    filename: file.originalName,
    originalName: file.originalName,
    openaiFileId: null,
    documentAnalysis: null,
  }));
  const fileIds = rows.map((row) => row.id);
  const context = await buildUploadedFileContext(fakePrismaForFiles(rows), {
    userId: 'user-1',
    fileIds,
    query: 'lee los 400 documentos y dame una síntesis comparativa',
    maxChars: 120000,
  });

  assert.match(context, /Archivo adjunto 1: documento-001\.pdf/);
  assert.match(context, /Archivo adjunto 400: documento-400\.pdf/);
  assert.ok(context.length <= 130000, `context too large: ${context.length}`);
});

test('plain transcription context can stitch 400 document texts instead of stopping at 8', async () => {
  const rows = makeReferenceFiles(MAX_SIMULTANEOUS_DOCUMENTS).map((file) => ({
    ...file,
    filename: file.originalName,
    originalName: file.originalName,
    documentAnalysis: null,
  }));
  const text = await buildTranscriptionTextFromFiles(fakePrismaForFiles(rows), {
    userId: 'user-1',
    fileIds: rows.map((row) => row.id),
    maxChars: 120000,
  });

  assert.match(text, /### documento-001\.pdf/);
  assert.match(text, /### documento-400\.pdf/);
});

test('bulk document endpoints and queues no longer enforce old 5/20/50-document caps', () => {
  const filesRoute = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
  const docRoute = fs.readFileSync(path.join(__dirname, '../src/routes/doc.js'), 'utf8');
  const agentTaskRoute = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  const agentBatchRoute = fs.readFileSync(path.join(__dirname, '../src/routes/agent-batch.js'), 'utf8');
  const messageAttachments = fs.readFileSync(path.join(__dirname, '../src/services/message-attachments.js'), 'utf8');
  const workspaceOrchestrator = fs.readFileSync(path.join(__dirname, '../src/services/agents/workspace-workflow-orchestrator.js'), 'utf8');
  const projectPage = fs.readFileSync(path.join(__dirname, '../../app/projects/[id]/page.tsx'), 'utf8');

  assert.match(filesRoute, /upload\.array\('files',\s*UPLOAD_BATCH_MAX\)/);
  assert.match(filesRoute, /validateDocumentBatch\(req\.files\)/);
  assert.match(filesRoute, /scheduleCrossDocumentAnalysisWhenReady[\s\S]*MAX_SIMULTANEOUS_DOCUMENTS/);
  assert.doesNotMatch(filesRoute, /upload\.array\('files',\s*50\)/);
  assert.doesNotMatch(filesRoute, /slice\(0,\s*50\)/);

  assert.match(docRoute, /isArray\(\{ max:\s*MAX_SIMULTANEOUS_DOCUMENTS \}\)/);
  assert.doesNotMatch(docRoute, /isArray\(\{ max:\s*5 \}\)/);
  assert.doesNotMatch(docRoute, /slice\(0,\s*5\)/);
  assert.doesNotMatch(docRoute, /slice\(0,\s*12\)/);

  assert.doesNotMatch(agentTaskRoute, /slice\(0,\s*20\)/);
  assert.doesNotMatch(agentTaskRoute, /body\('files'\)\.optional\(\)\.isArray\(\{ max:\s*20 \}\)/);
  assert.match(agentTaskRoute, /body\('files'\)\.optional\(\)\.isArray\(\{ max:\s*MAX_SIMULTANEOUS_DOCUMENTS \}\)/);
  assert.doesNotMatch(agentBatchRoute, /body\('tasks\.\*\.files'\)\.optional\(\)\.isArray\(\{ max:\s*20 \}\)/);
  assert.match(agentBatchRoute, /body\('tasks\.\*\.files'\)\.optional\(\)\.isArray\(\{ max:\s*MAX_SIMULTANEOUS_DOCUMENTS \}\)/);

  assert.match(messageAttachments, /MAX_SIMULTANEOUS_DOCUMENTS/);
  assert.doesNotMatch(messageAttachments, /slice\(0,\s*(?:8|20)\)/);
  assert.doesNotMatch(workspaceOrchestrator, /slice\(0,\s*20\)/);

  assert.doesNotMatch(projectPage, /slice\(0,\s*10\)/);
});
