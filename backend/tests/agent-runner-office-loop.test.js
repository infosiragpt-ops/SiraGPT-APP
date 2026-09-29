'use strict';

/**
 * Edición milimétrica — Fase B (docs/specs/edicion-milimetrica/SPEC.md §5).
 * The office tools inside the AgentRunner loop: tool set wiring, the model's
 * `description` + `callId` on every trace event, render_preview v1 fallback,
 * no stale same-turn cache for office results, and the turn-failure hook.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runAgentLoop } = require('../src/services/agent-runner/loop');
const tools = require('../src/services/agent-runner/tools');
const office = require('../src/services/agent-runner/tools.office');
const hook = require('../src/services/agent-runner/turn-failure-hook');

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

test('tool set: office tools ON by default, SIRAGPT_OFFICE_ENGINE=0 restores the old set', () => {
  const on = tools.buildToolDefinitions({ NODE_ENV: 'test' }).map((d) => d.function.name);
  assert.deepEqual(on.slice(on.indexOf('render_preview'), on.indexOf('render_preview') + 4),
    ['render_preview', 'inspect_document', 'office_edit', 'verify_visual']);
  const v2 = tools.buildToolDefinitions({ NODE_ENV: 'test' }).find((d) => d.function.name === 'render_preview');
  assert.ok(v2.function.parameters.properties.pages, 'render_preview v2 takes a page range');

  const off = tools.buildToolDefinitions({ NODE_ENV: 'test', SIRAGPT_OFFICE_ENGINE: '0' }).map((d) => d.function.name);
  for (const name of ['inspect_document', 'office_edit', 'verify_visual']) assert.ok(!off.includes(name), name);
  const v1 = tools.buildToolDefinitions({ NODE_ENV: 'test', SIRAGPT_OFFICE_ENGINE: '0' }).find((d) => d.function.name === 'render_preview');
  assert.equal(v1.function.parameters.properties.pages, undefined);
});

test('every base tool accepts an optional description; nested schemas untouched', () => {
  for (const def of tools.BASE_TOOL_DEFINITIONS) {
    const params = def.function.parameters;
    assert.ok(params.properties.description, `${def.function.name} must accept description`);
    assert.ok(!(params.required || []).includes('description'), `${def.function.name}: description stays optional`);
  }
  const create = tools.BASE_TOOL_DEFINITIONS.find((d) => d.function.name === 'create_presentation');
  assert.deepEqual(Object.keys(create.function.parameters.properties.outline.items.properties), ['title', 'bullets']);
});

test('makeToolExecutors: office executors merged ON, absent OFF', () => {
  const sandbox = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const on = tools.makeToolExecutors(sandbox, { office: { enabled: true } });
  for (const name of ['inspect_document', 'office_edit', 'verify_visual']) assert.equal(typeof on[name], 'function');
  const off = tools.makeToolExecutors(sandbox, { office: { enabled: false } });
  for (const name of ['inspect_document', 'office_edit', 'verify_visual']) assert.equal(off[name], undefined);
});

test('render_preview v2 falls back to v1 when the sandbox has no engine, and reports it', async () => {
  const failures = [];
  const sandbox = {
    async exec(cmd) {
      if (String(cmd).includes('sira_office.py')) {
        return { stdout: '', stderr: "python3: can't open file '/workspace/tmp/sira_office.py'", exitCode: 2 };
      }
      if (String(cmd).includes('preview_stat')) {
        return { stdout: '{"ok":true,"frames":[{"mean_brightness":241}],"count":1}', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {},
    async readFile() { return Buffer.from('x'); },
  };
  const ex = tools.makeToolExecutors(sandbox, { office: { enabled: true, onFailure: (f) => failures.push(f) } });
  const out = await ex.render_preview({ path: 'outputs/a.docx' });
  assert.match(out, /mean_brightness/, 'the v1 renderer answered');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].tool, 'render_preview');
  assert.equal(failures[0].code, 'engine_missing');

  const inspect = await ex.inspect_document({ path: 'uploads/a.docx' });
  assert.match(inspect, /^ERROR: el motor sira_office\.py no está instalado/);
  assert.equal(failures[1].tool, 'inspect_document');
});

test('render_preview on a non-office file (e.g. .md) keeps the v1 renderer', async () => {
  const cmds = [];
  const sandbox = {
    async exec(cmd) {
      cmds.push(String(cmd));
      if (String(cmd).includes('preview_stat')) {
        return { stdout: '{"ok":true,"frames":[],"count":0}', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {},
  };
  const ex = tools.makeToolExecutors(sandbox, { office: { enabled: true } });
  const out = await ex.render_preview({ path: 'outputs/informe.md' });
  assert.match(out, /"frames"/);
  assert.ok(!cmds.some((c) => c.includes('sira_office.py')), 'the engine is only used for docx/xlsx/pptx/pdf');
});

test('operation errors the model can fix are NOT reported as tool failures', async () => {
  const failures = [];
  const sandbox = {
    async exec(cmd) {
      if (String(cmd).includes('sira_office.py')) {
        return { stdout: '{"ok":false,"error":"no encontré «2024» en el párrafo 3"}\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {},
  };
  const ex = office.makeOfficeToolExecutors(sandbox, { onFailure: (f) => failures.push(f) });
  const out = await ex.office_edit({ src: 'uploads/t.docx', ops: [{ op: 'replace_text', paragraph: 3, find: '2024', replace: '2025' }] });
  assert.match(out, /^ERROR: no encontré/);
  assert.equal(failures.length, 0);
});

test('loop: inspect_document → office_edit → verify_visual → final, with description and callId', async () => {
  const client = scriptedClient([
    { toolCalls: [{ name: 'inspect_document', args: { path: 'uploads/tesis.docx', query: '2024', description: 'Buscando el año en la portada' } }] },
    { toolCalls: [{ name: 'office_edit', args: { src: 'uploads/tesis.docx', ops: [{ op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' }], description: 'Cambiando 2024 por 2025 en el párrafo 8' } }] },
    { toolCalls: [{ name: 'verify_visual', args: { before: 'uploads/tesis.docx', after: 'outputs/tesis-editado.docx', checklist: ['2025 en la portada', 'No cambia nada más'], description: 'Comparando antes y después' } }] },
    { content: 'Listo: cambié 2024 por 2025 en la portada (pág. 1). Archivo: tesis-editado.docx.' },
  ]);
  const calls = [];
  const events = [];
  const result = await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'Cambia 2024 por 2025 en la portada' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async inspect_document(args) { calls.push(['inspect', args.query]); return '{"ok":true,"paragraphs":[{"i":8,"text":"Lima, 2024"}]}'; },
      async office_edit(args) { calls.push(['edit', args.ops.length]); return '{"ok":true,"dst":"outputs/tesis-editado.docx","changed_parts":["word/document.xml"]}'; },
      async verify_visual(args) { calls.push(['verify', args.checklist.length]); return 'Verificación OK\nVEREDICTO: VERIFICADO'; },
    },
    maxIterations: 8,
    onEvent: (ev) => events.push(ev),
  });
  assert.deepEqual(calls, [['inspect', '2024'], ['edit', 1], ['verify', 2]]);
  assert.equal(result.stoppedReason, 'final');
  assert.match(result.finalText, /2025/);

  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.deepEqual(toolCalls.map((e) => e.tool), ['inspect_document', 'office_edit', 'verify_visual']);
  assert.deepEqual(toolCalls.map((e) => e.description), [
    'Buscando el año en la portada', 'Cambiando 2024 por 2025 en el párrafo 8', 'Comparando antes y después',
  ]);
  for (const ev of toolCalls) {
    assert.equal(ev.label, ev.description, 'the model phrase is the stage label');
    assert.ok(ev.callId, 'tool_call carries callId');
  }
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => e.callId), toolCalls.map((e) => e.callId), 'tool_result pairs with its tool_call');
});

test('loop: description is plain text, capped at 120; absent → the old fixed label', async () => {
  const client = scriptedClient([
    { toolCalls: [{ name: 'inspect_document', args: { path: 'uploads/a.docx', description: `Leyendo\u0000 la\n\nportada ${'x'.repeat(200)}` } }] },
    { toolCalls: [{ name: 'list_files', args: { path: 'uploads' } }] },
    { content: 'Listo.' },
  ]);
  const events = [];
  await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'lee el documento' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async inspect_document() { return '{"ok":true,"paragraphs":[]}'; },
      async list_files() { return 'uploads/a.docx 1024'; },
    },
    maxIterations: 6,
    onEvent: (ev) => events.push(ev),
  });
  const [first, second] = events.filter((e) => e.type === 'tool_call');
  assert.ok(first.description.startsWith('Leyendo la portada xxx'));
  assert.equal(first.description.length, 120);
  assert.doesNotMatch(first.description, /[\u0000-\u001f]/);
  assert.equal(second.description, undefined);
  assert.equal(second.label, 'Revisando los archivos', 'the fixed label of the tool, never «Ejecutando código» for a listing');
});

test('loop: identical office calls in one turn run again (no stale verification)', async () => {
  const verifyArgs = { after: 'outputs/t-editado.docx', checklist: ['2025'] };
  const client = scriptedClient([
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'office_edit', args: { src: 'uploads/t.docx', dst: 'outputs/t-editado.docx', ops: [{ op: 'replace_text', find: '2024', replace: '2025' }] } }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { content: 'Listo.' },
  ]);
  let verifies = 0;
  await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'cambia el año' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async verify_visual() { verifies += 1; return verifies === 1 ? 'ERROR: verificación fallida' : 'VEREDICTO: VERIFICADO'; },
      async office_edit() { return '{"ok":true}'; },
    },
    maxIterations: 8,
  });
  assert.equal(verifies, 2, 'the second identical verify_visual must execute, not replay the cached failure');
  const loopSource = fs.readFileSync(path.join(__dirname, '../src/services/agent-runner/loop.js'), 'utf8');
  assert.equal((loopSource.match(/!SAME_TURN_CACHE_EXCLUDE_RE\.test\(/g) || []).length, 2, 'both cache sites use the shared exclusion');
});

test('loop: a successful visual repair allows the SAV/Excel readback to finish', async () => {
  const outputPath = 'outputs/encuesta_20x20.xlsx';
  const verifyArgs = { after: outputPath, checklist: ['Los encabezados se ven completos'] };
  const client = scriptedClient([
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'adjust_column_widths()' } }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'reopen_and_compare_sav_xlsx()' } }] },
    { toolCalls: [{ name: 'inspect_document', args: { path: outputPath } }] },
    { content: 'Creé y comprobé el SAV y el Excel.' },
  ]);
  const snapshots = [
    { [outputPath]: '100 1' }, { [outputPath]: '120 2' },
    { [outputPath]: '120 2' }, { [outputPath]: '120 2' },
  ];
  let snapshot = 0;
  let verifies = 0;
  const events = [];
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'dame un documento de SPSS y un Excel' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async verify_visual() {
        verifies += 1;
        return verifies === 1
          ? 'ERROR: verificación fallida: faltan dos encabezados en el PDF visible'
          : 'Verificación: encuesta_20x20.xlsx\n• Checks: ✓ encabezados\nVEREDICTO: VERIFICADO';
      },
      async execute_python() { return 'ok\n[exit 0]'; },
      async inspect_document() { return '{"sheets":[{"name":"Datos","range":"A1:T21"}]}'; },
      [office.OUTPUTS_SNAPSHOT]: async () => snapshots[Math.min(snapshot++, snapshots.length - 1)],
    },
    maxIterations: 8,
    onEvent: (event) => events.push(event),
  });
  assert.equal(verifies, 2);
  assert.equal(result.stoppedReason, 'final', 'a successful repair must not be classified as an oscillation');
  assert.equal(result.steps.filter((step) => step.tool === 'execute_python').at(-1).mutated, false);
  assert.equal(result.steps.findLast((step) => step.tool === 'verify_visual').ok, true);
  assert.equal(events.some((event) => event.code === 'loop_oscillation_cut'), false);
});

test('loop: a distinct second Excel repair can pass the next visual check', async () => {
  const outputPath = 'outputs/encuesta_20x20.xlsx';
  const verifyArgs = { after: outputPath, checklist: ['Los encabezados son legibles'] };
  const client = scriptedClient([
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'set_column_widths(20)' } }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'set_column_widths(32)' } }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'inspect_document', args: { path: outputPath } }] },
    { content: 'Creé y verifiqué el Excel.' },
  ]);
  let verifies = 0;
  const repairs = [];
  const events = [];
  const snapshots = [
    { [outputPath]: '100 1' }, { [outputPath]: '120 2' },
    { [outputPath]: '120 2' }, { [outputPath]: '130 3' },
  ];
  let snapshot = 0;
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'corrige la legibilidad del Excel' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async verify_visual() {
        verifies += 1;
        return verifies < 3
          ? 'ERROR: verificación fallida: encabezados cortados'
          : '• Revisión visual: encabezados completos y legibles\nVEREDICTO: VERIFICADO';
      },
      async execute_python(args) { repairs.push(args.code); return 'ok\n[exit 0]'; },
      async inspect_document() { return '{"sheets":[{"name":"Datos","range":"A1:W21"}]}'; },
      [office.OUTPUTS_SNAPSHOT]: async () => snapshots[Math.min(snapshot++, snapshots.length - 1)],
    },
    maxIterations: 10,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.stoppedReason, 'final');
  assert.deepEqual(repairs, ['set_column_widths(20)', 'set_column_widths(32)']);
  assert.equal(verifies, 3);
  assert.equal(result.steps.filter((step) => step.tool === 'execute_python').every((step) => step.mutated === true), true);
  assert.equal(events.some((event) => event.code === 'loop_oscillation_cut'), false);
});

test('loop: changed Python code and description cannot excuse a read-only visual repair cycle', async () => {
  const outputPath = 'outputs/encuesta_20x20.xlsx';
  const verifyArgs = { after: outputPath, checklist: ['Los encabezados son legibles'] };
  const client = scriptedClient([
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'inspect_widths()', description: 'Leyendo anchos' } }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'inspect_cells()', description: 'Leyendo celdas' } }] },
    { content: 'Listo.' },
  ]);
  const repairs = [];
  const sameOutput = { [outputPath]: '100 1' };
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'corrige la legibilidad del Excel' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async verify_visual() { return 'ERROR: verificación fallida: encabezados cortados'; },
      async execute_python(args) { repairs.push(args.code); return 'ok\n[exit 0]'; },
      [office.OUTPUTS_SNAPSHOT]: async () => sameOutput,
    },
    maxIterations: 8,
  });
  assert.equal(result.stoppedReason, 'loop_oscillation_cut');
  assert.deepEqual(repairs, ['inspect_widths()'], 'the next read-only call is cut before execution');
  assert.equal(result.steps.find((step) => step.tool === 'execute_python')?.mutated, false);
});

test('loop: two failed visual checks still cut a repeated repair cycle', async () => {
  const verifyArgs = { after: 'outputs/encuesta_20x20.xlsx', checklist: ['Encabezados completos'] };
  const repairArgs = { code: 'adjust_column_widths()' };
  const client = scriptedClient([
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: repairArgs }] },
    { toolCalls: [{ name: 'verify_visual', args: verifyArgs }] },
    { toolCalls: [{ name: 'execute_python', args: repairArgs }] },
    { content: 'Listo.' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'corrige el Excel' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async verify_visual() { return 'ERROR: verificación fallida: encabezados ilegibles'; },
      async execute_python() { return 'ok\n[exit 0]'; },
    },
    maxIterations: 8,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.stoppedReason, 'loop_oscillation_cut');
  assert.equal(events.some((event) => event.type === 'final'), false);
});

test('turn-failure hook: silent no-op without the tracker; reports once per (tool, reason) with it', async () => {
  const none = hook.createOfficeFailureReporter({ userId: 'u1', chatId: 'c1', loader: () => null });
  assert.equal(await none({ tool: 'verify_visual', code: 'engine_missing', error: 'x' }), false);

  const recorded = [];
  const tracker = { recordTurnFailure: async (payload) => { recorded.push(payload); } };
  const report = hook.createOfficeFailureReporter({ userId: 'u1', chatId: 'c1', loader: () => tracker });
  assert.equal(await report({ tool: 'verify_visual', code: 'timeout', error: 'el motor tardó más de 170 s' }), true);
  assert.equal(await report({ tool: 'verify_visual', code: 'timeout', error: 'otra vez' }), false, 'deduped per turn');
  assert.equal(await report({ tool: 'office_edit', code: 'timeout', error: 'x' }), true);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].category, 'herramienta_fallida');
  assert.equal(recorded[0].reason, 'timeout');
  assert.equal(recorded[0].code, 'timeout');
  assert.equal(recorded[0].userId, 'u1');
  assert.equal(recorded[0].chatId, 'c1');

  const throwing = hook.createOfficeFailureReporter({ loader: () => ({ recordTurnFailure: () => { throw new Error('db down'); } }) });
  assert.equal(await throwing({ tool: 'x', code: 'y' }), false, 'a broken tracker never breaks the turn');
});

test('turn-failure hook: speaks the tracker turn API — noteTurn(tool_failure) joins the current turn', async () => {
  const notes = [];
  const tracker = {
    noteTurn: (kind, data) => { notes.push({ kind, data }); },
    // When both exist the turn-context API wins (one note per failure).
    recordTurnFailure: () => { throw new Error('must not be called when noteTurn exists'); },
  };
  const report = hook.createOfficeFailureReporter({ userId: 'u1', chatId: 'c1', loader: () => tracker });
  assert.equal(await report({ tool: 'render_preview', code: 'engine_missing', error: 'no está el motor' }), true);
  assert.equal(await report({ tool: 'render_preview', code: 'engine_missing', error: 'otra vez' }), false, 'deduped per turn');
  assert.equal(await report(hook.verificationFailureFromSteps([
    { tool: 'office_edit', ok: true },
    { tool: 'verify_visual', ok: false, resultPreview: 'ERROR ✗' },
  ])), true);
  assert.deepEqual(notes.map((n) => n.kind), ['tool_failure', 'tool_failure']);
  assert.equal(notes[0].data.tool, 'render_preview');
  assert.equal(notes[0].data.reason, 'engine_missing');
  assert.equal(notes[0].data.fatal, false, 'an infra failure the loop may recover from is context, not a failed turn');
  assert.equal(notes[1].data.reason, 'verificacion_fallida');
  assert.equal(notes[1].data.fatal, true, 'an edit delivered with its verification failed is a failed turn');
  assert.equal(notes[1].data.detail.attempts, 1);

  const brokenNote = hook.createOfficeFailureReporter({ loader: () => ({ noteTurn: () => { throw new Error('als gone'); } }) });
  assert.equal(await brokenNote({ tool: 'x', code: 'y' }), false, 'a broken tracker never breaks the turn');

  const noRenderer = hook.verificationFailureFromSteps([
    { tool: 'office_edit', ok: true },
    { tool: 'verify_visual', ok: false, renderUnavailable: true },
  ]);
  assert.equal(noRenderer.code, 'renderizador_no_disponible');
  assert.equal(noRenderer.fatal, true);
});

test('turn-failure hook: a turn that ends with its last verify_visual failed is reportable', () => {
  const edited = { tool: 'office_edit', ok: true };
  assert.equal(hook.verificationFailureFromSteps([]), null);
  assert.equal(hook.verificationFailureFromSteps([edited]), null, 'no verification → nothing to judge here (gate v2 is Fase C)');
  assert.equal(hook.verificationFailureFromSteps([edited, { tool: 'verify_visual', ok: false }, { tool: 'verify_visual', ok: true }]), null);
  const failed = hook.verificationFailureFromSteps([
    edited,
    { tool: 'verify_visual', ok: false },
    { tool: 'office_edit', ok: true },
    { tool: 'verify_visual', ok: false },
    { tool: 'verify_visual', ok: false, resultPreview: 'ERROR: verificación fallida ✗ 2025' },
  ]);
  assert.equal(failed.code, 'verificacion_fallida');
  assert.equal(failed.fatal, true);
  assert.equal(failed.detail.attempts, 3);
  assert.equal(hook.verificationFailureFromSteps([{ tool: 'verify_visual', ok: false }]), null, 'no edit → nothing delivered unverified');
});

test('runner wiring: executors get the per-turn reporter; failed final verification is reported', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/agent-runner/index.js'), 'utf8');
  assert.match(src, /const reportOfficeFailure = createOfficeFailureReporter\(\{ userId, chatId \}\);/);
  assert.match(src, /makeToolExecutors\(toolSandbox, \{\s*office: \{\s*onFailure: reportOfficeFailure,/);
  assert.match(src, /verificationFailureFromSteps\(result && result\.steps\)/);
});
