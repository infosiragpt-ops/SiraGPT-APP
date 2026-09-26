'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../src/services/document-editor/chat-document-editor');
const { tryGenerateSourcePreservingDocumentEdit } = require('../src/services/source-preserving-document-edit');

function artifact(id, filename, sourceFileId) {
  return { id, filename, format: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 20, downloadUrl: `/api/agent/artifact/${id}`, validation: { passed: true,
      documentEdit: { sourceFileId, sourceFilename: filename, parentArtifactId: `${id}00` } } };
}

function fixture(t, sources, result) {
  const calls = [];
  let legacyReads = 0;
  const llm = { client: { selected: true }, model: 'chosen-model', provider: 'chosen-provider' };
  const signal = new AbortController().signal;
  const prisma = { file: { findMany: async () => { legacyReads++; throw new Error('must not reload legacy uploads'); } } };
  t.mock.method(editor, 'resolveEditSources', async () => sources);
  t.mock.method(editor, 'runChatDocumentEdit', async (options) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result;
  });
  return { calls, get legacyReads() { return legacyReads; }, llm, signal,
    run: (overrides = {}) => tryGenerateSourcePreservingDocumentEdit({ prisma, userId: 'owner', chatId: 'chat',
      fileIds: ['upload-one', 'upload-two'], prompt: 'En ambos Word cambia el título y corrige las fechas',
      llm, signal, ...overrides }) };
}

test('both Word documents delegate to the chosen canonical editor and return every verified artifact', async (t) => {
  const artifacts = [artifact('aabb11', 'Uno.docx', 'upload-one'), artifact('aabb22', 'Dos.docx', 'upload-two')];
  const sources = artifacts.map((item) => ({ kind: 'artifact', name: item.filename, artifactId: `${item.id}00`, metadata: { validation: item.validation } }));
  const f = fixture(t, sources, { ok: true, summary: 'Ambos cambios aplicados.', artifacts });
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].llm, f.llm);
  assert.equal(f.calls[0].signal, f.signal);
  assert.equal(f.legacyReads, 0, 'never re-enter the legacy provider or original upload path');
  assert.equal(result.batch, true);
  assert.equal(result.partial, false);
  assert.equal(result.validation.passed, true);
  assert.deepEqual(result.artifacts, artifacts);
  assert.deepEqual(result.results.map((item) => item.artifact.id), ['aabb11', 'aabb22']);
  assert.deepEqual(result.files.map((file) => file.artifactId), ['aabb11', 'aabb22']);
  assert.deepEqual(result.results.map((item) => item.sourceFileId), ['upload-one', 'upload-two']);
});

test('explicit Word family scope keeps current artifact versions and excludes a reference PDF', async (t) => {
  const sources = [
    { kind: 'artifact', artifactId: 'aabb10', name: 'Uno (editado).docx' },
    { kind: 'artifact', artifactId: 'aabb20', name: 'Dos (editado).docx' },
    { kind: 'upload', name: 'Referencia.pdf', row: { id: 'reference' } },
  ];
  const f = fixture(t, sources, { ok: true, summary: 'Dos Word.', artifacts: [artifact('aabb11', 'Uno.docx', 'upload-one'), artifact('aabb22', 'Dos.docx', 'upload-two')] });
  await f.run({ fileIds: ['upload-one', 'upload-two', 'reference'] });
  assert.deepEqual(f.calls[0].fileIds, ['artifact:aabb10', 'artifact:aabb20']);
  assert.equal(f.legacyReads, 0);
});

test('a partial canonical save retains recoverable files without reporting total success', async (t) => {
  const saved = artifact('aabb11', 'Uno.docx', 'upload-one');
  const f = fixture(t, [{ kind: 'upload', name: 'Uno.docx', row: { id: 'upload-one' } }], {
    ok: false, code: 'DOCUMENT_EDIT_INCOMPLETE', partial: true, artifacts: [saved], message: 'Solo pude guardar uno de los dos archivos.',
  });
  const result = await f.run();
  assert.equal(result.partial, true);
  assert.equal(result.validation.passed, false);
  assert.equal(result.code, 'DOCUMENT_EDIT_INCOMPLETE');
  assert.deepEqual(result.artifacts, [saved]);
  assert.match(result.content, /uno de los dos/);
  assert.equal(result.failures.length, 1);
});

test('an invalid canonical sibling is not silently filtered into success', async (t) => {
  const bad = artifact('aabb22', 'Dos.docx', 'upload-two'); bad.validation.passed = false;
  const f = fixture(t, [{ name: 'Uno.docx' }], { ok: true, artifacts: [artifact('aabb11', 'Uno.docx', 'upload-one'), bad] });
  await assert.rejects(f.run(), { code: 'DOCX_EDIT_VALIDATION_FAILED' });
  assert.equal(f.legacyReads, 0);
});

test('the chosen provider error propagates without entering the legacy provider path', async (t) => {
  const failure = Object.assign(new Error('selected provider unavailable'), { code: 'E_PROVIDER' });
  const f = fixture(t, [{ name: 'Uno.docx' }, { name: 'Dos.docx' }], failure);
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(f.calls.length, 1);
  assert.equal(f.legacyReads, 0);
});
