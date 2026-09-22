'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../src/services/document-editor/chat-document-editor');
const engine = require('../src/services/source-preserving-document-edit');

test('legacy document tools reuse the canonical exact editor and its ownership/version resolution', async (t) => {
  const previous = chat.runChatDocumentEdit;
  t.after(() => { chat.runChatDocumentEdit = previous; });
  const calls = [];
  const artifact = { id: 'abcdef', filename: 'Original.docx', format: 'docx', mime: 'application/docx',
    sizeBytes: 123, downloadUrl: '/api/agent/artifact/abcdef', validation: { passed: true, scope: 'exact_edit' } };
  chat.runChatDocumentEdit = async (args) => { calls.push(args); return { ok: true, summary: 'Cambio exacto.', artifacts: [artifact] }; };
  const prisma = { file: { findMany() { throw new Error('legacy file selector must not run'); } } };
  const result = await engine.tryGenerateSourcePreservingDocumentEdit({
    prisma, userId: 'owner', chatId: 'chat', fileIds: ['original'], prompt: 'Cambia "a" por "á"',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].precisionOnly, true);
  assert.equal(calls[0].userId, 'owner');
  assert.equal(calls[0].chatId, 'chat');
  assert.deepEqual(calls[0].fileIds, ['original']);
  assert.equal(result.artifact, artifact);
  assert.equal(result.validation, artifact.validation);
  assert.equal(result.file.url, artifact.downloadUrl);
});

test('precision errors and invalid proof cannot fall through to legacy selection or regeneration', async (t) => {
  const previous = chat.runChatDocumentEdit;
  t.after(() => { chat.runChatDocumentEdit = previous; });
  for (const [response, code] of [
    [{ ok: false, code: 'DOCX_EDIT_AMBIGUOUS', message: 'Varias coincidencias.' }, 'DOCX_EDIT_AMBIGUOUS'],
    [{ ok: false, code: 'NO_DOCUMENT', message: 'No hay documento.' }, 'DOCX_EDIT_UNAVAILABLE'],
    [{ ok: true, artifacts: [{ id: 'bad', validation: { passed: false } }] }, 'DOCX_EDIT_VALIDATION_FAILED'],
  ]) {
    chat.runChatDocumentEdit = async () => response;
    await assert.rejects(engine.tryGenerateSourcePreservingDocumentEdit({
      prisma: {}, userId: 'owner', prompt: 'Cambia "a" por "á"',
    }), { code });
  }
});

test('single-letter edits are classified as source edits when a document is available', () => {
  assert.equal(engine.isSourcePreservingEditRequest('Cambia "a" por "á"', ['doc-1']), true);
  assert.equal(engine.isSourcePreservingEditRequest('Explica cómo cambia "a" por "á"', ['doc-1']), false);
});
