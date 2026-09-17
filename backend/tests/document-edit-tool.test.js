'use strict';

/**
 * document_edit harness tool — offline unit tests.
 *
 * Covers: ownership scoping, attachment confinement (model-named IDs outside
 * the turn are rejected), the runDocumentAgent contract, artifact persistence
 * + file_artifact event, empty-output skipping, error paths (never throws),
 * the per-turn call budget, registration gating in buildHarnessTools, and the
 * shouldUseAgenticChat edit-routing gate.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the artifact store BEFORE task-tools is (transitively) required.
const ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-edit-artifacts-'));
process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;

const {
  buildDocumentEditTool,
  MAX_CALLS_PER_TURN,
  MAX_FILE_BYTES,
  MAX_TOTAL_FILE_BYTES,
  _documentEditBulkhead,
  _reservedRowBytes,
} = require('../src/services/agent-harness/tools/document-edit-tool');
const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');

// The tool now tries the in-process source-preserving editor BEFORE the
// sandbox doc-agent. These sandbox-path tests stub it to "not applicable"
// (returns null → fall through) so they stay hermetic and keep asserting the
// sandbox behaviour. The two dedicated tests at the bottom exercise the
// in-process fast path directly.
const SP_NULL = { tryGenerateSourcePreservingDocumentEdit: async () => null };

function tmpFileWith(content) {
  const p = path.join(os.tmpdir(), `doc-edit-in-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
  fs.writeFileSync(p, content);
  return p;
}

function fakePrisma(rows, capture = {}) {
  return {
    file: {
      findMany: async (q) => {
        capture.where = q.where;
        const ids = q.where.id.in;
        return rows.filter((r) => ids.includes(r.id) && r.userId === q.where.userId);
      },
    },
  };
}

function baseCtx(overrides = {}) {
  return {
    userId: 'u1',
    chatId: 'c1',
    fileIds: ['f1'],
    signal: new AbortController().signal,
    onEvent: () => {},
    ...overrides,
  };
}

test('aggregate byte guard rejects oversized batches before any editor or blob read', async () => {
  let sourceEditorCalls = 0;
  let blobReads = 0;
  let sandboxCalls = 0;
  const before = _documentEditBulkhead.snapshot();
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{
      id: 'f1', userId: 'u1', size: MAX_TOTAL_FILE_BYTES + 1,
      path: '/must/not/read.docx', originalName: 'grande.docx', filename: 'grande.docx',
    }]),
    fsImpl: { readFile: async () => { blobReads += 1; return Buffer.from('x'); } },
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => { sourceEditorCalls += 1; return null; },
    },
    runDocumentAgent: async () => { sandboxCalls += 1; return { outputs: [] }; },
  });

  const out = await tool.execute({ instruction: 'edita el documento completo' }, baseCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'total_files_too_large');
  assert.equal(out.code, 'DOCUMENT_EDIT_TOTAL_BYTES_EXCEEDED');
  assert.equal(sourceEditorCalls, 0);
  assert.equal(blobReads, 0);
  assert.equal(sandboxCalls, 0);
  const after = _documentEditBulkhead.snapshot();
  assert.equal(after.inFlight, before.inFlight);
  assert.equal(after.tokensInFlight, before.tokensInFlight);
});

test('measured storage bytes reject a stale legacy size before the source-preserving editor reads it', async () => {
  let sourceEditorCalls = 0;
  let blobReads = 0;
  let sandboxCalls = 0;
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{
      id: 'f1', userId: 'u1', size: 1024,
      path: '/legacy/oversized.docx', originalName: 'oversized.docx', filename: 'oversized.docx',
    }]),
    statSource: async () => ({ size: MAX_FILE_BYTES + 1 }),
    fsImpl: { readFile: async () => { blobReads += 1; return Buffer.alloc(MAX_FILE_BYTES + 1); } },
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => { sourceEditorCalls += 1; return null; },
    },
    runDocumentAgent: async () => { sandboxCalls += 1; return { outputs: [] }; },
  });

  const out = await tool.execute({ instruction: 'edita este documento' }, baseCtx());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'file_too_large');
  assert.equal(out.code, 'DOCUMENT_EDIT_FILE_BYTES_EXCEEDED');
  assert.equal(sourceEditorCalls, 0);
  assert.equal(blobReads, 0);
  assert.equal(sandboxCalls, 0);
});

test('legacy rows reserve the per-file maximum and release global admission on every return path', async () => {
  assert.equal(
    _reservedRowBytes([{}, {}, {}]),
    Math.min(MAX_TOTAL_FILE_BYTES, 3 * MAX_FILE_BYTES),
    'unknown legacy sizes must be reserved conservatively',
  );

  const p = tmpFileWith('x');
  const before = _documentEditBulkhead.snapshot();
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p, originalName: 'a.docx', filename: 'a.docx' }]),
    sourcePreservingEdit: SP_NULL,
    runDocumentAgent: async () => ({ outputs: [], finalText: 'sin salida' }),
  });
  const out = await tool.execute({ instruction: 'edita este documento' }, baseCtx());
  assert.equal(out.error, 'no_output');
  const after = _documentEditBulkhead.snapshot();
  assert.equal(after.inFlight, before.inFlight);
  assert.equal(after.tokensInFlight, before.tokensInFlight);
  fs.rmSync(p, { force: true });
});

test('happy path: ownership-scoped lookup, agent gets bytes, artifact card emitted', async () => {
  const inputPath = tmpFileWith('original-bytes');
  const capture = {};
  const events = [];
  let agentArgs = null;

  const tool = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: inputPath, originalName: 'informe.docx', filename: 'x.docx' }], capture),
    runDocumentAgent: async (opts) => {
      agentArgs = opts;
      return {
        outputs: [{ name: 'informe-editado.docx', buffer: Buffer.from('edited-bytes'), valid: true }],
        finalText: 'Cambié el título.',
        iterations: 3,
        stoppedReason: 'final',
        driver: 'local',
      };
    },
  });

  const out = await tool.execute(
    { instruction: 'cambia el título a Informe Final' },
    baseCtx({ onEvent: (e) => events.push(e) }),
  );

  assert.equal(out.ok, true);
  assert.equal(capture.where.userId, 'u1', 'lookup MUST be ownership-scoped');
  assert.equal(agentArgs.instruction, 'cambia el título a Informe Final');
  assert.equal(agentArgs.files[0].name, 'informe.docx');
  assert.equal(agentArgs.files[0].buffer.toString(), 'original-bytes');

  assert.equal(out.edited.length, 1);
  assert.match(out.edited[0].downloadUrl, /^\/api\/agent\/artifact\//);
  const fa = events.find((e) => e.type === 'file_artifact');
  assert.ok(fa, 'file_artifact event must be emitted for the chat card');
  assert.equal(fa.artifact.filename, 'informe-editado.docx');
  assert.match(fa.artifact.downloadUrl, /^\/api\/agent\/artifact\//);

  // The artifact bytes really exist in the store.
  const onDisk = fs.readdirSync(ARTIFACT_DIR).filter((n) => n.includes('informe-editado'));
  assert.ok(onDisk.length >= 1, 'artifact file persisted on disk');
  fs.rmSync(inputPath, { force: true });
});

test('model-named IDs outside the turn fall back to the REAL attachments (never touch foreign files)', async () => {
  const fs2 = require('fs');
  const os2 = require('os');
  const path2 = require('path');
  const real = path2.join(os2.tmpdir(), `de-real-${Date.now()}.docx`);
  fs2.writeFileSync(real, 'real-bytes');
  const capture = {};
  let agentFiles = null;
  const tool = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', path: real, originalName: 'real.docx', filename: 'real.docx' },
      { id: 'foreign', userId: 'u1', path: '/nope', originalName: 'x.docx', filename: 'x' },
    ], capture),
    runDocumentAgent: async (opts) => {
      agentFiles = opts.files;
      return { outputs: [{ name: 'e.docx', buffer: Buffer.from('y'), valid: true }], iterations: 1, driver: 'local', finalText: 'ok' };
    },
  });
  // The model invents an ID ("foreign" is NOT attached) → resolve to the
  // turn's real attachment instead of failing.
  const out = await tool.execute(
    { instruction: 'edita esto por favor', fileIds: ['foreign'] },
    baseCtx({ fileIds: ['f1'] }),
  );
  assert.equal(out.ok, true);
  assert.deepEqual(capture.where.id.in, ['f1'], 'lookup must target ONLY the turn attachments');
  assert.equal(agentFiles[0].name, 'real.docx');
  fs2.rmSync(real, { force: true });

  // With NO attachments at all the tool still refuses.
  const out2 = await tool.execute({ instruction: 'edita esto por favor' }, baseCtx({ fileIds: [] }));
  assert.deepEqual([out2.ok, out2.error], [false, 'no_attached_files']);
});

test('error paths return ok:false without throwing', async () => {
  // file_blob_missing
  const t1 = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', size: 128, path: '/does/not/exist', originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [] }),
  });
  const r1 = await t1.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([r1.ok, r1.error], [false, 'file_blob_missing']);

  // file_not_found (row owned by another user)
  const t2 = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'OTHER', path: '/x', originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [] }),
  });
  const r2 = await t2.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([r2.ok, r2.error], [false, 'file_not_found']);

  // doc_agent_failed (e.g. OPENROUTER_API_KEY missing in dev)
  const p3 = tmpFileWith('x');
  const t3 = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p3, originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => { throw new Error('OPENROUTER_API_KEY is not configured'); },
  });
  const r3 = await t3.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([r3.ok, r3.error], [false, 'doc_agent_failed']);
  assert.match(r3.message, /OPENROUTER/);
  fs.rmSync(p3, { force: true });
});

test('empty outputs are skipped; all-empty → no_output', async () => {
  const p = tmpFileWith('x');
  const tool = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p, originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [{ name: 'broken.docx', buffer: Buffer.alloc(0), valid: false }], finalText: 'meh' }),
  });
  const out = await tool.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([out.ok, out.error], [false, 'no_output']);
  fs.rmSync(p, { force: true });
});

test('sandbox rejects a non-empty invalid output before persistence or card emission', async () => {
  const p = tmpFileWith('original-stays-intact');
  const events = [];
  let saveCalls = 0;
  const tool = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p, originalName: 'a.docx', filename: 'a.docx' }]),
    runDocumentAgent: async () => ({
      outputs: [{ name: 'a-editado.docx', buffer: Buffer.from('non-empty-but-invalid'), valid: false }],
      finalText: 'Supuestamente editado.',
      iterations: 2,
      driver: 'local',
    }),
    saveArtifact: () => {
      saveCalls += 1;
      throw new Error('invalid output must never reach persistence');
    },
  });

  const out = await tool.execute(
    { instruction: 'edita el documento y devuélveme el Word' },
    baseCtx({ onEvent: (event) => events.push(event) }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.error, 'document_validation_failed');
  assert.equal(out.code, 'DOCUMENT_VALIDATION_FAILED');
  assert.deepEqual(out.edited, []);
  assert.deepEqual(out.failures, [{
    filename: 'a-editado.docx',
    error: 'validation_failed',
    reason: 'ooxml_structure',
  }]);
  assert.equal(saveCalls, 0, 'invalid output must be rejected before saveArtifact');
  assert.equal(events.some((event) => event.type === 'file_artifact'), false, 'invalid output must not emit a chat card');
  assert.equal(JSON.stringify(out).includes('/api/agent/artifact/'), false, 'invalid output must not expose a download URL');
  fs.rmSync(p, { force: true });
});

test('per-turn call budget: the 4th call on the SAME ctx is refused', async () => {
  const p = tmpFileWith('x');
  const tool = buildDocumentEditTool({
    sourcePreservingEdit: SP_NULL,
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p, originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [{ name: 'e.docx', buffer: Buffer.from('y'), valid: true }], iterations: 1, driver: 'local', finalText: 'ok' }),
  });
  const ctx = baseCtx();
  for (let i = 0; i < MAX_CALLS_PER_TURN; i += 1) {
    const r = await tool.execute({ instruction: 'edita el documento otra vez' }, ctx);
    assert.equal(r.ok, true, `call ${i + 1} should pass`);
  }
  const blocked = await tool.execute({ instruction: 'edita el documento otra vez' }, ctx);
  assert.deepEqual([blocked.ok, blocked.error], [false, 'call_budget_exhausted']);
  fs.rmSync(p, { force: true });
});

test('registration gating: document_edit appears ONLY when the turn has attachments', () => {
  const withFiles = buildHarnessTools(new Set(), { hasAttachments: true });
  assert.ok(withFiles.some((d) => d.name === 'document_edit'));

  const without = buildHarnessTools(new Set(), { hasAttachments: false });
  assert.ok(!without.some((d) => d.name === 'document_edit'));

  // A pre-existing same-named tool wins (no duplicate registration).
  const preExisting = buildHarnessTools(new Set(['document_edit']), { hasAttachments: true });
  assert.ok(!preExisting.some((d) => d.name === 'document_edit'));
});

test('routing gate: edit requests with attachments enter the agentic loop; doc-QA does not', () => {
  const { isDocumentEditRequest } = require('../src/services/agents/agentic-trigger');
  // positives — incl. DELETION/insertion verbs with NO document noun (the exact
  // prod failure: "borra el jurado evaluador" stalled because it routed nowhere)
  assert.equal(isDocumentEditRequest('borra el jurado evaluador'), true);
  assert.equal(isDocumentEditRequest('elimina la sección de anexos'), true);
  assert.equal(isDocumentEditRequest('quita la tabla de matrices'), true);
  assert.equal(isDocumentEditRequest('agrega una conclusión al final'), true);
  assert.equal(isDocumentEditRequest('suprime el párrafo 3'), true);
  assert.equal(isDocumentEditRequest('edita mi documento y corrige la tabla'), true);
  assert.equal(isDocumentEditRequest('modifica el excel adjunto'), true);
  assert.equal(isDocumentEditRequest('actualiza el informe con los datos nuevos'), true);
  assert.equal(isDocumentEditRequest('corrige la ortografía del archivo'), true);
  assert.equal(isDocumentEditRequest('aplica correcciones minimas al documento porfavor'), true);
  assert.equal(isDocumentEditRequest('uniformisa el color de la ppts todas de color blanco'), true);
  assert.equal(isDocumentEditRequest('pon todas las diapositivas de color rosado'), true);
  // negatives — plain Q&A / summaries stay fast
  assert.equal(isDocumentEditRequest('resume este documento'), false);
  assert.equal(isDocumentEditRequest('¿qué dice el documento?'), false);
  assert.equal(isDocumentEditRequest('explícame el informe'), false);
  assert.equal(isDocumentEditRequest('de qué trata'), false);

  // The queued-path deterministic gate must ALSO fire on strong mutation verbs
  // with an attachment (belt-and-suspenders if a turn still routes there).
  const { isSourcePreservingEditRequest } = require('../src/services/source-preserving-document-edit');
  const docx = [{ name: 'x.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
  assert.equal(isSourcePreservingEditRequest('borra el jurado evaluador', docx), true);
  assert.equal(isSourcePreservingEditRequest('agrega una conclusión', docx), true);
  assert.equal(isSourcePreservingEditRequest('aplica correcciones minimas al documento porfavor', docx), true);
  const pptx = [{ name: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }];
  assert.equal(isSourcePreservingEditRequest('uniformisa el color de la ppts todas de color blanco', pptx), true);
  assert.equal(isSourcePreservingEditRequest('agrega una ppt de gracias', pptx), true);
  assert.equal(isSourcePreservingEditRequest('edita estos documentos y devuélvemelos en el mismo formato', docx), true);
  assert.equal(isSourcePreservingEditRequest('¿qué dice el documento?', docx), false);
  assert.equal(isSourcePreservingEditRequest('resume esto', docx), false);

  const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
  assert.equal(shouldUseAgenticChat({ prompt: 'edita mi documento: cambia el título', files: [{ id: 'f1' }] }), true);
  assert.equal(shouldUseAgenticChat({ prompt: 'aplica correcciones minimas al documento porfavor', files: [{ id: 'f1' }] }), true);
  assert.equal(shouldUseAgenticChat({ prompt: '¿de qué trata el documento?', files: [{ id: 'f1' }] }), false);
});

test('intent triage: a specific edit request WITH attachment must not stall on clarification', () => {
  const { buildSemanticIntentAnalysis } = require('../src/services/agents/semantic-intent-router');
  const prompt = 'Edita mi documento: cambia el título a "Informe Final 2026" y agrega conclusiones. Devuélveme el .docx editado.';
  const withFile = buildSemanticIntentAnalysis({ rawUserRequest: prompt, files: [{ id: 'f1', name: 'informe.docx' }] });
  assert.equal(withFile.needs_clarification, false, 'mentioning "documento" with a file ATTACHED is a reference, not ambiguity');
  assert.ok(withFile.contract.ambiguity_score < 0.8);

  // The vague-request guard must survive: no attachment + no format = ask.
  const noFile = buildSemanticIntentAnalysis({ rawUserRequest: 'haz algo con un documento', files: [] });
  assert.equal(noFile.needs_clarification, true);
});

test('in-process fast path: source-preserving edit returns the card WITHOUT touching the sandbox', async () => {
  const inputPath = tmpFileWith('original-bytes');
  const events = [];
  let sandboxCalled = false;
  let spArgs = null;

  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: inputPath, originalName: 'informe.docx', filename: 'x.docx' }]),
    // The in-process editor self-persists and returns its artifact descriptor.
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async (a) => {
        spArgs = a;
        return {
          content: 'Reemplacé la sección "Conclusiones".',
          format: 'docx',
          previewHtml: '<p>preview</p>',
          validation: { passed: true, ok: true },
          artifact: {
            id: 'art-inproc-1',
            filename: 'informe-editado.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            format: 'docx',
            sizeBytes: 4096,
            downloadUrl: '/api/agent/artifact/art-inproc-1',
          },
        };
      },
    },
    // If the fast path works, the sandbox must NEVER run.
    runDocumentAgent: async () => { sandboxCalled = true; return { outputs: [] }; },
    saveArtifact: () => { throw new Error('saveArtifact must NOT run — in-process editor self-persists'); },
  });

  const out = await tool.execute(
    { instruction: 'cambia la sección Conclusiones' },
    baseCtx({ onEvent: (e) => events.push(e) }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.engine, 'in-process');
  assert.equal(sandboxCalled, false, 'sandbox doc-agent must be skipped when the in-process editor handles it');
  assert.equal(spArgs.fileIds[0], 'f1', 'in-process editor receives the confined file ids');
  assert.equal(spArgs.prompt, 'cambia la sección Conclusiones');
  assert.equal(out.edited.length, 1);
  assert.equal(out.edited[0].downloadUrl, '/api/agent/artifact/art-inproc-1');

  const fa = events.find((e) => e.type === 'file_artifact');
  assert.ok(fa, 'file_artifact event must be emitted for the chat card');
  assert.equal(fa.artifact.id, 'art-inproc-1');
  assert.equal(fa.artifact.filename, 'informe-editado.docx');
  assert.equal(fa.artifact.previewHtml, '<p>preview</p>');
  fs.rmSync(inputPath, { force: true });
});

test('in-process fast path emits and returns every source-preserving batch artifact once', async () => {
  const events = [];
  let sandboxCalled = false;
  const makeResult = (suffix) => ({
    content: `Edité ${suffix}.docx.`,
    format: 'docx',
    previewHtml: `<p>${suffix}</p>`,
    validation: { passed: true },
    version: { id: `version-${suffix}`, version: 2, sourceFileId: `f${suffix}` },
    artifact: {
      id: `art-${suffix}`,
      filename: `${suffix}-editado.docx`,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      format: 'docx',
      sizeBytes: 1024,
      downloadUrl: `/api/agent/artifact/art-${suffix}`,
    },
  });
  const first = makeResult('1');
  const second = makeResult('2');
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', size: 1024, path: '/not-read/uno.docx', originalName: 'uno.docx', filename: 'uno.docx' },
      { id: 'f2', userId: 'u1', size: 1024, path: '/not-read/dos.docx', originalName: 'dos.docx', filename: 'dos.docx' },
    ]),
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => ({
        batch: true,
        content: 'Listo. Edité y validé 2 documentos.',
        format: 'docx',
        artifact: first.artifact, // singular compatibility alias must not duplicate it
        results: [first, second],
        failures: [],
      }),
    },
    runDocumentAgent: async () => {
      sandboxCalled = true;
      return { outputs: [] };
    },
  });

  const out = await tool.execute(
    { instruction: 'cambia el título en todos los documentos' },
    baseCtx({ fileIds: ['f1', 'f2'], onEvent: (event) => events.push(event) }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.batch, true);
  assert.equal(sandboxCalled, false);
  assert.deepEqual(out.edited.map((item) => item.id), ['art-1', 'art-2']);
  assert.deepEqual(out.artifacts.map((item) => item.id), ['art-1', 'art-2']);
  assert.deepEqual(out.edited.map((item) => item.sourceFileId), ['f1', 'f2']);
  assert.deepEqual(
    events.filter((event) => event.type === 'file_artifact').map((event) => event.artifact.id),
    ['art-1', 'art-2'],
  );
});

test('source-preserving fast path emits and returns only artifacts with validation.passed === true', async () => {
  const events = [];
  let sandboxCalled = false;
  const makeResult = (id, validation) => ({
    validation,
    version: { id: `version-${id}`, version: 2, sourceFileId: `f${id}` },
    artifact: {
      id: `art-${id}`,
      filename: `${id}-editado.docx`,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      format: 'docx',
      sizeBytes: 512,
      downloadUrl: `/api/agent/artifact/art-${id}`,
    },
  });
  const valid = makeResult('valid', { passed: true });
  const invalid = makeResult('invalid', { passed: false, ok: true, reason: 'title_not_changed' });
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([
      { id: 'fvalid', userId: 'u1', size: 512, path: '/not-read/valid.docx', originalName: 'valid.docx', filename: 'valid.docx' },
      { id: 'finvalid', userId: 'u1', size: 512, path: '/not-read/invalid.docx', originalName: 'invalid.docx', filename: 'invalid.docx' },
    ]),
    sourcePreservingEdit: {
      isSourcePreservingEditRequest: () => true,
      tryGenerateSourcePreservingDocumentEdit: async () => ({
        batch: true,
        results: [valid, invalid],
      }),
    },
    runDocumentAgent: async () => {
      sandboxCalled = true;
      return { outputs: [{ name: 'regenerado.docx', buffer: Buffer.from('nope'), valid: true }] };
    },
  });

  const out = await tool.execute(
    { instruction: 'edita ambos documentos y conserva los originales' },
    baseCtx({ fileIds: ['fvalid', 'finvalid'], onEvent: (event) => events.push(event) }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.partial, true);
  assert.equal(sandboxCalled, false);
  assert.deepEqual(out.artifacts.map((artifact) => artifact.id), ['art-valid']);
  assert.deepEqual(out.edited.map((artifact) => artifact.id), ['art-valid']);
  assert.deepEqual(
    events.filter((event) => event.type === 'file_artifact').map((event) => event.artifact.id),
    ['art-valid'],
  );
  assert.equal(out.artifacts[0].validation.passed, true);
  assert.match(out.summary, /No entregué 1 archivo/);
});

test('source-preserving validation failure is terminal and never falls through to sandbox regeneration', async () => {
  const events = [];
  let sandboxCalled = false;
  let blobReadCalled = false;
  const tool = buildDocumentEditTool({
    fsImpl: {
      readFile: async () => {
        blobReadCalled = true;
        return Buffer.from('must-not-read');
      },
    },
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', size: 900, path: '/not-read/original.docx', originalName: 'original.docx', filename: 'original.docx' },
    ]),
    sourcePreservingEdit: {
      isSourcePreservingEditRequest: () => true,
      tryGenerateSourcePreservingDocumentEdit: async () => ({
        content: 'Afirmación que no debe mostrarse como éxito.',
        validation: { passed: false, ok: true, reason: 'requested_change_not_verified' },
        artifact: {
          id: 'art-invalid-only',
          filename: 'original-editado.docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          format: 'docx',
          sizeBytes: 900,
          downloadUrl: '/api/agent/artifact/art-invalid-only',
        },
      }),
    },
    runDocumentAgent: async () => {
      sandboxCalled = true;
      return { outputs: [{ name: 'regenerado.docx', buffer: Buffer.from('nope'), valid: true }] };
    },
  });

  const out = await tool.execute(
    { instruction: 'cambia solo el título y devuelve el mismo Word' },
    baseCtx({ onEvent: (event) => events.push(event) }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.error, 'source_preserving_validation_failed');
  assert.equal(out.code, 'SOURCE_PRESERVING_VALIDATION_FAILED');
  assert.deepEqual(out.artifacts, []);
  assert.deepEqual(out.edited, []);
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  assert.equal(blobReadCalled, false, 'invalid source-preserving output must not enter blob/sandbox path');
  assert.equal(sandboxCalled, false, 'invalid source-preserving output must not regenerate a replacement');
  assert.match(out.message, /no generé un documento sustituto/i);
});

test('in-process fast path runs before the sandbox 20MB blob cap', async () => {
  const inputPath = tmpFileWith('oversized-placeholder');
  const events = [];
  let sandboxCalled = false;
  let blobReadCalled = false;

  const tool = buildDocumentEditTool({
    fsImpl: {
      readFile: async () => {
        blobReadCalled = true;
        return Buffer.alloc(MAX_FILE_BYTES + 1);
      },
    },
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: inputPath, originalName: 'tesis-grande.docx', filename: 'tesis-grande.docx' }]),
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => ({
        content: 'Eliminé Anexo 1 y todo el contenido posterior.',
        format: 'docx',
        previewHtml: null,
        validation: { passed: true, ok: true },
        artifact: {
          id: 'art-large-docx',
          filename: 'tesis-grande_anexo_1_completado.docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          format: 'docx',
          sizeBytes: MAX_FILE_BYTES + 2048,
          downloadUrl: '/api/agent/artifact/art-large-docx',
        },
      }),
    },
    runDocumentAgent: async () => { sandboxCalled = true; return { outputs: [] }; },
  });

  const out = await tool.execute(
    { instruction: 'borra desde el anexo 01 hacia abajo todo porfavor' },
    baseCtx({ onEvent: (e) => events.push(e) }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.engine, 'in-process');
  assert.equal(blobReadCalled, false, 'oversized blobs must not be loaded before the source-preserving editor');
  assert.equal(sandboxCalled, false, 'sandbox doc-agent must not run when source-preserving edit succeeds');
  assert.equal(out.edited[0].downloadUrl, '/api/agent/artifact/art-large-docx');
  assert.ok(events.some((event) => event.type === 'file_artifact' && event.artifact.id === 'art-large-docx'));
  fs.rmSync(inputPath, { force: true });
});

test('source-preserving target failures do not fall through to document regeneration', async () => {
  let sandboxCalled = false;
  const targetError = new Error('No se encontró el texto exacto "ANEXO 01" en el documento original.');
  targetError.code = 'REPLACE_TEXT_NOT_FOUND';

  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', size: 1024, path: '/no/read/needed.docx', originalName: 'tesis.docx', filename: 'tesis.docx' }]),
    sourcePreservingEdit: {
      isSourcePreservingEditRequest: () => true,
      tryGenerateSourcePreservingDocumentEdit: async () => { throw targetError; },
    },
    runDocumentAgent: async () => {
      sandboxCalled = true;
      return { outputs: [{ name: 'regenerado.docx', buffer: Buffer.from('nope'), valid: true }] };
    },
  });

  const out = await tool.execute(
    { instruction: 'reemplaza ANEXO 01 por ANEXO I y devuélveme el mismo Word editado' },
    baseCtx(),
  );

  assert.equal(out.ok, false);
  assert.equal(out.error, 'source_preserving_edit_failed');
  assert.equal(out.code, 'REPLACE_TEXT_NOT_FOUND');
  assert.equal(sandboxCalled, false, 'target-not-located failures must not regenerate a different document');
  assert.match(out.hint, /No generé un documento nuevo/);
});

test('unresolved source-preserving intent fails closed without sandbox or a false Validado artifact', async () => {
  let sandboxCalled = false;
  let blobReadCalled = false;
  let saveArtifactCalled = false;
  const events = [];
  const unresolvedError = new Error(
    'No pude identificar con seguridad el texto exacto que deseas cambiar en el Word.',
  );
  unresolvedError.code = 'SOURCE_EDIT_INTENT_UNRESOLVED';

  const tool = buildDocumentEditTool({
    prisma: fakePrisma([{
      id: 'f1',
      userId: 'u1',
      size: 1024,
      path: '/must/not/read/original.docx',
      originalName: 'original.docx',
      filename: 'original.docx',
    }]),
    fsImpl: {
      readFile: async () => {
        blobReadCalled = true;
        return Buffer.from('unchanged-original-bytes');
      },
    },
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => { throw unresolvedError; },
    },
    runDocumentAgent: async () => {
      sandboxCalled = true;
      return {
        outputs: [{
          name: 'original-editado.docx',
          buffer: Buffer.from('unchanged-original-bytes'),
          valid: true,
        }],
        finalText: 'Listo.',
      };
    },
    saveArtifact: () => {
      saveArtifactCalled = true;
      return {
        id: 'must-not-exist',
        filename: 'original-editado.docx',
        downloadUrl: '/api/agent/artifact/must-not-exist',
      };
    },
  });

  const out = await tool.execute(
    { instruction: 'modifica el título, pero no indico cuál es el texto actual ni el nuevo' },
    baseCtx({ onEvent: (event) => events.push(event) }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.error, 'source_preserving_edit_failed');
  assert.equal(out.code, 'SOURCE_EDIT_INTENT_UNRESOLVED');
  assert.equal(blobReadCalled, false, 'unresolved intent must stop before loading bytes for the sandbox');
  assert.equal(sandboxCalled, false, 'unresolved intent must never fall through to sandbox regeneration');
  assert.equal(saveArtifactCalled, false, 'unchanged bytes must never be persisted as a validated artifact');
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('/api/agent/artifact/'), false, 'no download URL may escape');
  assert.equal(serialized.includes('"passed":true'), false, 'the response must not claim deterministic validation');
  assert.equal(serialized.includes('Validado'), false, 'the response must not claim a false Validado state');
  assert.match(out.hint, /No generé un documento nuevo/);
});

test('in-process fast path falls through to the sandbox when the editor returns null or throws', async () => {
  const inputPath = tmpFileWith('original-bytes');

  // null → not a source-preserving edit → sandbox runs.
  let sandboxCalls = 0;
  const toolNull = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: inputPath, originalName: 'x.docx', filename: 'x.docx' }]),
    sourcePreservingEdit: { tryGenerateSourcePreservingDocumentEdit: async () => null },
    runDocumentAgent: async () => {
      sandboxCalls += 1;
      return { outputs: [{ name: 'e.docx', buffer: Buffer.from('y'), valid: true }], iterations: 1, driver: 'local', finalText: 'ok' };
    },
  });
  const outNull = await toolNull.execute({ instruction: 'edita algo' }, baseCtx());
  assert.equal(outNull.ok, true);
  assert.equal(outNull.driver, 'local', 'null result must fall through to the sandbox doc-agent');
  assert.equal(sandboxCalls, 1);

  // throw → editor can't handle this source → sandbox still runs (no capability loss).
  const toolThrow = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: inputPath, originalName: 'x.docx', filename: 'x.docx' }]),
    sourcePreservingEdit: { tryGenerateSourcePreservingDocumentEdit: async () => { throw new Error('necesito un archivo DOCX con la sección solicitada'); } },
    runDocumentAgent: async () => ({ outputs: [{ name: 'e.docx', buffer: Buffer.from('y'), valid: true }], iterations: 1, driver: 'local', finalText: 'ok' }),
  });
  const outThrow = await toolThrow.execute({ instruction: 'edita algo' }, baseCtx());
  assert.equal(outThrow.ok, true, 'a throw from the in-process editor must not fail the tool — sandbox takes over');
  assert.equal(outThrow.driver, 'local');
  fs.rmSync(inputPath, { force: true });
});

test('sandbox path materializes r2: attachments instead of fs.readFile on the ref', async () => {
  let agentArgs = null;
  let readSourceCalled = false;
  const tool = buildDocumentEditTool({
    sourcePreservingEdit: {
      tryGenerateSourcePreservingDocumentEdit: async () => null,
      readSourceBuffer: async (row) => {
        readSourceCalled = true;
        assert.equal(row.path, 'r2:uploads/u1/informe.docx');
        return { buffer: Buffer.from('r2-bytes'), cleanup: async () => {} };
      },
    },
    objectStorage: { isRemote: (ref) => String(ref || '').startsWith('r2:') },
    prisma: fakePrisma([{
      id: 'f1',
      userId: 'u1',
      size: 8,
      path: 'r2:uploads/u1/informe.docx',
      originalName: 'informe.docx',
      filename: 'informe.docx',
    }]),
    fsImpl: {
      readFile: async () => {
        throw new Error('fs.readFile must not be called for r2: refs');
      },
    },
    runDocumentAgent: async (opts) => {
      agentArgs = opts;
      return {
        outputs: [{ name: 'informe-editado.docx', buffer: Buffer.from('edited'), valid: true }],
        finalText: 'ok',
        iterations: 1,
        driver: 'local',
      };
    },
  });

  const out = await tool.execute({ instruction: 'corrige el título del documento' }, baseCtx());
  assert.equal(out.ok, true);
  assert.equal(readSourceCalled, true, 'r2: attachments must go through readSourceBuffer');
  assert.equal(agentArgs.files[0].buffer.toString('utf8'), 'r2-bytes');
});
