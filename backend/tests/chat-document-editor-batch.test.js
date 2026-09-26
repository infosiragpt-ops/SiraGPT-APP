'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChatDocumentEdit, resolveEditSources, toAssistantFiles } = require('../src/services/document-editor/chat-document-editor');

function fixture(t, names = ['Ventas.xlsx', 'Informe.pptx']) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-batch-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const rows = names.map((originalName, i) => ({ id: `file-${i}`, userId: 'owner', originalName }));
  const messages = [];
  const calls = { saved: [], edits: [], reads: [] };
  const prisma = {
    file: { findMany: async ({ where }) => rows.filter((row) => row.userId === where.userId && where.id.in.includes(row.id)) },
    message: { findMany: async () => messages },
  };
  const addArtifact = (id, filename, bytes, validation = {}, ownerUserId = 'owner') => {
    const metadata = { id, filename, ownerUserId, chatId: 'chat', storedRelPath: `${id}.bin`, validation };
    fs.writeFileSync(path.join(artifactDir, `${id}.json`), JSON.stringify(metadata));
    fs.writeFileSync(path.join(artifactDir, `${id}.bin`), bytes);
    return { artifactId: id, filename };
  };
  const deps = {
    env: {}, artifactDir, log: () => {},
    extractFileIds: (files) => (files || []).map((f) => f.id).filter(Boolean),
    readSourceBuffer: async (row) => { calls.reads.push(row.id); return { buffer: Buffer.from(`original:${row.id}`), cleanup: async () => {} }; },
    parseDocxPrecisionRequest: () => null, parseDocxImageRequest: () => null,
    isReformateoRequest: () => false, tryDeterministicEdit: async () => null,
    docxEngine: { docxEngineEnabled: () => false },
    runDocumentAgent: async (options) => {
      calls.edits.push(options);
      return { stoppedReason: 'final', finalText: 'Cambios completos.', outputs: options.files.map((file) => ({
        name: file.name, valid: true, buffer: Buffer.concat([file.buffer, Buffer.from('|edit')]),
      })) };
    },
    saveArtifact: (input) => {
      calls.saved.push(input);
      const id = (0xaabb00 + calls.saved.length).toString(16);
      addArtifact(id, input.filename, Buffer.from(input.base64, 'base64'), input.validation);
      return { id, filename: input.filename, format: path.extname(input.filename).slice(1), mime: input.mime,
        sizeBytes: Buffer.from(input.base64, 'base64').length, downloadUrl: `/api/agent/artifact/${id}` };
    },
  };
  const run = (options = {}) => runChatDocumentEdit({ prisma, userId: 'owner', chatId: 'chat', fileIds: rows.map((row) => row.id),
    instruction: 'En ambos documentos cambia 2025 por 2026 y revisa los títulos.', llm: { client: {}, model: 'picked' }, deps, ...options });
  return { run, rows, messages, calls, deps, prisma, addArtifact };
}

test('multiple originals and later edits retain each latest version and the selected model', async (t) => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.ok, true, first.message);
  assert.equal(f.calls.edits.length, 2, 'each output must have its own unambiguous baseline');
  assert.ok(f.calls.edits.every((edit) => edit.files.length === 1 && edit.model === 'picked'));
  assert.ok(f.calls.edits.every((edit) => edit.route === 'sandbox'), 'a global alternate-route setting cannot replace the picked client');
  f.messages.unshift({ role: 'ASSISTANT', files: toAssistantFiles(first.artifacts) });
  for (const fileIds of [undefined, []]) {
    const next = await f.run(fileIds ? { fileIds } : {});
    assert.equal(next.ok, true, next.message);
    assert.deepEqual(f.calls.edits.slice(-2).map((edit) => edit.files[0].buffer.toString()), ['original:file-0|edit', 'original:file-1|edit']);
    assert.deepEqual(f.calls.saved.slice(-2).map((item) => item.validation.documentEdit.sourceFileId), ['file-0', 'file-1']);
    assert.ok(f.calls.saved.slice(-2).every((item) => item.validation.documentEdit.parentArtifactId));
  }
});

