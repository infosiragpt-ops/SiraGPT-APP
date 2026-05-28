const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_SIMULTANEOUS_DOCUMENTS,
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

test('document batch limit defaults to exactly 300 simultaneous documents', () => {
  assert.equal(MAX_SIMULTANEOUS_DOCUMENTS, 300);
});

test('document pipeline accepts and plans across 300 reference documents', () => {
  const plan = buildPlan({
    prompt: 'lee y compara todos los documentos adjuntos',
    format: 'docx',
    referenceFiles: makeReferenceFiles(MAX_SIMULTANEOUS_DOCUMENTS),
  });

  assert.equal(plan.referenceFiles.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(plan.referenceBriefs.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(plan.referenceFiles[0].name, 'documento-001.pdf');
  assert.equal(plan.referenceFiles[299].name, 'documento-300.pdf');
});

test('agent task snapshots preserve 300 file ids for long multi-document reads', () => {
  const fileIds = Array.from({ length: 350 }, (_, index) => `file-${index + 1}`);
  const out = taskStore.sanitizeTaskRecord({
    taskId: 'task-300-docs',
    userId: 'user-1',
    fileIds,
  });

  assert.equal(out.fileIds.length, MAX_SIMULTANEOUS_DOCUMENTS);
  assert.equal(out.fileIds[0], 'file-1');
  assert.equal(out.fileIds[299], 'file-300');
});

test('uploaded file context includes all 300 document attachments within a bounded prompt budget', async () => {
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
    query: 'lee los 300 documentos y dame una síntesis comparativa',
    maxChars: 120000,
  });

  assert.match(context, /Archivo adjunto 1: documento-001\.pdf/);
  assert.match(context, /Archivo adjunto 300: documento-300\.pdf/);
  assert.ok(context.length <= 130000, `context too large: ${context.length}`);
});

test('plain transcription context can stitch 300 document texts instead of stopping at 8', async () => {
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
  assert.match(text, /### documento-300\.pdf/);
});

test('bulk document endpoints and queues no longer enforce old 5/20/50-document caps', () => {
  const filesRoute = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
  const docRoute = fs.readFileSync(path.join(__dirname, '../src/routes/doc.js'), 'utf8');
  const agentTaskRoute = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  const agentBatchRoute = fs.readFileSync(path.join(__dirname, '../src/routes/agent-batch.js'), 'utf8');
  const messageAttachments = fs.readFileSync(path.join(__dirname, '../src/services/message-attachments.js'), 'utf8');
  const workspaceOrchestrator = fs.readFileSync(path.join(__dirname, '../src/services/agents/workspace-workflow-orchestrator.js'), 'utf8');
  const sourcePreservingEdit = fs.readFileSync(path.join(__dirname, '../src/services/source-preserving-document-edit.js'), 'utf8');
  const projectPage = fs.readFileSync(path.join(__dirname, '../../app/projects/[id]/page.tsx'), 'utf8');

  assert.match(filesRoute, /upload\.array\('files',\s*MAX_SIMULTANEOUS_DOCUMENTS\)/);
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
  assert.doesNotMatch(sourcePreservingEdit, /slice\(0,\s*10\)/);

  assert.doesNotMatch(projectPage, /slice\(0,\s*10\)/);
});
