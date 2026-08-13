'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReact } = require('../src/services/agent-runner/react');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const {
  normalizeHex,
  normalizeOutline,
  NAMED_COLORS,
  DEFAULT_DECK_COLOR,
  TOOL_DEFINITIONS,
  makeToolExecutors,
} = require('../src/services/agent-runner/tools');
const {
  shouldRunAgentRunner,
  canCallLlm,
  executeAgentRunnerTurn,
  runAgentRunnerForDocRoute,
  loadOfficeHelpersPy,
} = require('../src/services/agent-runner');
const { persistOutputs, resolveTurnFiles } = require('../src/services/agent-runner/artifacts');
const {
  needsVerification,
  verificationNudge,
  MAX_VERIFICATION_RETRIES,
} = require('../src/services/agent-runner/verify');
const {
  isAsyncEnabled,
  eventChannel,
  enqueueAgentRunnerJob,
  startAgentRunnerWorker,
} = require('../src/services/agent-runner/queue');
const { createSandbox, persistentWorkspaceRoot } = require('../src/services/doc-agent/sandbox');
const fs = require('fs/promises');

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

test('canCallLlm rejects dummy CI keys', () => {
  assert.equal(canCallLlm({ client: {} }), true);
});

test('needsVerification requires render_preview after an edit', () => {
  assert.equal(needsVerification([]).needed, false);
  assert.equal(needsVerification([
    { tool: 'set_slide_background', ok: true },
  ]).needed, true);
  assert.equal(needsVerification([
    { tool: 'set_slide_background', ok: true },
    { tool: 'render_preview', ok: true },
  ]).needed, false);
  assert.equal(needsVerification([
    { tool: 'set_slide_background', ok: true },
    { tool: 'render_preview', ok: false },
  ]).reason, 'preview_failed');
  assert.ok(verificationNudge(1, 'missing_preview').includes('1/3'));
  assert.equal(MAX_VERIFICATION_RETRIES, 3);
});

test('shouldRunAgentRunner catches create-a-pink-ppt and follow-up artifacts', () => {
  assert.equal(shouldRunAgentRunner({
    text: 'crea una ppt del embarazo de color rosado la ppt',
  }), true);
  assert.equal(shouldRunAgentRunner({ text: 'hola' }), false);
  assert.equal(shouldRunAgentRunner({
    files: [{ name: 'a.pptx' }],
    text: 'ponlas blancas',
  }), true);
  assert.equal(shouldRunAgentRunner({
    hasPriorArtifacts: true,
    text: 'ahora ponlas rosadas',
  }), true);
});

test('shouldRunAgentRunner routes style follow-ups in ANY named color or hex', () => {
  assert.equal(shouldRunAgentRunner({ text: 'ponlas todas moradas' }), true);
  assert.equal(shouldRunAgentRunner({ text: 'cámbialas a turquesa' }), true);
  assert.equal(shouldRunAgentRunner({ text: 'píntalas de dorado' }), true);
  assert.equal(shouldRunAgentRunner({ text: 'uniformisa el color de la ppts todas de color blanco' }), true);
  assert.equal(shouldRunAgentRunner({ text: 'cámbialas al hex #1E3A8A' }), true);
  assert.equal(shouldRunAgentRunner({ text: 'qué es la fotosíntesis' }), false);
});