test('explicit artifact identity wins over history and checks ownership', async (t) => {
  const f = fixture(t, ['Base.xlsx']);
  f.addArtifact('aabbcc', 'Base (editado).xlsx', 'chosen-v2');
  f.addArtifact('ddeeff', 'Base (editado v3).xlsx', 'newer-v3');
  f.addArtifact('ffeeaa', 'Foreign.xlsx', 'private', {}, 'other');
  f.messages.push({ role: 'ASSISTANT', files: [{ artifactId: 'ddeeff' }] });
  const chosen = await f.run({ fileIds: ['artifact:AABBCC'] });
  assert.equal(chosen.ok, true, chosen.message);
  assert.equal(f.calls.edits[0].files[0].buffer.toString(), 'chosen-v2');
  for (const fileIds of [['artifact:ffeeaa'], ['file-0', 'artifact:ffeeaa']]) {
    assert.equal((await f.run({ fileIds })).ok, false, 'an unavailable requested source must not be silently omitted');
  }
  assert.equal(f.calls.edits.length, 1);
});

test('lineage disambiguates originals with identical filenames', async (t) => {
  const f = fixture(t, ['Datos.xlsx', 'Datos.xlsx']);
  const one = f.addArtifact('aabb11', 'Datos (editado).xlsx', 'first-v2', { documentEdit: { sourceFileId: 'file-0', sourceFilename: 'Datos.xlsx' } });
  const two = f.addArtifact('aabb22', 'Datos (editado).xlsx', 'second-v2', { documentEdit: { sourceFileId: 'file-1', sourceFilename: 'Datos.xlsx' } });
  f.messages.push({ role: 'ASSISTANT', files: [two, one] });
  const sources = await resolveEditSources({ prisma: f.prisma, userId: 'owner', chatId: 'chat', fileIds: ['file-0', 'file-1'], deps: f.deps });
  assert.deepEqual(sources.map((source) => source.artifactId), ['aabb11', 'aabb22']);
});

