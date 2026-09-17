'use strict';

/**
 * doc-agent — offline end-to-end + unit coverage.
 *
 * The E2E case mirrors the product spec exactly: a real .docx is generated,
 * the agent is asked «cambia el título a Informe Final y agrega un párrafo de
 * conclusiones», the FULL loop runs (scripted OpenAI-compatible client → real
 * tools → real local sandbox → real zip/XML edits), and the resulting .docx
 * is validated by unzipping it: the change exists, the old title is gone and
 * word/document.xml is still well-formed XML (checked with python3 minidom,
 * available on macOS dev + ubuntu CI).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

const {
  createSandbox,
  resolveInWorkspace,
  _createDockerSandbox,
} = require('../src/services/doc-agent/sandbox');
const { createRemoteSandbox } = require('../src/services/doc-agent/remote-sandbox');
const { TOOL_DEFINITIONS, makeToolExecutors } = require('../src/services/doc-agent/tools');
const { buildDocAgentSystemPrompt } = require('../src/services/doc-agent/skills');
const { runDocAgentLoop } = require('../src/services/doc-agent/loop');
const { runDocumentAgent, isValidOoxml } = require('../src/services/doc-agent');
const { parseZip } = require('../src/services/zip-parser');

/** OpenAI-compatible fake: returns the scripted responses in order. */
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
                  content: null,
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

