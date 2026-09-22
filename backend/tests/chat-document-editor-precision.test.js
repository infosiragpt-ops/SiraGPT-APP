'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChatDocumentEdit, toAssistantFiles } = require('../src/services/document-editor/chat-document-editor');

const USER = 'precision-owner';
const EDIT = { needle: 'a', replacement: 'á' };

function fixture(t, { rows, messages = [], parse, apply } = {}) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-docx-precision-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const uploads = rows || [{ id: 'upload-1', userId: USER, originalName: 'Original.docx', path: '/original.docx' }];
  const calls = { saved: [], applied: [], loaded: [], generic: 0, model: 0, queries: [] };
  const prisma = {
    file: { findMany: async ({ where }) => uploads.filter((row) => where.id.in.includes(row.id) && row.userId === where.userId) },
    message: { findMany: async (query) => { calls.queries.push(query); return messages; } },
  };
  const deps = {
    env: {}, artifactDir,
    extractFileIds: (files) => (Array.isArray(files) ? files : []).map((file) => file.id).filter(Boolean),
    readSourceBuffer: async (row) => { calls.loaded.push(row.id); return { buffer: Buffer.from(`original:${row.id}`), cleanup: async () => {} }; },
    parseDocxPrecisionRequest: parse || (() => ({ edit: EDIT })),
    applyDocxPrecisionEdit: async (buffer, edit) => {
      calls.applied.push({ buffer: Buffer.from(buffer), edit });
      if (apply) return apply(buffer, edit);
      return { buffer: Buffer.from('edited-output'), changedCount: 1, validation: { passed: true, untouchedPartsVerified: true } };
    },
    saveArtifact: (input) => {
      calls.saved.push(input);
      return { id: 'aabbcc', filename: input.filename, format: path.extname(input.filename).slice(1), mime: input.mime,
        sizeBytes: Buffer.from(input.base64, 'base64').length, downloadUrl: '/api/agent/artifact/aabbcc' };
    },
    tryDeterministicEdit: async () => { calls.generic += 1; return null; },
    isReformateoRequest: () => false,
    resolveDocAgentCandidates: () => [],
    createFailoverClient: () => ({}),
    runDocumentAgent: async () => {
      calls.model += 1;
      return { finalText: 'Edición general.', outputs: [{ name: 'general.xlsx', valid: true, buffer: Buffer.from('general-output') }] };
    },
    log: () => {},
  };
  const run = (overrides = {}) => runChatDocumentEdit({
    prisma, userId: USER, chatId: 'owned-chat', fileIds: ['upload-1'], instruction: 'Cambia "a" por "á"',
    deps, ...overrides,
  });
  return { calls, deps, run, artifactDir };
}

test('literal Word edits patch the original bytes and preserve filename and verification metadata', async (t) => {
  const { calls, run } = fixture(t);
  const result = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.applied, [{ buffer: Buffer.from('original:upload-1'), edit: EDIT }]);
  assert.equal(calls.generic, 0);
  assert.equal(calls.model, 0);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].filename, 'Original.docx');
  assert.equal(calls.saved[0].ownerUserId, USER);
  assert.equal(calls.saved[0].chatId, 'owned-chat');
  assert.equal(Buffer.from(calls.saved[0].base64, 'base64').toString(), 'edited-output');
  assert.equal(toAssistantFiles(result.artifacts)[0].validation.passed, true);
  assert.match(result.summary, /1 cambio\(s\) exacto\(s\)/);
});