test('six requested sources fail visibly without reading or silently editing only five', async (t) => {
  const f = fixture(t, Array.from({ length: 6 }, (_, i) => `Datos${i}.xlsx`));
  const result = await f.run({ instruction: 'En todos los documentos cambia 2025 por 2026' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_MANY_DOCUMENTS');
  assert.equal(f.calls.reads.length, 0);
  assert.equal(f.calls.edits.length, 0);
});

test('missing or corrupt second output prevents publishing a partially completed batch', async (t) => {
  for (const second of [[], [{ name: 'Informe.pptx', valid: false, buffer: Buffer.from('corrupt') }]]) {
    const f = fixture(t);
    f.deps.runDocumentAgent = async (options) => {
      f.calls.edits.push(options);
      return { finalText: 'Listo todo.', outputs: f.calls.edits.length === 1
        ? [{ name: 'Ventas.xlsx', valid: true, buffer: Buffer.from('edited') }] : second };
    };
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DOCUMENT_EDIT_INCOMPLETE');
    assert.deepEqual(f.calls.saved, []);
    assert.doesNotMatch(result.message, /Listo todo/);
  }
});

test('a valid file beside an invalid sibling is not reported as total success', async (t) => {
  const f = fixture(t, ['Datos.xlsx']);
  f.deps.runDocumentAgent = async () => ({ outputs: [
    { name: 'Datos.xlsx', valid: true, buffer: Buffer.from('edited') },
    { name: 'other.xlsx', valid: false, buffer: Buffer.from('bad') },
  ] });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.calls.saved.length, 0);
});

test('a storage failure reports partial delivery honestly and returns already saved files', async (t) => {
  const f = fixture(t);
  const save = f.deps.saveArtifact;
  f.deps.saveArtifact = (input) => {
    if (f.calls.saved.length === 1) throw new Error('storage unavailable');
    return save(input);
  };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCUMENT_EDIT_INCOMPLETE');
  assert.equal(result.partial, true);
  assert.equal(result.artifacts.length, 1);
  assert.doesNotMatch(result.message, /Listo|storage unavailable/);
});

test('a single-file edit followed by another batch keeps the latest version of each member', async (t) => {
  const f = fixture(t);
  const initial = await f.run();
  f.messages.unshift({ role: 'ASSISTANT', files: toAssistantFiles(initial.artifacts) });
  const one = await f.run({ fileIds: [], instruction: 'En Ventas.xlsx agrega una explicación de los datos.' });
  assert.equal(one.ok, true, one.message);
  f.messages.unshift({ role: 'ASSISTANT', files: toAssistantFiles(one.artifacts) });
  const all = await f.run({ fileIds: [], instruction: 'En ambos documentos mejora los títulos.' });
  assert.equal(all.ok, true, all.message);
  assert.deepEqual(f.calls.edits.slice(-2).map((edit) => edit.files[0].buffer.toString()), ['original:file-0|edit|edit', 'original:file-1|edit']);
});

test('a filename selects its current derived version and avoids editing the other source', async (t) => {
  const f = fixture(t);
  const initial = await f.run();
  f.messages.unshift({ role: 'ASSISTANT', files: toAssistantFiles(initial.artifacts) });
  const next = await f.run({ instruction: 'En Ventas.xlsx agrega una explicación de los datos.' });
  assert.equal(next.ok, true, next.message);
  assert.equal(next.artifacts.length, 1);
  assert.equal(f.calls.edits.length, 3);
  assert.equal(f.calls.edits[2].files[0].buffer.toString(), 'original:file-0|edit');
});

test('compound Word edits reach the selected engine intact and follow-ups retain both verified changes', async (t) => {
  const { Document, Packer, Paragraph } = require('docx');
  const PizZip = require('pizzip');
  const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');
  const { applyDocxPrecisionEdit } = require('../src/services/document-editing/docx-precision-edit');
  const f = fixture(t, ['Carta.docx', 'Informe.docx']);
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('2025 Norte'), new Paragraph('Texto que se conserva.')] }] }));
  const engineCalls = [];
  f.deps.readSourceBuffer = async () => ({ buffer: source, cleanup: async () => {} });
  f.deps.parseDocxPrecisionRequest = parseDocxPrecisionRequest;
  f.deps.applyDocxPrecisionEdit = () => { assert.fail('the single-operation shortcut must not execute part of the compound request'); };
  f.deps.docxEngine = {
    docxEngineEnabled: () => true,
    editWordDocument: async (options) => {
      engineCalls.push(options);
      let buffer = options.buffer;
      const replacements = options.instruction.includes('2026') ? [['2025', '2026'], ['Norte', 'Sur']] : [['Sur', 'Centro'], ['Texto', 'Contenido']];
      for (const [needle, replacement] of replacements) buffer = (await applyDocxPrecisionEdit(buffer, { needle, replacement })).buffer;
      return { ok: true, filename: options.filename, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer, verification: { ok: true }, changes: replacements.map(([needle, replacement]) => ({ op: 'replace_text', needle, replacement })), summary: 'Apliqué ambos reemplazos.' };
    },
  };
  const first = await f.run({ instruction: 'En ambos documentos cambia "2025" por "2026" y cambia "Norte" por "Sur".' });
  assert.equal(first.ok, true, first.message);
  assert.equal(engineCalls.length, 2);
  assert.ok(engineCalls.every((call) => call.model === 'picked' && /2025[\s\S]*Norte/.test(call.instruction)));
  f.messages.unshift({ role: 'ASSISTANT', files: toAssistantFiles(first.artifacts) });
  const next = await f.run({ fileIds: [], instruction: 'En ambos documentos cambia "Sur" por "Centro" y cambia "Texto" por "Contenido".' });
  assert.equal(next.ok, true, next.message);
  for (const saved of f.calls.saved.slice(-2)) {
    const zip = new PizZip(Buffer.from(saved.base64, 'base64'));
    const xml = zip.file('word/document.xml').asText();
    assert.match(xml, /2026 Centro/);
    assert.match(xml, /Contenido que se conserva/);
    const before = new PizZip(source);
    for (const name of Object.keys(before.files)) {
      if (before.files[name].dir || name === 'word/document.xml') continue;
      assert.deepEqual(zip.file(name).asNodeBuffer(), before.file(name).asNodeBuffer(), `${name} remains intact`);
    }
  }
});

test('one exact replacement applies to both Word files without calling a content model', async (t) => {
  const { Document, Packer, Paragraph } = require('docx');
  const PizZip = require('pizzip');
  const f = fixture(t, ['Carta.docx', 'Informe.docx']);
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('2026 Norte')] }] }));
  f.deps.readSourceBuffer = async () => ({ buffer: source, cleanup: async () => {} });
  f.deps.parseDocxPrecisionRequest = require('../src/services/document-editing/docx-precision-intent').parseDocxPrecisionRequest;
  f.deps.applyDocxPrecisionEdit = require('../src/services/document-editing/docx-precision-edit').applyDocxPrecisionEdit;
  f.deps.docxEngine = { docxEngineEnabled: () => true, editWordDocument: async () => assert.fail('literal batch must not call a content model') };
  const result = await f.run({ instruction: 'En ambos Word cambia "2026" por "2027". Solo modifica ello.' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.artifacts.length, 2);
  assert.deepEqual(f.calls.saved.map((item) => item.validation.documentEdit.sourceFileId), ['file-0', 'file-1']);
  for (const item of f.calls.saved) assert.match(new PizZip(Buffer.from(item.base64, 'base64')).file('word/document.xml').asText(), /2027 Norte/);
});

