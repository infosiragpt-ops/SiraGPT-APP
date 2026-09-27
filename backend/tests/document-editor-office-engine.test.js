'use strict';

/**
 * Edición milimétrica — Fase G: the chat document editor on the same engine,
 * verification and timeline as the AgentRunner.
 *
 *   - Word (docx engine): every tool call is a stage v2 row (callId, kind,
 *     phrase, detail); `finish` runs the office visual verification (render,
 *     zones, composite, vision) — a veto asks for one more revision, and on
 *     the last round the deterministic checks rule; the composite thumbnail
 *     rides on the finish row.
 *   - Excel / PowerPoint: the AgentRunner office loop (picked client, editor
 *     rules, never delivers an edit whose last verification failed); PDFs keep
 *     the doc-agent loop.
 *   - The runner never delivers intermediate versions of an office_edit chain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const { runDocxEngineEdit, docxStepPhrase } = require('../src/services/docx-engine/agent');
const { buildUserSummary } = require('../src/services/docx-engine');
const office = require('../src/services/document-editor/office-engine');
const { dropIntermediateOutputs } = require('../src/services/agent-runner');
const { INTERNAL } = require('../src/services/document-editor/chat-document-editor');
const { toStageEvent } = require('../src/services/agent-runner/trace');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text, bold = false) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (runs) => `<w:p>${runs}</w:p>`;

function formDocx() {
  const body = [
    para(run('MATRIZ PARA EVALUACIÓN DE EXPERTOS', true)),
    para(run('Título de la investigación: ', true)),
    para(run('DNI:', true)),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
  ].join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

function scriptedClient(turns) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { async create(payload) {
      calls.push(structuredClone(payload));
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: typeof turn === 'function' ? turn(payload) : turn }] };
    } } },
  };
}
const call = (name, args, id) => ({ id: id || `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const renderText = async (b) => ({ pages: 1, text: new PizZip(b).file('word/document.xml').asText().replace(/<[^>]+>/g, '') });
const REVIEW_OK = { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] }, 'rev')] };
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

/* ── Word: docx engine timeline + visual verification ───────────────────── */

test('docx engine: every tool call is a stage v2 row; finish carries the before/after thumbnail', async () => {
  const events = [];
  const visualCalls = [];
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'Título de la investigación:', value: 'Gestión administrativa', description: 'Completando el título' }, 'f1'),
      call('fill_field', { label: 'DNI:', value: '72792992' }, 'f2')] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Completé el título y el DNI.', expected_values: ['Gestión administrativa', '72792992'] }, 'fin')] },
    REVIEW_OK,
  ]);
  const out = await runDocxEngineEdit({
    buffer: formDocx(), instruction: 'completa el título Gestión administrativa y mi DNI 72792992', client, model: 'm', render: renderText,
    onEvent: (ev) => events.push(ev),
    visualVerify: async (args) => { visualCalls.push(args); return { ok: true, checksOk: true, visionOk: true, text: 'VEREDICTO: VERIFICADO', thumbs: [THUMB] }; },
  });
  assert.equal(out.ok, true);
  assert.equal(visualCalls.length, 1, 'finish ran the office visual verification');
  assert.deepEqual(visualCalls[0].expectedValues, ['Gestión administrativa', '72792992']);
  assert.ok(Buffer.isBuffer(visualCalls[0].originalBuffer) && Buffer.isBuffer(visualCalls[0].editedBuffer));

  const rows = events.filter((e) => e.callId);
  const f1 = rows.filter((e) => e.callId === 'f1');
  assert.deepEqual(f1.map((e) => e.step), ['tool_call', 'tool_result']);
  assert.equal(f1[0].label, 'Completando el título', "the model's own phrase");
  assert.equal(f1[0].kind, 'edit');
  assert.equal(f1[0].status, 'running');
  assert.equal(f1[1].status, 'done');
  assert.match(f1[0].detail, /Gestión administrativa/);
  const f2 = rows.find((e) => e.callId === 'f2' && e.step === 'tool_call');
  assert.equal(f2.label, 'Completando «DNI»', 'derived phrase without a description');
  const fin = rows.filter((e) => e.callId === 'fin');
  assert.equal(fin[0].kind, 'check');
  assert.equal(fin[1].status, 'done');
  assert.deepEqual(fin[1].thumbs, [THUMB], 'the composite rides on the finish row');
  // The stage v2 rows survive the SSE normalizer unchanged in meaning.
  const stage = toStageEvent({ type: fin[1].step, ...fin[1] });
  assert.equal(stage.callId, 'fin');
  assert.equal(stage.kind, 'check');

  const summary = buildUserSummary({ modelSummary: out.summary, changes: out.changes, verification: out.verification, filename: 'carta.docx' });
  assert.match(summary, /Revisión visual: un modelo de visión comparó el antes y el después/);
});