async function makeSampleDocx() {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Informe Preliminar')] }),
        new Paragraph({ children: [new TextRun('El acompañamiento pedagógico fortalece la práctica docente en los CETPRO de Cusco.')] }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

test('E2E: edits a real docx through the full agentic loop and the OOXML stays valid', async () => {
  const docxBuffer = await makeSampleDocx();

  const repack = [
    'cd /workspace/tmp/x && python3 - <<\'PY\'',
    'import zipfile, os',
    "z = zipfile.ZipFile('/workspace/outputs/informe-editado.docx', 'w', zipfile.ZIP_DEFLATED)",
    "for dp, dn, fn in os.walk('.'):",
    '    for f in fn:',
    "        p = os.path.join(dp, f)",
    "        z.write(p, os.path.relpath(p, '.'))",
    'z.close()',
    'PY',
  ].join('\n');

  const script = [
    { toolCalls: [{ name: 'list_files', args: { path: 'uploads' } }] },
    { toolCalls: [{ name: 'bash', args: { command: "mkdir -p /workspace/tmp/x && cd /workspace/tmp/x && python3 -c \"import zipfile; zipfile.ZipFile('/workspace/uploads/informe.docx').extractall('.')\" && ls word/document.xml" } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'tmp/x/word/document.xml', limit: 3 } }] },
    { toolCalls: [{ name: 'str_replace', args: { path: 'tmp/x/word/document.xml', old_str: 'Informe Preliminar', new_str: 'Informe Final' } }] },
    { toolCalls: [{ name: 'str_replace', args: { path: 'tmp/x/word/document.xml', old_str: '</w:body>', new_str: '<w:p><w:r><w:t>Conclusiones: el acompañamiento pedagógico mejora de forma sostenida la práctica docente.</w:t></w:r></w:p></w:body>' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'outputs/NOTAS.txt', content: 'Título actualizado y conclusiones agregadas.' } }] },
    { toolCalls: [{ name: 'bash', args: { command: repack } }] },
    { content: 'Listo: cambié el título a "Informe Final" y agregué un párrafo de conclusiones. Entregable: informe-editado.docx' },
  ];

  const events = [];
  const result = await runDocumentAgent({
    files: [{ name: 'informe.docx', buffer: docxBuffer }],
    instruction: 'cambia el título a Informe Final y agrega un párrafo de conclusiones',
    client: scriptedClient(script),
    driver: 'local',
    onEvent: (e) => events.push(e),
  });

  // Loop behaviour.
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.driver, 'local');
  assert.ok(result.finalText.includes('Informe Final'));
  assert.equal(result.steps.filter((s) => !s.ok).length, 0, `failed steps: ${JSON.stringify(result.steps.filter((s) => !s.ok))}`);
  // All five tools exercised through the loop.
  const used = new Set(result.steps.map((s) => s.tool));
  for (const t of ['bash', 'read_file', 'write_file', 'str_replace', 'list_files']) assert.ok(used.has(t), `tool not exercised: ${t}`);
  // SSE-relayable events flowed.
  assert.ok(events.some((e) => e.type === 'sandbox_ready'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.ok));

  // Deliverables collected from /workspace/outputs.
  const names = result.outputs.map((o) => o.name).sort();
  assert.deepEqual(names, ['NOTAS.txt', 'informe-editado.docx']);

  // Validate the edited docx: unzip + content + well-formed OOXML.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-agent-verify-'));
  try {
    const outPath = path.join(tmp, 'informe-editado.docx');
    await fs.writeFile(outPath, result.outputs.find((o) => o.name === 'informe-editado.docx').buffer);

    const text = String(await parseZip(outPath));
    assert.ok(text.includes('Informe Final'), 'edited title must exist in the docx');
    assert.ok(text.includes('Conclusiones'), 'conclusions paragraph must exist in the docx');
    assert.ok(!text.includes('Informe Preliminar'), 'old title must be gone');

    // OOXML must still be well-formed XML (python3 minidom throws otherwise).
    await pexec('python3', ['-c',
      `import zipfile, xml.dom.minidom; xml.dom.minidom.parseString(zipfile.ZipFile(${JSON.stringify(outPath)}).read('word/document.xml'))`,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sandbox: path traversal and absolute paths are rejected', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    assert.throws(() => resolveInWorkspace(sandbox.root, '../../etc/passwd'), /escapes/);
    assert.throws(() => resolveInWorkspace(sandbox.root, '/etc/passwd'), /absolute/);
    const tools = makeToolExecutors(sandbox);
    const out = await tools.read_file({ path: '../../etc/passwd' });
    assert.match(out, /^ERROR:/);
  } finally {
    await sandbox.destroy();
  }
});

test('sandbox: command timeout is enforced and reported', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const r = await sandbox.exec('sleep 30', { timeoutMs: 1_000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
  } finally {
    await sandbox.destroy();
  }
});

test('loop forwards cancellation into an in-flight provider request', async () => {
  const controller = new AbortController();
  let providerSignal = null;
  const client = {
    chat: {
      completions: {
        create: async (_payload, options) => {
          providerSignal = options?.signal || null;
          return new Promise((resolve, reject) => {
            providerSignal.addEventListener('abort', () => {
              const error = providerSignal.reason instanceof Error
                ? providerSignal.reason
                : Object.assign(new Error('aborted'), { name: 'AbortError' });
              reject(error);
            }, { once: true });
            void resolve;
          });
        },
      },
    },
  };
  const running = runDocAgentLoop({
    client,
    model: 'fake',
    messages: [{ role: 'user', content: 'edita' }],
    tools: [],
    executors: {},
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const abortError = Object.assign(new Error('caller_cancelled'), { name: 'AbortError' });
  controller.abort(abortError);
  await assert.rejects(running, /caller_cancelled/);
  assert.equal(providerSignal, controller.signal);
});

test('loop rejects when cancellation happens inside a tool instead of returning partial success', async () => {
  const controller = new AbortController();
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'bash', args: { command: 'write partial output' } }] },
    { content: 'must never be returned' },
  ]);
  const running = runDocAgentLoop({
    client,
    model: 'fake',
    messages: [{ role: 'user', content: 'edita' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      bash: async () => {
        controller.abort(Object.assign(new Error('cancelled while editing'), { name: 'AbortError' }));
        return 'partial output';
      },
    },
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  await assert.rejects(running, /cancelled while editing/);
  assert.equal(events.some((event) => event.type === 'final'), false);
  assert.equal(events.some((event) => event.type === 'tool_result'), false);
});

test('bash executor classifies aborted and timed-out subprocesses as ERROR results', async () => {
  const aborted = makeToolExecutors({
    exec: async () => ({ stdout: 'partial', stderr: '', exitCode: 130, aborted: true, timedOut: false }),
  });
  assert.match(await aborted.bash({ command: 'edit' }), /^ERROR: sandbox command aborted/);

  const timedOut = makeToolExecutors({
    exec: async () => ({ stdout: '', stderr: '', exitCode: 124, aborted: false, timedOut: true }),
  });
  assert.match(await timedOut.bash({ command: 'edit' }), /^ERROR: sandbox command timed out/);
});

test('runDocumentAgent never returns or emits a partially written artifact after abort', async () => {
  const controller = new AbortController();
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'bash', args: { command: 'printf partial > /workspace/outputs/partial.txt; sleep 30' } }] },
    { content: 'must never complete' },
  ]);
  const running = runDocumentAgent({
    files: [{ name: 'input.txt', buffer: Buffer.from('original') }],
    instruction: 'edita el archivo',
    client,
    driver: 'local',
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  setTimeout(() => controller.abort(Object.assign(new Error('caller left'), { name: 'AbortError' })), 50);
  await assert.rejects(running, /caller left/);
  assert.equal(events.some((event) => event.type === 'outputs'), false);
  assert.equal(events.some((event) => event.type === 'final'), false);
});

test('local sandbox kills an in-flight process when its parent signal aborts', async () => {
  const controller = new AbortController();
  const sandbox = await createSandbox({ driver: 'local', signal: controller.signal });
  try {
    const startedAt = Date.now();
    const running = sandbox.exec('sleep 30', { timeoutMs: 60_000 });
    setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' })), 50);
    const result = await running;
    assert.equal(result.aborted, true);
    assert.equal(result.exitCode, 130);
    assert.ok(Date.now() - startedAt < 5_000, 'abort must stop the process promptly');
  } finally {
    await sandbox.destroy();
  }
});

