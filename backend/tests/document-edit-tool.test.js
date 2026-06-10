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

const { buildDocumentEditTool, MAX_CALLS_PER_TURN } = require('../src/services/agent-harness/tools/document-edit-tool');
const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');

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

test('happy path: ownership-scoped lookup, agent gets bytes, artifact card emitted', async () => {
  const inputPath = tmpFileWith('original-bytes');
  const capture = {};
  const events = [];
  let agentArgs = null;

  const tool = buildDocumentEditTool({
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
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: '/does/not/exist', originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [] }),
  });
  const r1 = await t1.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([r1.ok, r1.error], [false, 'file_blob_missing']);

  // file_not_found (row owned by another user)
  const t2 = buildDocumentEditTool({
    prisma: fakePrisma([{ id: 'f1', userId: 'OTHER', path: '/x', originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [] }),
  });
  const r2 = await t2.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([r2.ok, r2.error], [false, 'file_not_found']);

  // doc_agent_failed (e.g. OPENROUTER_API_KEY missing in dev)
  const p3 = tmpFileWith('x');
  const t3 = buildDocumentEditTool({
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
    prisma: fakePrisma([{ id: 'f1', userId: 'u1', path: p, originalName: 'a.docx', filename: 'a' }]),
    runDocumentAgent: async () => ({ outputs: [{ name: 'broken.docx', buffer: Buffer.alloc(0), valid: false }], finalText: 'meh' }),
  });
  const out = await tool.execute({ instruction: 'edita el documento' }, baseCtx());
  assert.deepEqual([out.ok, out.error], [false, 'no_output']);
  fs.rmSync(p, { force: true });
});

test('per-turn call budget: the 4th call on the SAME ctx is refused', async () => {
  const p = tmpFileWith('x');
  const tool = buildDocumentEditTool({
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
  assert.equal(isSourcePreservingEditRequest('¿qué dice el documento?', docx), false);
  assert.equal(isSourcePreservingEditRequest('resume esto', docx), false);

  const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
  assert.equal(shouldUseAgenticChat({ prompt: 'edita mi documento: cambia el título', files: [{ id: 'f1' }] }), true);
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