test('docx engine summary lists the vision reviewer ✓/✗ lines; the page setup is guarded', async () => {
  const verification = { report: { visual: { visionOk: true, summary: '• Resultado: OK\n• Revisión visual (modelo de visión): ✓ El título dice Gestión administrativa — pág. 1 | ✓ No cambia nada más — idéntico\nVEREDICTO: VERIFICADO' } } };
  const summary = buildUserSummary({ modelSummary: 'Listo.', changes: [], verification, filename: 'c.docx' });
  assert.match(summary, /- ✓ El título dice Gestión administrativa\n- ✓ No cambia nada más/);
  assert.doesNotMatch(summary, /pág\. 1 \|/, 'evidence stays out of the short list');

  const { verifyEditedDocx, bodySectPr } = require('../src/services/docx-engine/verify');
  const { requestTouchesPageSetup } = require('../src/services/docx-engine/agent');
  const original = formDocx();
  const zip = new PizZip(original);
  const xml = zip.file('word/document.xml').asText();
  zip.file('word/document.xml', xml.replace('Título de la investigación: ', 'Título de la investigación: Gestión').replace('<w:pgSz w:w="11906" w:h="16838"/>', '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'));
  const edited = zip.generate({ type: 'nodebuffer' });
  assert.notEqual(bodySectPr(xml), bodySectPr(zip.file('word/document.xml').asText()));
  const guarded = await verifyEditedDocx({ originalBuffer: original, editedBuffer: edited, changedParts: ['word/document.xml'] });
  assert.ok(guarded.issues.some((i) => /configuración de página/.test(i)), 'a side-effect page setup change is flagged');
  const allowed = await verifyEditedDocx({ originalBuffer: original, editedBuffer: edited, changedParts: ['word/document.xml'], allowSectionChange: true });
  assert.ok(!allowed.issues.some((i) => /configuración de página/.test(i)));
  assert.equal(requestTouchesPageSetup('ponlo en horizontal y cambia los márgenes'), true);
  assert.equal(requestTouchesPageSetup('completa el título de la investigación'), false);
});

test('docx engine: a vision veto asks for one more revision; on the last round the deterministic checks rule', async () => {
  const verdicts = [
    { ok: false, checksOk: true, visionOk: false, text: '✗ el título no se ve', issues: ['Revisión visual: ✗ el título no se ve'], thumbs: [THUMB] },
    { ok: false, checksOk: true, visionOk: false, text: '✗ sigue sin verse', issues: ['Revisión visual: ✗ sigue sin verse'], thumbs: [THUMB] },
  ];
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '72792992' }, 'a')] },
    { tool_calls: [call('finish', { status: 'done', summary: 'DNI completado.', expected_values: ['72792992'] }, 'fin1')] },
    REVIEW_OK,
    { tool_calls: [call('finish', { status: 'done', summary: 'DNI completado.', expected_values: ['72792992'] }, 'fin2')] },
    REVIEW_OK,
  ]);
  const events = [];
  const out = await runDocxEngineEdit({
    buffer: formDocx(), instruction: 'mi DNI es 72792992', client, model: 'm', render: renderText,
    onEvent: (ev) => events.push(ev), visualVerify: async () => verdicts.shift(),
  });
  const toolMsgs = client.calls[3].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs.at(-1).content, /VERIFICACIÓN CON PROBLEMAS[\s\S]*Revisión visual: ✗ el título no se ve/);
  assert.equal(out.ok, true, 'second round: vision alone never blocks a deterministically verified edit');
  assert.equal(out.verification.report.visual.visionOk, false);
  assert.equal(events.find((e) => e.callId === 'fin1' && e.step === 'tool_result').status, 'error', 'the vetoed finish reads as a failed check');
});

