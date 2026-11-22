const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hydrateChatMessageAttachments, normalizeClientMetadata, serializeMessageAttachments } = require('../src/services/message-attachments');

test('folder attachment paths survive the durable message snapshot without replacing stored filenames', async () => {
  const rows = [
    { id: 'a', userId: 'user', originalName: 'informe.txt', filename: 'a-informe.txt', mimeType: 'text/plain', size: 9 },
    { id: 'b', userId: 'user', originalName: 'informe.txt', filename: 'b-informe.txt', mimeType: 'text/plain', size: 9 },
  ];
  const clientMetadata = [
    { id: 'a', relativePath: 'Documentos/Legal/informe.txt' },
    { id: 'b', relativePath: 'Documentos/Finanzas/informe.txt' },
  ];
  const snapshot = await serializeMessageAttachments({ file: { findMany: async () => rows } }, {
    userId: 'user', fileIds: ['a', 'b'], clientMetadata,
  });
  assert.deepEqual(snapshot.map(file => file.relativePath), clientMetadata.map(file => file.relativePath));
  assert.deepEqual(snapshot.map(file => file.filename), ['a-informe.txt', 'b-informe.txt']);
  assert.deepEqual(normalizeClientMetadata(JSON.parse(JSON.stringify(snapshot)), ['a', 'b']).map(file => file.relativePath),
    clientMetadata.map(file => file.relativePath));
  const refreshed = await hydrateChatMessageAttachments({ file: { findMany: async () => rows } }, {
    userId: 'user', messages: [{ id: 'message', role: 'USER', files: JSON.stringify(clientMetadata) }],
  });
  assert.deepEqual(refreshed[0].files.map(file => file.relativePath), clientMetadata.map(file => file.relativePath));
});

test('folder metadata rejects unsafe paths and unrequested file IDs', () => {
  for (const relativePath of ['/Users/private/file', '../file', 'Root/../file', 'C:/private/file',
    'Root\\file', 'Root//file', 'Root/\nfile', 'Root/./file', 'x'.repeat(1025)]) {
    const normalized = normalizeClientMetadata([{ id: 'a', relativePath }], ['a']);
    assert.equal(normalized[0].relativePath, undefined);
  }
  assert.deepEqual(normalizeClientMetadata([{ id: 'other', relativePath: 'Root/file' }], ['a']), []);
});

test('complete folder workspace: buildUploadedFileContext emits full folder tree + fields and sanitizeUploadRelativePath stages duplicate basenames across subfolders without collision', async () => {
  const { buildUploadedFileContext } = require('../src/services/message-attachments');
  const { sanitizeUploadRelativePath } = require('../src/services/agent-runner/artifacts');

  assert.equal(sanitizeUploadRelativePath('Proyecto/Legal/informe.docx', 'informe.docx', 0), 'Proyecto/Legal/informe.docx');
  assert.equal(sanitizeUploadRelativePath('Proyecto/Finanzas/informe.docx', 'informe.docx', 1), 'Proyecto/Finanzas/informe.docx');
  assert.equal(sanitizeUploadRelativePath('../etc/passwd', 'informe.docx', 0), 'informe.docx');

  const rows = [
    {
      id: 'f1',
      userId: 'u1',
      originalName: 'informe.txt',
      mimeType: 'text/plain',
      extractedText: 'Cláusula contractual vigente con penalidad del 5% trimestral y vigencia anual.',
      documentAnalysis: { id: 'a1', chunks: [], tables: [] },
    },
    {
      id: 'f2',
      userId: 'u1',
      originalName: 'informe.txt',
      mimeType: 'text/plain',
      extractedText: 'Flujo de caja neto proyectado en USD 240,000 con margen operativo de 28%.',
      documentAnalysis: {
        id: 'a2',
        chunks: [],
        tables: [{ ordinal: 1, title: 'Flujo', rowCount: 12, columns: ['Mes', 'Ingresos', 'Egresos', 'Margen'] }],
      },
    },
    {
      id: 'f3',
      userId: 'u1',
      originalName: 'organigrama.png',
      mimeType: 'image/png',
      extractedText: '',
      documentAnalysis: null,
    },
  ];
  const mockPrisma = {
    file: {
      findMany: async () => rows,
      findFirst: async ({ where }) => rows.find((r) => r.id === where.id) || null,
    },
  };
  const fileMetadata = [
    { id: 'f1', relativePath: 'CarpetaProyecto/Legal/informe.txt' },
    { id: 'f2', relativePath: 'CarpetaProyecto/Finanzas/informe.txt' },
    { id: 'f3', relativePath: 'CarpetaProyecto/Anexos/organigrama.png' },
  ];

  const context = await buildUploadedFileContext(mockPrisma, {
    userId: 'u1',
    fileIds: ['f1', 'f2', 'f3'],
    fileMetadata,
    query: 'analiza la carpeta completa y todos sus campos',
    imageTextWaitMs: 0,
  });

  assert.match(context, /Estructura completa de la carpeta adjunta \(3 archivos/);
  assert.match(context, /CarpetaProyecto\/Anexos\/organigrama\.png \[image\/png\]/, 'even non-text assets appear in the folder inventory');
  assert.match(context, /CarpetaProyecto\/Finanzas\/informe\.txt \[text\/plain\] \| campos\/columnas: Mes, Ingresos, Egresos, Margen/);
  assert.match(context, /### Archivo adjunto 1: CarpetaProyecto\/Finanzas\/informe\.txt/);
  assert.match(context, /### Archivo adjunto 2: CarpetaProyecto\/Legal\/informe\.txt/);
  assert.match(context, /USD 240,000/);
  assert.match(context, /penalidad del 5%/);
});