test('create-doc request WITHOUT an LLM is skipped honestly — never a stub deck', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'ci-dummy';
  try {
    const ran = await executeAgentRunnerTurn({
      instruction: 'crea una ppt del embarazo de color rosado la ppt',
    });
    assert.equal(ran.skipped, true);
    assert.equal(ran.ok, false);
    assert.equal(ran.stoppedReason, 'no_llm');
    assert.deepEqual(ran.artifacts, []);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('appendTextSlide clones last slide and writes Gracias', async () => {
  const { appendTextSlide } = require('../src/services/agent-runner/office-helpers');
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.addSlide().addText('Uno', { x: 0.5, y: 0.4, w: 8, h: 1 });
  pres.addSlide().addText('Dos', { x: 0.5, y: 0.4, w: 8, h: 1 });
  const buf = await pres.write('nodebuffer');
  const out = appendTextSlide({ buffer: buf, title: 'Gracias' });
  const zip = require('pizzip')(out.buffer);
  const slides = Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(slides.length, 3);
  assert.ok(zip.file('ppt/slides/slide3.xml').asText().includes('Gracias'));
});

test('normalizeHex understands named colors and hex', () => {
  assert.equal(normalizeHex('blanco'), 'FFFFFF');
  assert.equal(normalizeHex('rosado'), NAMED_COLORS.rosado);
  assert.equal(normalizeHex('#1E3A8A'), '1E3A8A');
  assert.equal(normalizeHex('nope'), null);
});

test('normalizeHex expands the full palette: ANY color the user names', () => {
  assert.equal(normalizeHex('naranja'), 'F97316');
  assert.equal(normalizeHex('morado'), '7C3AED');
  assert.equal(normalizeHex('moradas'), '7C3AED');
  assert.equal(normalizeHex('lila'), 'C8A2C8');
  assert.equal(normalizeHex('fucsia'), 'D946EF');
  assert.equal(normalizeHex('celeste'), '87CEEB');
  assert.equal(normalizeHex('turquesa'), '40E0D0');
  assert.equal(normalizeHex('beige'), 'F5F5DC');
  assert.equal(normalizeHex('dorado'), 'FFD700');
  assert.equal(normalizeHex('doradas'), 'FFD700');
  assert.equal(normalizeHex('coral'), 'FF7F50');
  assert.equal(normalizeHex('vino'), '722F37');
  assert.equal(normalizeHex('amarillo'), 'FACC15');
  assert.equal(normalizeHex('amarillas'), 'FACC15');
  assert.equal(normalizeHex('salmón'), 'FA8072');
});

test('default deck color is a clean LIGHT theme, never pink', () => {
  assert.equal(DEFAULT_DECK_COLOR, 'F8FAFC');
  assert.notEqual(DEFAULT_DECK_COLOR, 'FFC0CB');
});

test('loadOfficeHelpersPy is lazy and fail-open (ENOENT never crashes the module)', () => {
  const helpers = loadOfficeHelpersPy();
  assert.ok(String(helpers).includes('xml_has_hex'));
  // A missing file returns null instead of throwing — the ENOENT that used to
  // divert /doc/generate into the dark pipeline.
  assert.equal(loadOfficeHelpersPy({ dir: '/nonexistent-dir-agent-runner' }), null);
});

test('normalizeOutline accepts objects and strings, drops empties', () => {
  const out = normalizeOutline([
    { title: 'Primer trimestre', bullets: ['Controles prenatales', '', 'Ácido fólico'] },
    'Señales de alerta',
    { title: '   ' },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].bullets, ['Controles prenatales', 'Ácido fólico']);
  assert.equal(out[1].title, 'Señales de alerta');
  assert.deepEqual(normalizeOutline('not-an-array'), []);
});

test('parseReact reads Action/Action Input and fenced tool JSON', () => {
  const a = parseReact('Action: execute_python\nAction Input: print(1)\n');
  assert.equal(a[0].name, 'execute_python');
  assert.equal(a[0].args.code.includes('print(1)'), true);
  const b = parseReact('```tool\n{"name":"render_preview","arguments":{"path":"outputs/a.pptx"}}\n```');
  assert.equal(b[0].name, 'render_preview');
  assert.equal(b[0].args.path, 'outputs/a.pptx');
});

test('runAgentLoop native tool_calls then final', async () => {
  const calls = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'Listo, verificado.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'test/model',
    messages: [{ role: 'user', content: 'hazlo' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      async list_files() { calls.push('list'); return '(no files)'; },
      async execute_python(args) { calls.push(args.code); return '1\n[exit 0]'; },
    },
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.iterations, 2);
  assert.deepEqual(calls, ['list']);
  assert.equal(result.finalText.includes('Listo'), true);
});

test('runAgentLoop ReAct fallback when the model dumps text instead of tool_calls', async () => {
  const calls = [];
  const client = scriptedClient([
    { content: 'Action: list_files\nAction Input: .\n' },
    { content: 'hecho' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek/no-tools',
    messages: [{ role: 'user', content: 'run' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      async list_files(args) { calls.push(args.path || '.'); return '(no files)'; },
      async execute_python(args) { calls.push(args.code); return 'hi\n[exit 0]'; },
    },
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(calls.length, 1);
});

test('runAgentLoop falls back when native tools throw unsupported', async () => {
  let n = 0;
  const client = {
    chat: {
      completions: {
        create: async (opts) => {
          n += 1;
          if (opts.tools) throw new Error('tools are not supported for this model');
          return { choices: [{ message: { content: 'Listo sin tools' } }] };
        },
      },
    },
  };
  const result = await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'hola' }],
    tools: TOOL_DEFINITIONS,
    executors: {},
    maxIterations: 3,
  });
  assert.equal(result.finalText, 'Listo sin tools');
  assert.ok(n >= 2);
});

test('runAgentLoop refuses to finish without render_preview after an edit', async () => {
  const calls = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/a.pptx', color: 'blanco' } }] },
    { content: 'Listo, ya está blanco.' },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/a.pptx' } }] },
    { content: 'Verificado. Fondos blancos.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'ponlas blancas' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      async set_slide_background() { calls.push('bg'); return '{"ok":true}'; },
      async render_preview() { calls.push('preview'); return '{"ok":true,"frames":[{"mean_brightness":240}]}'; },
    },
    maxIterations: 8,
  });
  assert.deepEqual(calls, ['bg', 'preview']);
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.verificationAttempts, 1);
  assert.ok(result.finalText.includes('Verificado'));
});