test('docx engine: an unavailable renderer never blocks and never claims a visual review', async () => {
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '72792992' })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Listo.', expected_values: ['72792992'] })] },
    REVIEW_OK,
  ]);
  const out = await runDocxEngineEdit({
    buffer: formDocx(), instruction: 'DNI 72792992', client, model: 'm', render: renderText,
    visualVerify: async () => ({ ok: null, unavailable: true }),
  });
  assert.equal(out.ok, true);
  const summary = buildUserSummary({ modelSummary: out.summary, changes: out.changes, verification: out.verification, filename: 'c.docx' });
  assert.doesNotMatch(summary, /Revisión visual/);
});

test('docx step phrases: the model phrase wins; derived phrases never leak ids', () => {
  assert.equal(docxStepPhrase('fill_field', { label: 'Línea de investigación:', description: '  Completando la línea\n' }), 'Completando la línea');
  assert.equal(docxStepPhrase('fill_field', { label: 'Línea de investigación:' }), 'Completando «Línea de investigación»');
  assert.equal(docxStepPhrase('set_cells', { cells: [{}, {}, {}] }), 'Escribiendo en 3 celdas de la tabla');
  assert.equal(docxStepPhrase('set_cell', { cell: 't1.r3.c4' }), 'Escribiendo en la tabla');
  assert.equal(docxStepPhrase('finish', {}), 'Comparando antes y después');
  const tools = require('../src/services/docx-engine/tools').toOpenAiTools();
  assert.ok(tools.every((t) => t.function.parameters.properties.description), 'every docx tool accepts the timeline phrase');
});

/* ── Excel / PowerPoint: the office loop ───────────────────────────────── */

test('office editor engine: picked client + editor rules; an edit whose last verification failed is not deliverable', async () => {
  const calls = [];
  const fakeRunner = async (opts) => {
    calls.push(opts);
    return {
      finalText: 'Listo.',
      stoppedReason: 'final',
      steps: opts.__steps,
      outputs: [{ name: 'presupuesto-editado.xlsx', buffer: Buffer.from('x'), valid: true, validation: { passed: true } }],
    };
  };
  const client = { chat: { completions: { create: async () => ({}) } } };
  const ok = await office.runOfficeEditorEngine({
    files: [{ name: 'presupuesto.xlsx', buffer: Buffer.from('a') }], instruction: 'Sube a 15 los ensayos', client, model: 'deepseek-v4-pro',
    runAgentRunner: (opts) => fakeRunner({ ...opts, __steps: [{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: true }] }),
  });
  assert.equal(calls[0].client, client, 'the picked model client drives the loop');
  assert.equal(calls[0].model, 'deepseek-v4-pro');
  assert.match(calls[0].systemAppend, /never append an annex/);
  assert.doesNotMatch(calls[0].systemAppend, /YOU to write that content/);
  assert.equal(ok.outputs[0].valid, true);

  const failed = await office.runOfficeEditorEngine({
    files: [{ name: 'd.pptx', buffer: Buffer.from('a') }], instruction: 'agrega comentarios en las notas de cada diapositiva', client, model: 'm',
    runAgentRunner: (opts) => fakeRunner({ ...opts, __steps: [{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: false }] }),
  });
  assert.equal(failed.outputs[0].valid, false, 'never delivered unverified');
  assert.match(calls[1].systemAppend, /YOU to write that content/, 'author-content rule for «agrega comentarios»');

  const unverified = await office.runOfficeEditorEngine({
    files: [{ name: 'd.pptx', buffer: Buffer.from('a') }], instruction: 'cambia el año', client, model: 'm',
    runAgentRunner: (opts) => fakeRunner({ ...opts, __steps: [{ tool: 'office_edit', ok: true }] }),
  });
  assert.equal(unverified.outputs[0].valid, false, 'an office edit without verify_visual is not a deliverable');
});