test('remote sandbox cleanup ignores an already-aborted parent signal', async () => {
  const controller = new AbortController();
  const calls = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid',
    apiKey: 'test-key',
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, signalAborted: options.signal.aborted });
      const body = options.method === 'POST' && url.endsWith('/v1/sessions')
        ? { sessionId: 'session-1' }
        : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await sandbox.putFile('uploads/a.txt', Buffer.from('a'));
  controller.abort(Object.assign(new Error('caller gone'), { name: 'AbortError' }));
  await sandbox.destroy();
  const cleanup = calls.find((call) => call.method === 'DELETE');
  assert.ok(cleanup, 'destroy must still issue DELETE for an allocated remote session');
  assert.equal(cleanup.signalAborted, false, 'cleanup needs an independent signal');
});

test('Docker cleanup ignores an already-aborted parent signal', async () => {
  const controller = new AbortController();
  const calls = [];
  const sandbox = await _createDockerSandbox({
    signal: controller.signal,
    processRunner: async (command, args, options) => {
      calls.push({ command, args, signal: options.signal });
      return { stdout: 'container-id', stderr: '', exitCode: 0, timedOut: false };
    },
  });
  controller.abort(Object.assign(new Error('caller gone'), { name: 'AbortError' }));
  await sandbox.destroy();
  const cleanup = calls.find((call) => call.args[0] === 'rm' && call.args[1] === '-f');
  assert.ok(cleanup, 'destroy must still issue docker rm -f');
  assert.equal(cleanup.signal, undefined, 'cleanup needs an independent signal');
});

test('an aborted Docker creation removes a container that may already exist', async () => {
  const calls = [];
  let invocation = 0;
  await assert.rejects(
    _createDockerSandbox({
      signal: new AbortController().signal,
      processRunner: async (command, args, options) => {
        invocation += 1;
        calls.push({ command, args, signal: options.signal });
        if (invocation === 1) {
          return { stdout: '', stderr: 'operation aborted', exitCode: 130, aborted: true };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    /docker run failed/,
  );
  const cleanup = calls.find((call) => call.args[0] === 'rm' && call.args[1] === '-f');
  assert.ok(cleanup);
  assert.equal(cleanup.signal, undefined);
});

test('tools: str_replace demands a unique match and reports misses cleanly', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const tools = makeToolExecutors(sandbox);
    await tools.write_file({ path: 'a.txt', content: 'uno dos uno' });
    assert.match(await tools.str_replace({ path: 'a.txt', old_str: 'uno', new_str: 'X' }), /more than once/);
    assert.match(await tools.str_replace({ path: 'a.txt', old_str: 'tres', new_str: 'X' }), /not found/);
    assert.match(await tools.str_replace({ path: 'a.txt', old_str: 'dos', new_str: 'DOS' }), /^OK/);
    assert.equal((await sandbox.readFile('a.txt')).toString(), 'uno DOS uno');
  } finally {
    await sandbox.destroy();
  }
});

test('loop: stops at the iteration cap and never throws on unknown tools', async () => {
  const always = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'nope', arguments: '{}' } }] } }],
    }) } },
  };
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const result = await runDocAgentLoop({
      client: always,
      model: 'fake',
      messages: [{ role: 'system', content: buildDocAgentSystemPrompt([]) }, { role: 'user', content: 'x' }],
      tools: TOOL_DEFINITIONS,
      executors: makeToolExecutors(sandbox),
      maxIterations: 3,
    });
    assert.equal(result.stoppedReason, 'max_iterations');
    assert.equal(result.iterations, 3);
    assert.ok(result.steps.every((s) => s.tool === 'nope' && !s.ok));
  } finally {
    await sandbox.destroy();
  }
});

test('isValidOoxml: accepts a real docx, rejects a mis-packed (nested) archive', async () => {
  const good = await makeSampleDocx();
  assert.equal(isValidOoxml(good), true);

  // Repack the docx so every entry is nested under "nested/" → corrupt OOXML
  // (the exact failure a model causes with `zip -r out.docx /abs/path/*`).
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    await sandbox.putFile('uploads/g.docx', good);
    await sandbox.exec('mkdir -p /workspace/tmp/u && cd /workspace/tmp/u && python3 -c "import zipfile; zipfile.ZipFile(\'/workspace/uploads/g.docx\').extractall(\'.\')"');
    // zip from the PARENT so paths become "u/[Content_Types].xml", etc.
    await sandbox.exec('cd /workspace/tmp && zip -q -r /workspace/outputs/bad.docx u');
    const bad = await sandbox.readFile('outputs/bad.docx');
    assert.equal(isValidOoxml(bad), false);
  } finally {
    await sandbox.destroy();
  }

  assert.equal(isValidOoxml(Buffer.from('not a zip')), false);
  assert.equal(isValidOoxml(null), false);
});

test('skills: prompt includes only the relevant format blocks + hard rules', () => {
  const p = buildDocAgentSystemPrompt(['informe.docx', 'datos.xlsx']);
  assert.ok(p.includes('DOCX SKILL'));
  assert.ok(p.includes('XLSX SKILL'));
  assert.ok(!p.includes('PPTX SKILL'));
  assert.ok(p.includes('/workspace/outputs'));
  assert.ok(p.includes('informe.docx'));
});