test('a precise follow-up patches the latest owned artifact, not the original upload', async (t) => {
  const { calls, run, artifactDir } = fixture(t, { messages: [
    { role: 'ASSISTANT', files: [{ artifactId: 'bbccdd', filename: 'Original.docx' }] },
    { role: 'USER', files: [{ id: 'upload-1', filename: 'Original.docx' }] },
  ] });
  fs.writeFileSync(path.join(artifactDir, 'bbccdd.json'), JSON.stringify({
    filename: 'Original.docx', ownerUserId: USER, storedRelPath: 'latest.docx',
  }));
  fs.writeFileSync(path.join(artifactDir, 'latest.docx'), 'latest-delivered-version');
  const result = await run({ fileIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.loaded, []);
  assert.equal(calls.applied[0].buffer.toString(), 'latest-delivered-version');
  assert.equal(calls.queries.length, 1, 'no second source lookup may select a different version');
  assert.deepEqual(calls.queries[0].where, { chatId: 'owned-chat', deletedAt: null, chat: { userId: USER } });
});

test('precision source selection never reads a foreign upload or artifact', async (t) => {
  const { calls, run, artifactDir } = fixture(t, {
    rows: [{ id: 'foreign', userId: 'other', originalName: 'Foreign.docx' }],
    messages: [{ role: 'ASSISTANT', files: [{ artifactId: 'bbccdd', filename: 'Foreign.docx' }] }],
  });
  fs.writeFileSync(path.join(artifactDir, 'bbccdd.json'), JSON.stringify({ filename: 'Foreign.docx', ownerUserId: 'other', storedRelPath: 'foreign.docx' }));
  fs.writeFileSync(path.join(artifactDir, 'foreign.docx'), 'private');
  for (const fileIds of [['foreign'], []]) {
    const result = await run({ fileIds });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_DOCUMENT');
  }
  assert.deepEqual(calls.loaded, []);
  assert.deepEqual(calls.applied, []);
  assert.deepEqual(calls.saved, []);
});

test('several documents require a unique literal filename before reading or editing any source', async (t) => {
  const { calls, run, deps } = fixture(t, { rows: [
    { id: 'upload-1', userId: USER, originalName: 'Original.docx' },
    { id: 'upload-2', userId: USER, originalName: 'Informe final.docx' },
  ] });
  const ambiguous = await run({ fileIds: ['upload-1', 'upload-2'] });
  assert.equal(ambiguous.code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.deepEqual(calls.loaded, []);
  deps.parseDocxPrecisionRequest = require('../src/services/document-editing/docx-precision-intent').parseDocxPrecisionRequest;
  const selected = await run({ fileIds: ['upload-1', 'upload-2'], instruction: 'En "Informe final.docx" cambia "a" por "á"' });
  assert.equal(selected.ok, true);
  assert.deepEqual(calls.loaded, ['upload-2']);
  assert.equal(calls.saved[0].filename, 'Informe final.docx');
});

test('a malformed precise instruction fails before any blob, model, or output is touched', async (t) => {
  const { calls, run } = fixture(t, { parse: () => ({ error: { code: 'DOCX_EDIT_INSTRUCTION_REQUIRED', message: 'Indica los textos exactos entre comillas.' } }) });
  const result = await run();
  assert.equal(result.code, 'DOCX_EDIT_INSTRUCTION_REQUIRED');
  assert.deepEqual(calls.loaded, []);
  assert.equal(calls.model, 0);
  assert.equal(calls.generic, 0);
  assert.deepEqual(calls.saved, []);
});

test('a parsed filename cannot silently select a different latest document', async (t) => {
  const missing = fixture(t, { parse: () => ({ edit: EDIT, sourceFilename: 'Otro.docx' }) });
  assert.equal((await missing.run()).code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.deepEqual(missing.calls.loaded, []);
  const named = fixture(t, { parse: () => ({ edit: EDIT, sourceFilename: 'original.DOCX' }) });
  assert.equal((await named.run()).ok, true);
  assert.equal(named.calls.applied.length, 1);
  const literal = fixture(t, { parse: () => ({ edit: { needle: 'Otro.docx', replacement: 'Nuevo.docx' } }) });
  assert.equal((await literal.run()).ok, true, 'a literal filename in document text is not a source selector');
});

test('a follow-up over two historical uploads is ambiguous until a filename selects one', async (t) => {
  const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');
  const { calls, run } = fixture(t, {
    parse: parseDocxPrecisionRequest,
    rows: [
      { id: 'upload-1', userId: USER, originalName: 'Primero.docx' },
      { id: 'upload-2', userId: USER, originalName: 'Segundo.docx' },
    ],
    messages: [{ role: 'USER', files: [{ id: 'upload-1' }, { id: 'upload-2' }] }],
  });
  assert.equal((await run({ fileIds: [] })).code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.deepEqual(calls.loaded, []);
  assert.deepEqual(calls.saved, []);
  const selected = await run({ fileIds: [], instruction: 'En "Segundo.docx" cambia "a" por "á"' });
  assert.equal(selected.ok, true, selected.message);
  assert.deepEqual(calls.loaded, ['upload-2']);
  assert.equal(calls.saved[0].filename, 'Segundo.docx');
  assert.equal(calls.model, 0);
});

test('a follow-up over two delivered artifacts retains both owned candidates and edits only the named one', async (t) => {
  const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');
  const { calls, run, artifactDir } = fixture(t, {
    parse: parseDocxPrecisionRequest,
    messages: [{ role: 'ASSISTANT', files: [
      { artifactId: 'aabb11', filename: 'Primero.docx' },
      { artifactId: 'aabb22', filename: 'Segundo.docx' },
      { artifactId: 'aabb22', filename: 'Segundo.docx' },
      { artifactId: 'aabb33', filename: 'Ajeno.docx' },
    ] }],
  });
  for (const [id, filename, owner] of [['aabb11', 'Primero.docx', USER], ['aabb22', 'Segundo.docx', USER], ['aabb33', 'Ajeno.docx', 'other']]) {
    fs.writeFileSync(path.join(artifactDir, `${id}.json`), JSON.stringify({ filename, ownerUserId: owner, storedRelPath: `${id}.docx` }));
    fs.writeFileSync(path.join(artifactDir, `${id}.docx`), `delivered:${id}`);
  }
  assert.equal((await run({ fileIds: [] })).code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.deepEqual(calls.applied, []);
  assert.deepEqual(calls.saved, []);
  const selected = await run({ fileIds: [], instruction: 'En "Segundo.docx" cambia "a" por "á"' });
  assert.equal(selected.ok, true, selected.message);
  assert.equal(calls.applied[0].buffer.toString(), 'delivered:aabb22');
  assert.equal(calls.saved[0].filename, 'Segundo.docx');
  assert.deepEqual(calls.loaded, [], 'no historical upload should be read');
  assert.equal(calls.model, 0);
});

test('the sixth explicit precision candidate is not truncated by the generic five-file limit', async (t) => {
  const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');
  const rows = Array.from({ length: 6 }, (_, index) => ({ id: `upload-${index + 1}`, userId: USER, originalName: `Documento${index + 1}.docx` }));
  const { calls, run } = fixture(t, { rows, parse: parseDocxPrecisionRequest });
  const fileIds = rows.map((row) => row.id);
  assert.equal((await run({ fileIds })).code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
  assert.deepEqual(calls.loaded, []);
  const selected = await run({ fileIds, instruction: 'En Documento6.docx cambia "a" por "á"' });
  assert.equal(selected.ok, true, selected.message);
  assert.deepEqual(calls.loaded, ['upload-6']);
  assert.equal(calls.saved[0].filename, 'Documento6.docx');
});

test('nonprecision edits keep the existing first-history-document and five-upload selection', async (t) => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ id: `upload-${index + 1}`, userId: USER, originalName: `Documento${index + 1}.docx` }));
  const historical = fixture(t, { rows, parse: () => null, messages: [{ role: 'USER', files: rows }] });
  assert.equal((await historical.run({ fileIds: [], instruction: 'Mejora el contenido' })).ok, true);
  assert.deepEqual(historical.calls.loaded, ['upload-1']);
  const explicit = fixture(t, { rows, parse: () => null });
  assert.equal((await explicit.run({ fileIds: rows.map((row) => row.id), instruction: 'Mejora el contenido' })).ok, true);
  assert.deepEqual(explicit.calls.loaded, rows.slice(0, 5).map((row) => row.id));
});

test('strict .doc edits cannot convert or regenerate an original as .docx', async (t) => {
  const { calls, run } = fixture(t, { rows: [{ id: 'upload-1', userId: USER, originalName: 'Antiguo.doc' }] });
  const result = await run();
  assert.equal(result.code, 'DOCX_EDIT_UNSUPPORTED');
  assert.equal(calls.model, 0);
  assert.deepEqual(calls.loaded, []);
  assert.deepEqual(calls.saved, []);
});

test('ambiguity, not-found, unsupported and invalid-package errors all fail closed', async (t) => {
  for (const code of ['DOCX_EDIT_AMBIGUOUS', 'DOCX_EDIT_NOT_FOUND', 'DOCX_EDIT_UNSUPPORTED', 'DOCX_EDIT_INVALID']) {
    const { calls, run } = fixture(t, { apply: () => { throw Object.assign(new Error('Precisa el fragmento; el original no se modificó.'), { code }); } });
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(calls.generic, 0);
    assert.equal(calls.model, 0);
    assert.deepEqual(calls.saved, []);
  }
});

test('an unknown precision failure cannot regenerate or expose internal errors', async (t) => {
  const { calls, run } = fixture(t, { apply: () => { throw new Error('/internal/path failed'); } });
  const result = await run();
  assert.equal(result.code, 'DOCX_EDIT_FAILED');
  assert.doesNotMatch(result.message, /internal\/path/);
  assert.equal(calls.model, 0);
  assert.deepEqual(calls.saved, []);
});

test('strict output must carry passed=true before saving or sending a file', async (t) => {
  for (const validation of [undefined, { passed: false }, { passed: 'true' }]) {
    const { calls, run } = fixture(t, { apply: () => ({ buffer: Buffer.from('candidate'), changedCount: 1, validation }) });
    const result = await run();
    assert.equal(result.code, 'DOCX_EDIT_VALIDATION_FAILED');
    assert.deepEqual(calls.saved, []);
    assert.equal(calls.model, 0);
  }
});

test('Stop aborts a completed patch before it can be published as an artifact', async (t) => {
  const controller = new AbortController();
  const { calls, run } = fixture(t, { apply: () => {
    controller.abort(new Error('stopped'));
    return { buffer: Buffer.from('candidate'), changedCount: 1, validation: { passed: true } };
  } });
  await assert.rejects(run({ signal: controller.signal }), /stopped/);
  assert.deepEqual(calls.saved, []);
});

test('quoted replacements in non-Word files still use their existing format-specific engines', async (t) => {
  for (const name of ['Datos.xlsx', 'Slides.pptx', 'Notas.txt']) {
    const { calls, run } = fixture(t, {
      rows: [{ id: 'upload-1', userId: USER, originalName: name }],
      parse: () => { throw new Error('Word parser must not handle this file'); },
    });
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(calls.applied.length, 0);
    assert.equal(calls.generic, 1);
    assert.equal(calls.model, 1);
  }
});

test('an explicitly named spreadsheet is not hijacked by a Word attached as reference', async (t) => {
  const { calls, run } = fixture(t, {
    rows: [
      { id: 'upload-1', userId: USER, originalName: 'Original.docx' },
      { id: 'upload-2', userId: USER, originalName: 'Datos.xlsx' },
    ],
    parse: () => ({ edit: EDIT, sourceFilename: 'Datos.xlsx' }),
  });
  const result = await run({ fileIds: ['upload-1', 'upload-2'], instruction: 'En Datos.xlsx cambia "a" por "á"' });
  assert.equal(result.ok, true);
  assert.equal(calls.applied.length, 0);
  assert.equal(calls.generic, 1);
});

test('precision errors raised by the generic bridge cannot fall through to the model either', async (t) => {
  const { calls, run, deps } = fixture(t, { parse: () => null });
  deps.tryDeterministicEdit = async () => { throw Object.assign(new Error('Indica una sola coincidencia.'), { code: 'DOCX_EDIT_AMBIGUOUS' }); };
  const result = await run();
  assert.equal(result.code, 'DOCX_EDIT_AMBIGUOUS');
  assert.equal(calls.model, 0);
  assert.deepEqual(calls.saved, []);
});

test('precisionOnly declines generic and non-Word edits without invoking the generic editor or model', async (t) => {
  const cases = [
    { rows: [{ id: 'upload-1', userId: USER, originalName: 'Original.docx' }], parse: () => null },
    { rows: [{ id: 'upload-1', userId: USER, originalName: 'Datos.xlsx' }] },
    { rows: [], parse: () => null },
  ];
  for (const input of cases) {
    const { calls, run } = fixture(t, input);
    const result = await run({ precisionOnly: true });
    assert.equal(result, null);
    assert.equal(calls.generic, 0);
    assert.equal(calls.model, 0);
    assert.deepEqual(calls.loaded, []);
    assert.deepEqual(calls.saved, []);
  }
});

test('precisionOnly returns a validated artifact or an honest missing-source error, never a fallback', async (t) => {
  const valid = fixture(t);
  assert.equal((await valid.run({ precisionOnly: true })).artifacts[0].validation.passed, true);
  assert.equal(valid.calls.generic, 0);
  const missing = fixture(t, { rows: [{ id: 'upload-1', userId: 'other', originalName: 'Foreign.docx' }] });
  assert.equal((await missing.run({ precisionOnly: true })).code, 'NO_DOCUMENT');
  assert.equal(missing.calls.generic, 0);
  assert.deepEqual(missing.calls.applied, []);
});

test('real parser and OOXML adapter edit one letter and continue from the delivered Word without regeneration', async (t) => {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const PizZip = require('pizzip');
  const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');
  const { applyDocxPrecisionEdit } = require('../src/services/document-editing/docx-precision-edit');
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text: 'MI', bold: true }), new TextRun({ text: 'C', italics: true }), new TextRun({ text: 'RO', underline: {} })] }),
    new Paragraph('Este párrafo permanece intacto.'),
  ] }] }));
  const untouchedSource = Buffer.from(source);
  const latestMessage = { role: 'ASSISTANT', files: [{ artifactId: 'bbccdd', filename: 'Original.docx' }] };
  const { deps, calls, run, artifactDir } = fixture(t, {
    messages: [latestMessage], parse: parseDocxPrecisionRequest, apply: applyDocxPrecisionEdit,
  });
  deps.readSourceBuffer = async () => ({ buffer: source, cleanup: async () => {} });
  const first = await run({ instruction: 'Cambia "MICRO" por "MIXRO"' });
  assert.equal(first.ok, true, first.message);
  const firstBytes = Buffer.from(calls.saved[0].base64, 'base64');
  fs.writeFileSync(path.join(artifactDir, 'bbccdd.json'), JSON.stringify({
    filename: 'Original.docx', ownerUserId: USER, storedRelPath: 'latest.docx',
  }));
  fs.writeFileSync(path.join(artifactDir, 'latest.docx'), firstBytes);
  const next = await run({ fileIds: [], instruction: 'Ahora cambia "MIXRO" por "MIYRO"' });
  assert.equal(next.ok, true, next.message);
  assert.equal(calls.generic, 0);
  assert.equal(calls.model, 0);
  assert.equal(calls.saved.length, 2);
  const originalZip = new PizZip(source);
  const resultZip = new PizZip(Buffer.from(calls.saved[1].base64, 'base64'));
  for (const name of Object.keys(originalZip.files)) {
    if (originalZip.files[name].dir) continue;
    const original = originalZip.file(name).asNodeBuffer();
    const result = resultZip.file(name).asNodeBuffer();
    if (name === 'word/document.xml') assert.equal(result.toString(), original.toString().replace(/>C<\/w:t>/, '>Y</w:t>'));
    else assert.deepEqual(result, original, `${name} must remain byte-identical`);
  }
  assert.deepEqual(source, untouchedSource, 'the original upload must remain immutable');
  assert.equal(next.artifacts[0].validation.passed, true);
});