test('office editor flags: default office engine; legacy rollback; visual verify off in tests unless forced', () => {
  assert.equal(office.officeEditorEnabled({}), true);
  assert.equal(office.officeEditorEnabled({ SIRAGPT_DOCUMENT_EDITOR_ENGINE: 'legacy' }), false);
  assert.equal(office.visualVerifyEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(office.visualVerifyEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(office.visualVerifyEnabled({ NODE_ENV: 'production', SIRAGPT_DOCUMENT_EDITOR_VISUAL_VERIFY: '0' }), false);
  assert.equal(office.makeOfficeVisualVerifier({ env: { NODE_ENV: 'test' } }), null);
});

test('office engine takes Excel / PowerPoint / Word packages; PDFs and other formats keep the doc-agent loop', () => {
  assert.equal(office.officeEngineHandles([{ name: 'presupuesto.xlsx' }]), true);
  assert.equal(office.officeEngineHandles([{ name: 'defensa.PPTX' }, { name: 'tesis.docx' }]), true);
  assert.equal(office.officeEngineHandles([{ name: 'informe.pdf' }]), false);
  assert.equal(office.officeEngineHandles([{ name: 'tesis.docx' }, { name: 'anexo.pdf' }]), false);
  assert.equal(office.officeEngineHandles([{ name: 'viejo.doc' }]), false);
  assert.equal(office.officeEngineHandles([]), false);
  const editor = fs.readFileSync(path.join(__dirname, '..', 'src/services/document-editor/chat-document-editor.js'), 'utf8');
  assert.match(editor, /office\.officeEngineHandles\(options && options\.files\)\s*\? office\.runOfficeEditorEngine\(options\)\s*: legacy\(options\)/);
});

test('editor relay: office-engine rows travel as stage v2; legacy doc-agent events keep the editor phrases', () => {
  const v2 = INTERNAL.relayStage({ type: 'tool_call', tool: 'office_edit', callId: 'c1', description: 'Cambiando B4', args: { src: 'uploads/p.xlsx', ops: [] } });
  assert.equal(v2.callId, 'c1');
  assert.equal(v2.kind, 'edit');
  assert.equal(v2.label, 'Cambiando B4');
  assert.deepEqual(INTERNAL.relayStage({ type: 'phase', phase: 'execute' }), { label: 'Editando el documento' });
});

test('runner: the intermediate versions of an office_edit chain are not delivered', () => {
  const outputs = [{ name: 'tesis-editado.docx' }, { name: 'tesis-editado-v2.docx' }];
  const steps = [
    { tool: 'office_edit', ok: true, args: { src: 'uploads/tesis.docx', dst: 'outputs/tesis-editado.docx' } },
    { tool: 'verify_visual', ok: false },
    { tool: 'office_edit', ok: true, args: { src: 'outputs/tesis-editado.docx', dst: 'outputs/tesis-editado-v2.docx' } },
    { tool: 'verify_visual', ok: true },
  ];
  assert.deepEqual(dropIntermediateOutputs(outputs, steps).map((o) => o.name), ['tesis-editado-v2.docx']);
  assert.deepEqual(dropIntermediateOutputs(outputs, []).map((o) => o.name), ['tesis-editado.docx', 'tesis-editado-v2.docx']);
  assert.deepEqual(dropIntermediateOutputs([{ name: 'a.docx' }], [{ tool: 'office_edit', ok: true, args: { src: '/workspace/outputs/a.docx' } }]).map((o) => o.name), ['a.docx'], 'never drops everything');
});

test('office visual verifier: real engine in a sandbox — composite + thumbnail with a renderer, honest "unavailable" without', { timeout: 300_000 }, async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('python3', ['-c', 'import lxml, PIL']).status !== 0) { t.skip('python3 + lxml + Pillow requeridos'); return; }
  const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
  const render = has('soffice') && has('pdftoppm');
  const { createSandbox } = require('../src/services/doc-agent/sandbox');
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'office', 'tesis_demo.docx'));
  // The edited version: the same engine edit a model would make.
  const sb = await createSandbox({ driver: 'local' });
  let edited;
  try {
    const tools = require('../src/services/agent-runner/tools.office');
    await sb.exec('mkdir -p /workspace/uploads /workspace/outputs /workspace/tmp', { timeoutMs: 10_000 });
    await tools.installOfficeEngine(sb);
    await sb.putFile('uploads/t.docx', fixture);
    const res = await tools.runEngine(sb, 'edit', { src: 'uploads/t.docx', dst: 'outputs/t.docx', ops: [{ op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' }] });
    assert.equal(res.ok, true);
    edited = await sb.readFile('outputs/t.docx');
  } finally { await sb.destroy(); }
  const verify = office.makeOfficeVisualVerifier({
    env: { NODE_ENV: 'production' },
    createSandbox: () => createSandbox({ driver: 'local' }),
    visionVerifier: async () => ({ ok: true, text: '✓ Lima, 2025 en la portada' }),
  });
  const out = await verify({ originalBuffer: fixture, editedBuffer: edited, filename: 'tesis.docx', instruction: 'cambia 2024 por 2025', expectedValues: ['Lima, 2025'] });
  if (render) {
    assert.equal(out.ok, true, out.text);
    assert.equal(out.visionOk, true);
    assert.ok(out.thumbs.length >= 1 && /^data:image\/jpeg;base64,/.test(out.thumbs[0]), 'composite thumbnail for the timeline');
  } else {
    assert.equal(out.unavailable, true, 'no renderer → honest unavailable, never a pass');
    assert.equal(out.ok, null);
  }
});

test('runner follows the model picked in the composer (first rung), operator pin still wins', () => {
  const { runnerModelSpec } = require('../src/services/agent-runner');
  assert.equal(runnerModelSpec('DeepSeek', 'deepseek-v4-pro'), 'DeepSeek:deepseek-v4-pro');
  assert.equal(runnerModelSpec('xAI', 'grok-4.7'), 'xAI:grok-4.7');
  assert.equal(runnerModelSpec('Custom', 'mi-modelo'), null, 'Custom / unknown providers keep the ladder order');
  assert.equal(runnerModelSpec('DeepSeek', ''), null);
  const { resolveDocAgentCandidates } = require('../src/services/doc-agent/llm-runtime');
  const env = { XAI_API_KEY: 'xai-live-key', DEEPSEEK_API_KEY: 'ds-live-key' };
  const order = resolveDocAgentCandidates({ model: runnerModelSpec('xAI', 'grok-4.7'), env }).map((c) => `${c.provider}:${c.model}`);
  assert.equal(order[0], 'xAI:grok-4.7', 'the picked model is the first rung');
  assert.ok(order.some((c) => c.startsWith('DeepSeek:')), 'the ladder remains for provider errors');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('src/services/agentic-chat-stream.js'), /pickedModel: require\('\.\/agent-runner'\)\.runnerModelSpec\(provider, model\),/);
  const index = read('src/services/agent-runner/index.js');
  assert.match(index, /resolveDocAgentCandidates\(\{ model: explicitRunnerModel\(\) \|\| pickedModel \|\| null \}\)/);
  assert.match(index, /if \(!llm\) llm = createRunnerLlmClient\(\{ onEvent, pickedModel \}\);/);
});

/* ── wiring (source contracts) ───────────────────────────────────────────── */

test('wiring: /document-edit forwards stage v2 and persists the timeline; the editor passes the visual verifier', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const ai = read('src/routes/ai.js');
  const route = ai.slice(ai.indexOf("'/document-edit',"), ai.indexOf("router.post('/stop-stream'"));
  assert.match(route, /const frame = \{ \.\.\.stage, type: 'stage' \};/);
  assert.match(route, /editorTrace\.push\(frame\)/);
  assert.match(route, /null, null, 0, \{ activityTrace \},/);
  const editor = read('src/services/document-editor/chat-document-editor.js');
  assert.match(editor, /deps\.makeVisualVerifier\(\{ pickedModel: llm\.model, env: deps\.env \}\)/);
  assert.match(editor, /\.\.\.\(visualVerify \? \{ visualVerify \} : \{\}\),/);
  assert.match(editor, /office\.officeEditorEnabled\(injected\.env \|\| process\.env\)/);
  assert.match(editor, /onEvent: \(event\) => \{ const stage = relayStage\(event\); if \(stage\) emit\(stage\); \},/);
});