test('a literal title change in both Word files preserves body text and does not require a model', async (t) => {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const PizZip = require('pizzip');
  const f = fixture(t, ['Carta.docx', 'Informe.docx']);
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ style: 'Title', children: [new TextRun({ text: 'Informe 2026', bold: true })] }),
    new Paragraph('Cuerpo 2026 intacto'),
  ] }] }));
  f.deps.readSourceBuffer = async () => ({ buffer: source, cleanup: async () => {} });
  f.deps.parseDocxPrecisionRequest = require('../src/services/document-editing/docx-precision-intent').parseDocxPrecisionRequest;
  f.deps.docxEngine = { docxEngineEnabled: () => true, editWordDocument: async () => assert.fail('literal titles must not call a content model') };
  const result = await f.run({ instruction: 'en ambos Word cambia en el título de 2026 al 2027 en mi mismo Word. Solo modifica ello.' });
  assert.equal(result.ok, true, result.message);
  assert.equal(f.calls.saved.length, 2);
  for (const item of f.calls.saved) {
    const zip = new PizZip(Buffer.from(item.base64, 'base64'));
    const xml = zip.file('word/document.xml').asText();
    assert.match(xml, /Informe 2027/);
    assert.match(xml, /Cuerpo 2026 intacto/);
    assert.doesNotMatch(xml, /en mi mismo word|solo modifica ello/i);
    assert.match(xml, /<w:b\/>/);
    assert.equal(item.validation.passed, true);
  }
  assert.match(new PizZip(source).file('word/document.xml').asText(), /Informe 2026/);
});

test('the title shortcut declines a second action or an unsupported condition as a whole', async () => {
  const { tryApplyLiteralDocxTitleEdit } = require('../src/services/source-preserving-document-edit').INTERNAL;
  for (const requestText of [
    'cambia en el título de 2026 al 2027 y traduce el cuerpo',
    'cambia en el título de 2026 al 2027 solo si el total es mayor que 20',
    'cambia en el título de 2026 al 2027. Conserva el formato pero borra la tabla',
  ]) assert.equal(await tryApplyLiteralDocxTitleEdit({ input: Buffer.alloc(0), requestText }), null);
});

test('a quoted batch word never selects all sources', async (t) => {
  const f = fixture(t, ['A.docx', 'B.docx']);
  f.deps.parseDocxPrecisionRequest = require('../src/services/document-editing/docx-precision-intent').parseDocxPrecisionRequest;
  const result = await f.run({ instruction: 'Cambia "Norte" por "ambos".' });
  assert.equal(result.code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.equal(f.calls.edits.length, 0);
});

test('a loop stopped at its iteration limit cannot publish an intermediate document', async (t) => {
  const f = fixture(t, ['Datos.xlsx']);
  f.deps.runDocumentAgent = async () => ({ stoppedReason: 'max_iterations', outputs: [{ name: 'Datos.xlsx', valid: true, buffer: Buffer.from('partial') }] });
  assert.equal((await f.run()).code, 'DOCUMENT_EDIT_INCOMPLETE');
  assert.deepEqual(f.calls.saved, []);
});

test('stopping a prepared batch prevents publication of every member', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const edit = f.deps.runDocumentAgent;
  f.deps.runDocumentAgent = async (options) => {
    const result = await edit(options);
    controller.abort(new Error('stopped'));
    return result;
  };
  await assert.rejects(f.run({ signal: controller.signal }), /stopped/);
  assert.equal(f.calls.edits.length, 1);
  assert.deepEqual(f.calls.saved, []);
});

test('a single ambiguous filename and filenames inside replacement values cannot select a source', async (t) => {
  for (const [names, instruction] of [
    [['Datos.xlsx', 'Datos.xlsx'], 'En Datos.xlsx cambia los títulos.'],
    [['A.docx', 'B.docx'], 'Cambia "B.docx" por "C.docx" y cambia "Norte" por "Sur".'],
  ]) {
    const f = fixture(t, names);
    f.deps.parseDocxPrecisionRequest = require('../src/services/document-editing/docx-precision-intent').parseDocxPrecisionRequest;
    const result = await f.run({ instruction });
    assert.equal(result.ok, false);
    assert.match(result.code, /SOURCE_AMBIGUOUS/);
    assert.equal(f.calls.edits.length, 0);
  }
});
