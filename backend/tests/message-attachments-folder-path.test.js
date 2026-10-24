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