test('Word: indent, tracked changes and paraphrases run on the office engine; forms stay on the docx engine', async () => {
  const { runChatDocumentEdit } = require('../src/services/document-editor/chat-document-editor');
  for (const prompt of [
    'En la introducción pon sangría de primera línea de 1,25 cm y texto justificado.',
    'En la tabla corrige 14,6 por 15,1 con control de cambios.',
    'Parafrasea el párrafo que cita a García (2020) sin tocar la cita.',
  ]) assert.equal(office.wordNeedsOfficeEngine(prompt, {}), true, prompt);
  for (const prompt of [
    'completa el word con mis datos de magisterio soy Luis Carrera Salas',
    'EN EL MISMO WORD QIERO QUE AGREGES COMENTARIOS EN OBSERVACIONES PORFVAOR',
    'Cambia 2024 por 2025 en la portada.',
    'Pon en negrita solo «baja capacidad portante».',
  ]) assert.equal(office.wordNeedsOfficeEngine(prompt, {}), false, prompt);
  assert.equal(office.wordNeedsOfficeEngine('pon sangría de 1,25 cm', { SIRAGPT_DOCUMENT_EDITOR_ENGINE: 'legacy' }), false);

  const USER = 'user-g';
  const prisma = {
    file: { findMany: async (q) => [{ id: 'f1', userId: USER, originalName: 'tesis.docx' }].filter((r) => q.where.id.in.includes(r.id)) },
    message: { findMany: async () => [] },
  };
  const calls = { docx: 0, office: 0 };
  const deps = {
    env: {},
    docxEngine: { docxEngineEnabled: () => true, editWordDocument: async () => { calls.docx += 1; return { ok: false, status: 'failed', message: 'x' }; } },
    artifactDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'g-route-')),
    objectStorage: { toLocalTemp: async () => { throw new Error('not remote'); } },
    readSourceBuffer: async () => ({ buffer: Buffer.from('PKdocx'), cleanup: async () => {} }),
    extractFileIds: () => [],
    saveArtifact: (input) => ({ id: 'abc1def', filename: input.filename, format: 'docx', mime: input.mime, sizeBytes: 3, downloadUrl: '/api/agent/artifact/abc1def' }),
    runDocumentAgent: async () => { calls.office += 1; return { finalText: 'Listo.', outputs: [{ name: 'tesis-editado.docx', buffer: Buffer.from('PKnew'), valid: true }], stoppedReason: 'final' }; },
    tryApplyLiteralDocxTitleEdit: async () => null,
    parseDocxPrecisionRequest: () => null,
    parseDocxImageRequest: () => null,
    makeVisualVerifier: () => null,
    log: () => {},
  };
  const indent = await runChatDocumentEdit({ prisma, userId: USER, fileIds: ['f1'], llm: { client: {}, model: 'picked' }, deps,
    instruction: 'En la introducción pon sangría de primera línea de 1,25 cm y texto justificado.' });
  assert.equal(indent.ok, true);
  assert.deepEqual(calls, { docx: 0, office: 1 });
  await runChatDocumentEdit({ prisma, userId: USER, fileIds: ['f1'], llm: { client: {}, model: 'picked' }, deps,
    instruction: 'Completa mi nombre: Ana Torres' });
  assert.deepEqual(calls, { docx: 1, office: 1 }, 'forms keep the docx engine');
});
