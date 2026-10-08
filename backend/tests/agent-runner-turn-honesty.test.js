'use strict';

/**
 * Edición milimétrica — Fase G, hallazgos de producción del runner:
 *
 *   - «ponlas todas de color verde oscuro»: el modelo pidió la misma
 *     herramienta varias veces en un lote y el guardia anti-bucle lo tomó por
 *     un ciclo del plan (auto-arista A→A): el turno se cortó en la iteración 1…
 *   - …y el archivo que el turno ANTERIOR dejó en outputs/ (workspace
 *     persistente del chat) se entregó como «Listo. Generé …» sin cambios.
 *   - La última versión de un artefacto guardado en R2 no se podía releer
 *     (object-storage no tiene readFile): el seguimiento corría sin el archivo.
 *   - El runner sigue al modelo elegido también en /api/doc/generate y en
 *     /api/agent/task (y en la cola asíncrona).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const w65 = require('../src/services/agent-runner/engine-3h65');
const ad = require('../src/services/agent-runner/engine-adapter');
const runner = require('../src/services/agent-runner');
const { loadArtifactBuffer } = require('../src/services/agent-runner/artifacts');

function guard(calls) {
  return w65.applyAntiLoopGuardsClosed({
    calls: calls.map((name) => ({ name })),
    detectDagCycle: ad.detectDagCycle,
    rejectToolCallCycleAtoBtoA: ad.rejectToolCallCycleAtoBtoA,
  });
}

test('anti-loop: the same tool several times in one batch is parallel work, not a plan cycle', () => {
  assert.equal(guard(['set_slide_background', 'set_slide_background', 'set_slide_background']).halt, false);
  assert.equal(guard(['office_edit', 'office_edit']).halt, false);
  assert.equal(guard(['inspect_document', 'office_edit', 'office_edit', 'verify_visual']).halt, false);
  // A real A→B→A cycle still stops the turn.
  assert.equal(guard(['read_file', 'write_file', 'read_file']).halt, true);
});

test('a persistent workspace never re-delivers the previous turn output as this turn\'s result', async () => {
  const old = Buffer.from('deck v1');
  const files = [{ name: 'ciclo-del-agua.pptx', buffer: old }];
  const sandbox = { persistent: true, collectOutputs: async () => files.map((f) => ({ ...f })) };
  const previous = await runner.fingerprintOutputs(sandbox);
  assert.equal(previous.size, 1);
  const events = [];
  // The loop stopped before editing: the same bytes are still there.
  assert.deepEqual(runner.dropPreviousTurnOutputs(await sandbox.collectOutputs(), previous, (e) => events.push(e)), []);
  assert.deepEqual(events.map((e) => e.reason), ['previous_turn_output']);
  // Edited in place (same name, new bytes) or a new file: delivered.
  files[0] = { name: 'ciclo-del-agua.pptx', buffer: Buffer.from('deck v2 verde') };
  files.push({ name: 'nuevo.docx', buffer: Buffer.from('x') });
  const kept = runner.dropPreviousTurnOutputs(await sandbox.collectOutputs(), previous);
  assert.deepEqual(kept.map((o) => o.name), ['ciclo-del-agua.pptx', 'nuevo.docx']);
  // An ephemeral sandbox starts empty: nothing to fingerprint.
  assert.equal((await runner.fingerprintOutputs({ persistent: false, collectOutputs: async () => files })).size, 0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/agent-runner/index.js'), 'utf8');
  // Every collection of the turn (fast path, after the loop, each retry) goes through the filter.
  assert.equal((src.match(/outputs = await collectTurnOutputs\(\);/g) || []).length, 3);
  assert.equal((src.match(/await collectValidOutputs\(sandbox, onEvent, editContext\)/g) || []).length, 1);
});

test('the latest artifact stored in R2 is read back through object-storage (no readFile there)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-r2-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'bc759ee29986d078';
  const bytes = Buffer.from('PK pptx bytes');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    ownerUserId: 'owner', chatId: 'chat', storageRef: 'r2:agent-artifacts/bc759ee29986d078-ciclo.pptx',
    storedRelPath: `${id}-ciclo.pptx`, filename: 'ciclo.pptx',
  }));
  const tmp = path.join(dir, 'r2-copy.pptx');
  let cleaned = false;
  const objectStorage = {
    isRemote: (ref) => String(ref).startsWith('r2:'),
    toLocalTemp: async (ref) => {
      assert.equal(ref, 'r2:agent-artifacts/bc759ee29986d078-ciclo.pptx');
      fs.writeFileSync(tmp, bytes);
      return { path: tmp, cleanup: async () => { cleaned = true; fs.rmSync(tmp, { force: true }); } };
    },
  };
  const row = { id, userId: 'owner', chatId: 'chat', filename: 'ciclo.pptx', path: '/app/uploads/agent-artifacts/gone.pptx' };
  assert.deepEqual(await loadArtifactBuffer(row, { artifactDir: dir, objectStorage }), bytes);
  assert.equal(cleaned, true, 'the temp copy is removed');
  // Owner / chat scoping still applies before touching storage.
  assert.equal(await loadArtifactBuffer({ ...row, userId: 'intruso' }, { artifactDir: dir, objectStorage }), null);
});

test('the runner follows the picked model on /api/doc/generate, /api/agent/task and the async queue', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const doc = read('src/routes/doc.js');
  assert.match(doc, /pickedModel: require\('\.\.\/services\/agent-runner'\)\s*\.runnerModelSpec\(resolveGenerateProvider\(req\.body\.provider, req\.body\.model\), req\.body\.model\)/);
  const task = read('src/services/agents/agent-task-runner.js');
  // The spec follows the runtime the task really runs on: the picker's
  // provider + model, or the fallback runtime after a remap (a bare claude-*
  // pick ran on DeepSeek and «Unresolved:deepseek-v4-flash» failed the
  // preflight, prod 2026-10-07). See agent-task-runner-remapped-runner-spec.
  assert.match(task, /pickedModel: runnerPickedModelSpec\(runtimeModelProfile, agentRunner\)/);
  assert.match(task, /return agentRunner\.runnerModelSpec\(provider, profile && profile\.runtimeModel\);/);
  const index = read('src/services/agent-runner/index.js');
  assert.match(index, /pickedModel: params\.pickedModel \|\| null,/);
  assert.match(read('src/services/agent-runner/queue.js'), /pickedModel: data\.pickedModel \|\| null,/);
  const orchestrator = read('src/services/agent-runner/orchestrator/index.js');
  assert.match(orchestrator, /llm = createRunnerLlmClient\(\{ pickedModel \}\);/);
  assert.match(orchestrator, /const run = await runOrchestrator\(\{[\s\S]*?pickedModel,/);
  assert.equal(runner.runnerModelSpec('DeepSeek', 'deepseek-v4-pro'), 'DeepSeek:deepseek-v4-pro');
});

test('a failed selected provider stops the document loop with E_PROVIDER', async () => {
  const events = [];
  const client = { chat: { completions: { create: async () => {
    const error = new Error('provider failed');
    error.code = 'E_PROVIDER';
    error.status = 402;
    throw error;
  } } } };
  const run = await runner.runAgentRunner({
    files: [],
    instruction: 'crea un documento Word sobre el ciclo del agua',
    client,
    driver: 'local',
    requireFileOutput: false,
    persistMemory: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(run.stoppedReason, 'E_PROVIDER');
  assert.equal(run.errorCode, 'E_PROVIDER');
  assert.match(run.errorMessage, /modelo seleccionado/i);
  assert.equal(events.filter((event) => event.type === 'error' && event.code === 'E_PROVIDER').length, 1);
  assert.equal(events.filter((event) => event.type === 'retry').length, 0);
  assert.equal(events.filter((event) => event.type === 'outputs').length, 0);
});

test('/api/doc/generate streams the runner rows as stage v2 and stores the timeline with the reply', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'src/routes/doc.js'), 'utf8');
  assert.match(doc, /const frame = \{ \.\.\.ev, type: 'stage', label: ev\.label \|\| 'Agente trabajando' \};\s*docTrace\.push\(frame\);\s*send\(frame\);/);
  assert.match(doc, /persistSuccess\(chatId, req\.user\.id, displayPrompt, content, file, \{\s*agentMetadata: docTrace\.toMetadata\(\),/);
  assert.match(doc, /persistFailure\(chatId, req\.user\.id, displayPrompt, reason, \{\s*agentMetadata: docTrace\.toMetadata\(\),/);
  assert.match(doc, /\.\.\.\(agentMetadata \? \{ agentMetadata \} : \{\}\),/);
  assert.match(doc, /code: agentRunnerResult\.reason === 'E_PROVIDER' \? 'E_PROVIDER' : 'agent_runner_failed'/);
});

test('a turn in a chat workspace starts with an empty outputs/: the previous files move to tmp/previous-outputs', async (t) => {
  const { createSandbox } = require('../src/services/doc-agent/sandbox');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-ws-'));
  const prev = process.env.SIRAGPT_AGENT_WORKSPACE_DIR;
  process.env.SIRAGPT_AGENT_WORKSPACE_DIR = base;
  t.after(() => {
    if (prev === undefined) delete process.env.SIRAGPT_AGENT_WORKSPACE_DIR; else process.env.SIRAGPT_AGENT_WORKSPACE_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const seed = await createSandbox({ driver: 'local', persistKey: 'chat-honesty' });
  await seed.exec('mkdir -p /workspace/outputs', { timeoutMs: 10_000 });
  await seed.writeFile('outputs/ciclo-del-agua.pptx', Buffer.from('deck v1'));
  await seed.destroy();

  // A turn whose model stops without writing anything (the dag_cycle case):
  // nothing is delivered, and the answer is not «Listo. Generé …».
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: 'No pude hacerlo.' } }] }) } } };
  const run = await runner.runAgentRunner({
    files: [], instruction: 'ponlas todas de color verde oscuro', client, driver: 'local', chatId: 'chat-honesty',
    requireFileOutput: false, persistMemory: false,
  });
  assert.deepEqual((run.outputs || []).map((o) => o.name), []);

  const after = await createSandbox({ driver: 'local', persistKey: 'chat-honesty' });
  try {
    assert.deepEqual((await after.collectOutputs()).map((o) => o.name), []);
    assert.equal(String(await after.readFile('tmp/previous-outputs/ciclo-del-agua.pptx')), 'deck v1', 'history is kept, only out of outputs/');
  } finally {
    await after.destroy();
  }
});

test('the paint fast path only recolors slide backgrounds when that is what was asked', async () => {
  // Eval pptx-nota-mover-verde: «ponla verde» (the note) painted every slide
  // background green in 9 s and never moved the note.
  assert.equal(runner.isSlideBackgroundColorRequest('Mueve la nota 2 mm a la derecha y ponla verde'), false);
  assert.equal(runner.isSlideBackgroundColorRequest('pon el título en azul'), false);
  assert.equal(runner.isSlideBackgroundColorRequest('cambia el fondo de la nota a verde'), false);
  assert.equal(runner.isSlideBackgroundColorRequest('colorea el gráfico de rojo'), false);
  const { buildScenarioBank } = require('./fixtures/agent-runner-scenarios');
  const paint = buildScenarioBank().filter((s) => s.family === 'style' || /^production-000[235]$/.test(s.id));
  assert.ok(paint.length > 200);
  for (const s of paint) assert.equal(runner.isSlideBackgroundColorRequest(s.text), true, s.text);

  // The deterministic path is skipped: the loop (the scripted model) handles it.
  const PizZip = require('pizzip');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  const deck = zip.generate({ type: 'nodebuffer' });
  const calls = [];
  const client = { chat: { completions: { create: async (req) => {
    calls.push(req);
    return { choices: [{ message: { role: 'assistant', content: 'No moví la nota: no la encontré.' } }] };
  } } } };
  const run = await runner.runAgentRunner({
    files: [{ name: 'defensa.pptx', buffer: deck }],
    instruction: 'Mueve la nota 2 mm a la derecha y ponla verde',
    client, driver: 'local', maxIterations: 2, requireFileOutput: false, persistMemory: false,
  });
  assert.notEqual(run.stoppedReason, 'fast_path');
  assert.ok(calls.length >= 1, 'the model was asked');
});

test('document turns get a longer loop wall than the 3H64 chat default (120 s)', async () => {
  const { runAgentLoop } = require('../src/services/agent-runner/loop');
  assert.equal(runner.documentTurnWallMs({}), 6 * 60_000);
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_TURN_WALL_MS: '90000' }), 90_000);
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_TURN_WALL_MS: '5' }), 6 * 60_000, 'nonsense values keep the default');
  // Creating a NEW document (research + outline + create + inspect + render +
  // vision + one correction round) gets its own, longer wall; the explicit
  // override still wins for both kinds (prod 2026-10-07: four creation turns
  // cut at 6 min with the deck built and nothing delivered).
  assert.equal(runner.documentTurnWallMs({}, { creatingNewFile: true }), 8 * 60_000);
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_CREATE_TURN_WALL_MS: '300000' }, { creatingNewFile: true }), 300_000);
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_CREATE_TURN_WALL_MS: '300000' }), 6 * 60_000, 'the creation knob never touches edits');
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_TURN_WALL_MS: '90000', SIRAGPT_AGENT_RUNNER_CREATE_TURN_WALL_MS: '300000' }, { creatingNewFile: true }), 90_000, 'the explicit wall wins for both kinds');
  assert.equal(runner.documentTurnWallMs({ SIRAGPT_AGENT_RUNNER_CREATE_TURN_WALL_MS: '5' }, { creatingNewFile: true }), 8 * 60_000, 'nonsense creation values keep the creation default');
  // The wall really is the one passed: 1 s cuts a slow two-step turn, 60 s does not.
  const slowClient = () => {
    let n = 0;
    return { chat: { completions: { create: async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 1100));
      return n === 1
        ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] }
        : { choices: [{ message: { role: 'assistant', content: 'Listo.' } }] };
    } } } };
  };
  const base = { model: 'x', messages: [{ role: 'user', content: 'lista' }], tools: [], executors: { async list_files() { return 'a.docx'; } }, maxIterations: 4 };
  const cut = await runAgentLoop({ ...base, client: slowClient(), turnWallMs: 1000 });
  assert.match(cut.stoppedReason, /^(turn_wall|wall_clock)$/);
  const ok = await runAgentLoop({ ...base, client: slowClient(), turnWallMs: 60_000 });
  assert.equal(ok.stoppedReason, 'final');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/agent-runner/index.js'), 'utf8');
  assert.equal((src.match(/turnWallMs: documentTurnWallMs\(process\.env, \{ creatingNewFile \}\),/g) || []).length, 2, 'main loop and output retries size the wall by turn kind');
  assert.doesNotMatch(src, /turnWallMs: documentTurnWallMs\(\),/, 'no call site ignores the turn kind');
});

test('«ya estaba así»: an unchanged office_edit needs no verification, no output retry, and the editor answers with the model text', async () => {
  const { needsVerification } = require('../src/services/agent-runner/verify');
  const unchanged = { tool: 'office_edit', ok: true, resultPreview: '{"unchanged":true,"note":"SIN CAMBIOS…","ok":true}' };
  const changed = { tool: 'office_edit', ok: true, resultPreview: '{"ok":true,"written":true}' };
  assert.equal(runner.noChangesNeeded([unchanged]), true);
  assert.equal(runner.noChangesNeeded([unchanged, changed]), false);
  assert.equal(runner.noChangesNeeded([]), false);
  assert.equal(needsVerification([unchanged], { strict: true }).needed, false, 'nothing changed → nothing to verify');
  assert.equal(needsVerification([changed], { strict: true }).needed, true);

  const { runChatDocumentEdit } = require('../src/services/document-editor/chat-document-editor');
  const USER = 'user-noop';
  const prisma = {
    file: { findMany: async (q) => [{ id: 'f1', userId: USER, originalName: 'tesis.docx' }].filter((r) => q.where.id.in.includes(r.id)) },
    message: { findMany: async () => [] },
  };
  const deps = {
    env: {},
    docxEngine: { docxEngineEnabled: () => true, editWordDocument: async () => { throw new Error('not for indent requests'); } },
    artifactDir: fs.mkdtempSync(path.join(os.tmpdir(), 'noop-')),
    objectStorage: { toLocalTemp: async () => { throw new Error('not remote'); } },
    readSourceBuffer: async () => ({ buffer: Buffer.from('PKdocx'), cleanup: async () => {} }),
    extractFileIds: () => [],
    saveArtifact: () => { throw new Error('nothing to save'); },
    runDocumentAgent: async () => ({ finalText: 'La introducción ya tiene sangría de primera línea de 1,25 cm y está justificada; no hice cambios.',
      outputs: [], stoppedReason: 'final', noChanges: true }),
    tryApplyLiteralDocxTitleEdit: async () => null,
    parseDocxPrecisionRequest: () => null,
    parseDocxImageRequest: () => null,
    makeVisualVerifier: () => null,
    log: () => {},
  };
  const res = await runChatDocumentEdit({ prisma, userId: USER, fileIds: ['f1'], llm: { client: {}, model: 'picked' }, deps,
    instruction: 'En la introducción pon sangría de primera línea de 1,25 cm y texto justificado.' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_CHANGES_NEEDED');
  assert.match(res.message, /ya tiene sangría/);
});

test('the picked model reaches a direct provider with its native id, never the aggregator slug', () => {
  // Production: «400 The supported API model names are deepseek-flash,
  // deepseek-v4-pro, but you passed deepseek/deepseek-v4-pro» on every
  // /generate runner turn picked with «DeepSeek V4 Pro».
  assert.equal(runner.runnerModelSpec('DeepSeek', 'deepseek/deepseek-v4-pro'), 'DeepSeek:deepseek-v4-pro');
  assert.equal(runner.runnerModelSpec('DeepSeek', 'deepseek-v4-pro'), 'DeepSeek:deepseek-v4-pro');
  assert.equal(runner.runnerModelSpec('Gemini', 'google/gemini-3.5-flash'), 'Gemini:gemini-3.5-flash');
  assert.equal(runner.runnerModelSpec('xAI', 'x-ai/grok-4.7'), 'xAI:grok-4.7');
  assert.equal(runner.runnerModelSpec('OpenRouter', 'deepseek/deepseek-v4-pro'), 'OpenRouter:deepseek/deepseek-v4-pro', 'OpenRouter keeps its slug');
  const { resolveDocAgentCandidates } = require('../src/services/doc-agent/llm-runtime');
  const first = resolveDocAgentCandidates({ model: runner.runnerModelSpec('DeepSeek', 'deepseek/deepseek-v4-pro'), env: { DEEPSEEK_API_KEY: 'k' } })[0];
  assert.deepEqual([first.provider, first.model], ['DeepSeek', 'deepseek-v4-pro']);
});
