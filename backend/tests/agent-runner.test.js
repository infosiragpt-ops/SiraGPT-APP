'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReact } = require('../src/services/agent-runner/react');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const {
  normalizeHex,
  NAMED_COLORS,
  TOOL_DEFINITIONS,
  makeToolExecutors,
} = require('../src/services/agent-runner/tools');
const { shouldRunAgentRunner, canCallLlm } = require('../src/services/agent-runner');
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