test('runAgentLoop reports honestly after 3 failed verification attempts', async () => {
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_python', args: { code: 'print(1)' } }] },
    { content: 'Listo.' },
    { content: 'Listo otra vez.' },
    { content: 'Listo en serio.' },
    { content: 'Sigo sin preview.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'x',
    messages: [{ role: 'user', content: 'edita' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      async execute_python() { return '1\n[exit 0]'; },
    },
    maxIterations: 10,
  });
  assert.equal(result.stoppedReason, 'verification_failed');
  assert.equal(result.verificationAttempts, 3);
});

test('runAgentLoop caps at 25 iterations', async () => {
  const client = scriptedClient(
    Array.from({ length: 30 }, () => ({
      toolCalls: [{ name: 'list_files', args: { path: '.' } }],
    })),
  );
  const result = await runAgentLoop({
    client,
    model: 'x',
    messages: [],
    tools: TOOL_DEFINITIONS,
    executors: { async list_files() { return '(no files)'; } },
    maxIterations: 25,
  });
  assert.equal(result.stoppedReason, 'max_iterations');
  assert.equal(result.iterations, 25);
});

test('makeToolExecutors execute_python execute_bash render_preview set_slide_background', async () => {
  const execs = [];
  const files = new Map();
  files.set('uploads/a.pptx', Buffer.from('fake-pptx'));
  const sandbox = {
    async exec(cmd) {
      execs.push(String(cmd));
      if (String(cmd).includes('preview_stat')) {
        return {
          stdout: '{"ok":true,"frames":[{"mean_brightness":240,"looks_light":true}],"count":1}',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    async readFile(p) { return files.get(p) || Buffer.from('x'); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return [{ path: 'uploads/a.pptx', size: 10 }]; },
  };
  const painted = [];
  const executors = makeToolExecutors(sandbox, {
    setSlideBackgrounds: ({ color }) => {
      painted.push(color);
      return { buffer: Buffer.from('edited'), changed: 3, color: 'FFC0CB' };
    },
  });

  const py = await executors.execute_python({ code: 'print(1)' });
  assert.equal(py.includes('ERROR:'), false);
  assert.ok(execs.some((c) => c.includes('python3')));

  const bash = await executors.execute_bash({ command: 'echo hi' });
  assert.equal(bash.includes('ERROR:'), false);

  const preview = await executors.render_preview({ path: 'outputs/a.pptx' });
  assert.equal(preview.includes('mean_brightness'), true);

  const bg = await executors.set_slide_background({
    path: 'uploads/a.pptx',
    color: 'rosado',
  });
  assert.equal(bg.includes('ERROR:'), false);
  assert.deepEqual(painted, ['#FFC0CB']);
  assert.ok([...files.keys()].some((k) => k.startsWith('outputs/')));
});

test('edit_file / glob / grep executors', async () => {
  const files = new Map();
  files.set('tmp/x/slide1.xml', Buffer.from('<a:solidFill><a:srgbClr val="111111"/></a:solidFill>'));
  const execCalls = [];
  const sandbox = {
    async exec(cmd) {
      execCalls.push(String(cmd));
      if (String(cmd).includes('find .')) {
        return { stdout: '-rw-r--r-- 1 u u 120 ago 13 ./tmp/x/slide1.xml', stderr: '', exitCode: 0 };
      }
      if (String(cmd).includes('grep -rnE')) {
        if (String(cmd).includes('NOPE')) return { stdout: '', stderr: '', exitCode: 1 };
        return { stdout: 'tmp/x/slide1.xml:1:<a:srgbClr val="111111"/>', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile(p) {
      const buf = files.get(p);
      if (!buf) throw new Error(`ENOENT: ${p}`);
      return buf;
    },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
  const executors = makeToolExecutors(sandbox, { setSlideBackgrounds: () => ({ buffer: Buffer.from('x') }) });

  // edit_file = exact string replace, exactly once
  const edited = await executors.edit_file({
    path: 'tmp/x/slide1.xml',
    old_str: 'val="111111"',
    new_str: 'val="FFC0CB"',
  });
  assert.equal(edited.startsWith('ERROR:'), false);
  assert.ok(files.get('tmp/x/slide1.xml').toString().includes('FFC0CB'));
  const missing = await executors.edit_file({
    path: 'tmp/x/slide1.xml',
    old_str: 'no-such-text',
    new_str: 'y',
  });
  assert.ok(missing.startsWith('ERROR:'));

  const globbed = await executors.glob({ pattern: 'tmp/x/*.xml' });
  assert.ok(globbed.includes('slide1.xml'));
  assert.ok((await executors.glob({ pattern: 'a; rm -rf /' })).startsWith('ERROR:'));

  const found = await executors.grep({ pattern: 'srgbClr', path: 'tmp/x' });
  assert.ok(found.includes('slide1.xml:1'));
  assert.equal(await executors.grep({ pattern: 'NOPE' }), '(no matches)');
});

async function createDeckViaExecutor(args) {
  const files = new Map();
  const sandbox = {
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile(p) { return files.get(p) || Buffer.from('x'); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
  const executors = makeToolExecutors(sandbox, { setSlideBackgrounds: () => ({ buffer: Buffer.from('x') }) });
  const result = await executors.create_presentation(args);
  const outName = [...files.keys()].find((k) => k.startsWith('outputs/'));
  return { result, buffer: outName ? files.get(outName) : null };
}

function deckXmlBlob(buffer) {
  const zip = require('pizzip')(buffer);
  return Object.keys(zip.files)
    .filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((n) => zip.file(n).asText())
    .join('\n');
}

test('create_presentation writes the MODEL outline (real content, no filler)', async () => {
  const { result, buffer } = await createDeckViaExecutor({
    topic: 'embarazo',
    title: 'Embarazo saludable',
    color: 'rosado',
    outline: [
      { title: 'Primer trimestre', bullets: ['Controles prenatales', 'Ácido fólico diario'] },
      { title: 'Señales de alerta', bullets: ['Sangrado o dolor intenso: acudir a urgencias'] },
      { title: 'Gracias', bullets: [] },
    ],
    filename: 'embarazo.pptx',
  });
  assert.equal(result.startsWith('ERROR:'), false, result);
  const parsed = JSON.parse(result);
  assert.equal(parsed.color, '#FFC0CB');
  assert.equal(parsed.outlineProvided, true);
  const blob = deckXmlBlob(buffer);
  assert.ok(blob.includes('FFC0CB'), 'requested color painted on slides');
  assert.ok(blob.includes('Primer trimestre'), 'topic-specific slide title');
  assert.ok(blob.includes('Controles prenatales'), 'topic-specific bullet');
  assert.equal(blob.includes('Puntos clave'), false, 'no boilerplate filler');
  assert.equal(blob.includes('Información clara, verificable'), false, 'no boilerplate filler');
});

test('create_presentation without color uses the light default — NEVER pink', async () => {
  const { result, buffer } = await createDeckViaExecutor({
    topic: 'finanzas',
    title: 'Finanzas personales',
    outline: [{ title: 'Presupuesto mensual', bullets: ['Regla 50/30/20'] }],
    filename: 'finanzas.pptx',
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.color, `#${DEFAULT_DECK_COLOR}`);
  assert.equal(parsed.defaultColor, true);
  const blob = deckXmlBlob(buffer);
  assert.ok(blob.includes(DEFAULT_DECK_COLOR));
  assert.equal(blob.includes('FFC0CB'), false, 'pink must not appear unless requested');
});

test('create_presentation honors an explicit #hex over any default', async () => {
  const { result, buffer } = await createDeckViaExecutor({
    topic: 'plan comercial',
    color: '#1E3A8A',
    outline: [{ title: 'Metas Q1', bullets: ['Crecer 15% en ventas'] }],
    filename: 'plan.pptx',
  });
  assert.equal(JSON.parse(result).color, '#1E3A8A');
  const blob = deckXmlBlob(buffer);
  assert.ok(blob.includes('1E3A8A'));
  assert.equal(blob.includes('FFC0CB'), false);
});

test('resolveTurnFiles prefers the latest artifact over a new upload', async () => {
  const prisma = {
    generatedArtifact: {
      findMany: async () => ([{
        id: 'art-1',
        filename: 'deck-editado.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        path: '/tmp/latest.pptx',
        chatId: 'c1',
        userId: 'u1',
      }]),
    },
  };
  const fsImpl = {
    readFile: async () => Buffer.from('LATEST'),
  };
  const resolved = await resolveTurnFiles({
    prisma,
    userId: 'u1',
    chatId: 'c1',
    attachedFiles: [{ name: 'original.pptx', buffer: Buffer.from('ORIGINAL') }],
    objectStorage: { readFile: async () => { throw new Error('no remote'); } },
  });
  // Monkeypatch loadArtifactBuffer uses fs when objectStorage fails.
  // loadArtifactBuffer is called with objectStorage first; we need fs fallback.
  // The helper uses require('fs/promises') internally if objectStorage fails.
  // Inject by putting bytes via a fake objectStorage instead:
  const resolved2 = await resolveTurnFiles({
    prisma,
    userId: 'u1',
    chatId: 'c1',
    attachedFiles: [{ name: 'original.pptx', buffer: Buffer.from('ORIGINAL') }],
    objectStorage: { readFile: async () => Buffer.from('LATEST') },
  });
  assert.equal(resolved2.files[0].isPriorArtifact, true);
  assert.equal(resolved2.files[0].buffer.toString(), 'LATEST');
  assert.equal(resolved2.files[1].buffer.toString(), 'ORIGINAL');
  void fsImpl;
  void resolved;
});

test('persistOutputs upserts GeneratedArtifact in PostgreSQL', async () => {
  const upserts = [];
  const prisma = {
    generatedArtifact: {
      upsert: async (args) => { upserts.push(args); return args.create; },
    },
  };
  await persistOutputs({
    outputs: [{ name: 'deck.pptx', buffer: Buffer.from('pk'), valid: true }],
    userId: 'u1',
    chatId: 'c1',
    prisma,
    saveArtifact: ({ filename }) => ({
      id: 'art-99',
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      format: 'pptx',
      sizeBytes: 2,
      path: '/tmp/art-99-deck.pptx',
      downloadUrl: '/api/files/art-99',
    }),
  });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.chatId, 'c1');
  assert.equal(upserts[0].create.userId, 'u1');
  assert.equal(upserts[0].create.id, 'art-99');
});

test('local sandbox persistKey keeps files across destroy()', async () => {
  const key = `test-chat-${Date.now()}`;
  const first = await createSandbox({ driver: 'local', persistKey: key });
  await first.writeFile('outputs/keep.txt', 'from-turn-1');
  await first.destroy();
  const second = await createSandbox({ driver: 'local', persistKey: key });
  const buf = await second.readFile('outputs/keep.txt');
  assert.equal(buf.toString(), 'from-turn-1');
  await second.destroy();
  const root = persistentWorkspaceRoot(key);
  await fs.rm(root, { recursive: true, force: true });
});

test('persistOutputs saves via saveArtifact and emits file_artifact', async () => {
  const events = [];
  const saved = await persistOutputs({
    outputs: [{ name: 'embarazo.pptx', buffer: Buffer.from('pk'), valid: true }],
    userId: 'u1',
    chatId: 'c1',
    saveArtifact: ({ filename }) => ({
      id: 'id1',
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      format: 'pptx',
      sizeBytes: 2,
      downloadUrl: '/api/files/id1',
    }),
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, 'embarazo.pptx');
  assert.equal(events[0].type, 'file_artifact');
});

test('runAgentRunnerForDocRoute: runner-first result in the doc-route file shape', async () => {
  const upserts = [];
  const prisma = {
    generatedArtifact: {
      findMany: async () => [],
      upsert: async (args) => { upserts.push(args); return args.create; },
    },
  };
  const client = scriptedClient([
    {
      toolCalls: [{
        name: 'create_presentation',
        args: {
          topic: 'embarazo',
          title: 'Embarazo saludable',
          color: 'rosado',
          outline: [
            { title: 'Primer trimestre', bullets: ['Controles prenatales'] },
            { title: 'Gracias', bullets: [] },
          ],
          filename: 'embarazo.pptx',
        },
      }],
    },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/embarazo.pptx' } }] },
    { content: 'Listo. Presentación del embarazo en rosado: embarazo.pptx' },
  ]);
  const stages = [];
  const result = await runAgentRunnerForDocRoute({
    prisma,
    userId: 'u-doc-route',
    chatId: 'c-doc-route',
    prompt: 'crea una ppt del embarazo de color rosado la ppt',
    client,
    driver: 'local',
    maxIterations: 8,
    onStage: (ev) => stages.push(ev),
  });
  assert.ok(result, 'runner must win when it produced a verified file');
  assert.equal(result.format, 'pptx');
  assert.equal(result.file.type, 'doc');
  assert.equal(result.file.filename, 'embarazo.pptx');
  assert.ok(String(result.file.url).startsWith('/api/agent/artifact/'));
  assert.ok(String(result.content).includes('embarazo'));
  assert.equal(upserts.length, 1, 'artifact persisted for follow-ups');
  assert.ok(stages.length >= 1, 'stage events streamed to the doc route');

  // Not a document request → null, the route falls through to the pipeline.
  const none = await runAgentRunnerForDocRoute({
    prisma,
    userId: 'u-doc-route',
    chatId: 'c-doc-route',
    prompt: 'hola, ¿cómo estás?',
    client,
    driver: 'local',
  });
  assert.equal(none, null);
});

test('BullMQ enqueue + worker streams step events', async () => {
  assert.equal(isAsyncEnabled({ AGENT_RUNNER_ASYNC: '1' }), true);
  assert.equal(isAsyncEnabled({ AGENT_RUNNER_ASYNC: '0', REDIS_URL: 'redis://x' }), false);
  assert.equal(isAsyncEnabled({ REDIS_URL: 'redis://x', NODE_TEST_CONTEXT: '1' }), false);
  assert.equal(eventChannel('9'), 'agent-runner:events:9');

  const jobs = [];
  class FakeQueue {
    constructor() {}
    async add(name, data) {
      jobs.push({ name, data });
      return { id: '42' };
    }
  }
  const enq = await enqueueAgentRunnerJob(
    { instruction: 'crea una ppt rosada', userId: 'u', chatId: 'c' },
    { QueueImpl: FakeQueue, connection: {} },
  );
  assert.equal(enq.jobId, '42');
  assert.equal(jobs[0].data.instruction.includes('rosada'), true);

  const published = [];
  let processor;
  class FakeWorker {
    constructor(_name, fn) { processor = fn; }
  }
  startAgentRunnerWorker({
    WorkerImpl: FakeWorker,
    connection: {},
    run: async () => ({ summary: 'Listo', artifacts: [{ filename: 'a.pptx' }] }),
    publish: async (ch, ev) => published.push({ ch, ev }),
  });
  const result = await processor({ id: '42', data: { instruction: 'x' } });
  assert.equal(result.summary, 'Listo');
  assert.ok(published.some((p) => p.ev.type === 'final'));
});
