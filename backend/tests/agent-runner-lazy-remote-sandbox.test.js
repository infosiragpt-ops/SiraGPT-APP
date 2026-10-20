'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const originalKey = process.env.SANDBOX_API_KEY;
const KEY = 'lazy-sandbox-test-key';
process.env.SANDBOX_API_KEY = KEY;
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const { runAgentRunner } = require('../src/services/agent-runner');
const { EXPECTED, MARKER } = require('../src/services/agent-runner/runtime-verification');

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SANDBOX_SERVICE_URL;
const originalWorkspaceDir = process.env.SIRAGPT_AGENT_WORKSPACE_DIR;
const sessions = new Map();
let created = 0;
let workspaceDir;
let probes = 0;
let mismatch = false;
let commandsAfterMismatch = 0;

function scriptedClient(turns) {
  let index = 0;
  return { chat: { completions: { create: async () => {
    const turn = turns[index++];
    if (turn instanceof Error) throw turn;
    if (turn?.tool) return { choices: [{ message: {
      content: null,
      tool_calls: [{ id: `call_${index}`, type: 'function', function: {
        name: turn.tool, arguments: JSON.stringify(turn.args || {}),
      } }],
    } }] };
    return { choices: [{ message: { content: turn?.text || '' } }] };
  } } } };
}

before(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-remote-workspaces-'));
  process.env.SIRAGPT_AGENT_WORKSPACE_DIR = workspaceDir;
  process.env.SANDBOX_SERVICE_URL = 'https://sandbox.test';
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(url).host, 'sandbox.test');
    assert.equal(options.headers?.Authorization, `Bearer ${KEY}`);
    const route = new URL(url).pathname.split('/').filter(Boolean);
    const body = options.body ? JSON.parse(options.body) : {};
    let payload;
    if (options.method === 'POST' && route.length === 2) {
      const sessionId = `session-${++created}`;
      sessions.set(sessionId, await createSandbox({ driver: 'local', persistKey: body.workspaceKey }));
      payload = { sessionId };
    } else {
      const sessionId = route[2];
      const sandbox = sessions.get(sessionId);
      assert.ok(sandbox, 'the remote session exists');
      if (options.method === 'DELETE') {
        await sandbox.destroy();
        sessions.delete(sessionId);
        payload = { ok: true };
      } else if (route[3] === 'exec') {
        if (body.command.includes('SIRA_RUNTIME_PROBE')) {
          probes += 1;
          // The transport fixture runs on a local host, not the release image.
          // Actual metadata and version failures are covered by the real probe suite.
          payload = { exitCode: mismatch ? 1 : 0, stdout: MARKER + JSON.stringify({
            protocol: 1, ok: !mismatch, digest: mismatch ? '0'.repeat(64) : EXPECTED.digest,
            checked: mismatch ? 0 : EXPECTED.packages, missing: 0, mismatched: 0,
            reason: mismatch ? 'catalog_mismatch' : 'verified',
          }) + '\n' };
        } else {
          if (mismatch) commandsAfterMismatch += 1;
          payload = await sandbox.exec(body.command, { timeoutMs: body.timeoutMs });
        }
      }
      else if (route[3] === 'put') {
        payload = { path: await sandbox.putFile(body.path, Buffer.from(body.contentBase64, 'base64')) };
      } else if (route[3] === 'write') {
        await sandbox.writeFile(body.path, Buffer.from(body.contentBase64, 'base64'));
        payload = { ok: true };
      } else if (route[3] === 'read') {
        payload = { contentBase64: (await sandbox.readFile(body.path)).toString('base64') };
      } else if (route[3] === 'list') payload = { files: await sandbox.listFiles(body.path) };
      else if (route[3] === 'outputs') {
        payload = { outputs: (await sandbox.collectOutputs()).map((out) => ({
          name: out.name, contentBase64: out.buffer.toString('base64'),
        })) };
      } else assert.fail(`unexpected remote action: ${route[3]}`);
    }
    return new Response(JSON.stringify(payload), { status: options.method === 'POST' && route.length === 2 ? 201 : 200 });
  };
});

after(async () => {
  try {
    for (const sandbox of sessions.values()) await sandbox.destroy();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SANDBOX_SERVICE_URL;
    else process.env.SANDBOX_SERVICE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SANDBOX_API_KEY;
    else process.env.SANDBOX_API_KEY = originalKey;
    if (originalWorkspaceDir === undefined) delete process.env.SIRAGPT_AGENT_WORKSPACE_DIR;
    else process.env.SIRAGPT_AGENT_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

test('a no-attachment provider failure never reserves a remote sandbox session', async () => {
  const beforeRun = created;
  const failure = Object.assign(new Error('provider unavailable'), { code: 'E_PROVIDER', status: 402 });
  const events = [];
  const result = await runAgentRunner({
    files: [], instruction: 'crea un documento Word sobre agua',
    client: scriptedClient([failure]), driver: 'remote',
    requireFileOutput: false, persistMemory: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.stoppedReason, 'E_PROVIDER', JSON.stringify(result));
  assert.equal(created - beforeRun, 0, 'no remote container is needed before a tool runs');
  assert.equal(events.some((event) => event.type === 'sandbox_ready'), false);
});

test('Stop before the first sandbox tool cancels without creating a session', async () => {
  const beforeRun = created;
  const controller = new AbortController();
  const events = [];
  const client = { chat: { completions: { create: async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  } } } };
  await assert.rejects(runAgentRunner({
    files: [], instruction: 'crea un documento', client, driver: 'remote',
    signal: controller.signal, onEvent: (event) => events.push(event),
    persistMemory: false,
  }), /abort/i);
  assert.equal(created - beforeRun, 0);
  assert.equal(events.filter((event) => event.type === 'cancelled').length, 1);
});

test('the first sandbox tool prepares one session and still returns its file', async () => {
  const beforeRun = created;
  const beforeProbes = probes;
  const result = await runAgentRunner({
    files: [], instruction: 'crea un archivo de texto con la palabra listo',
    client: scriptedClient([
      { tool: 'execute_python', args: { code: "from pathlib import Path\nPath('/workspace/outputs/listo.txt').write_text('listo')" } },
      { tool: 'render_preview', args: { path: 'outputs/listo.txt' } },
      { text: 'Creé el archivo listo.txt.' },
    ]),
    driver: 'remote', maxIterations: 4, persistMemory: false,
  });
  assert.equal(created - beforeRun, 1, 'one turn must use one remote container');
  assert.equal(probes - beforeProbes, 1, 'all tools share one preparation probe');
  assert.equal(result.stoppedReason, 'final', JSON.stringify(result));
  assert.equal(result.outputs.find((output) => output.name === 'listo.txt')?.buffer.toString(), 'listo');
});

test('the first tool archives an older chat output before reading the workspace', async () => {
  const chatId = 'lazy-remote-history';
  const seed = await createSandbox({ driver: 'local', persistKey: chatId });
  await seed.writeFile('outputs/old.txt', 'old');
  await seed.destroy();
  const beforeRun = created;
  const result = await runAgentRunner({
    files: [], chatId, instruction: 'revisa los archivos de esta conversación',
    client: scriptedClient([
      { tool: 'list_files', args: { path: 'outputs' } },
      { text: 'No generé un archivo nuevo.' },
    ]),
    driver: 'remote', requireFileOutput: false, persistMemory: false,
  });
  assert.equal(created - beforeRun, 1);
  assert.deepEqual(result.outputs, [], 'an older file is not re-delivered');
  const workspace = await createSandbox({ driver: 'local', persistKey: chatId });
  try {
    assert.deepEqual(await workspace.collectOutputs(), []);
    assert.equal((await workspace.readFile('tmp/previous-outputs/old.txt')).toString(), 'old');
  } finally {
    await workspace.destroy();
  }
});

test('an attached source is staged before the first model call', async () => {
  const beforeRun = created;
  const client = { chat: { completions: { create: async () => {
    assert.equal(created - beforeRun, 1, 'an uploaded source still needs eager staging');
    return { choices: [{ message: { content: 'No hice cambios.' } }] };
  } } } };
  await runAgentRunner({
    files: [{ name: 'entrada.txt', buffer: Buffer.from('texto fuente') }],
    instruction: 'revisa el archivo', client, driver: 'remote',
    requireFileOutput: false, persistMemory: false,
  });
  assert.equal(created - beforeRun, 1);
});


test('a mismatched image stops before archiving old outputs or running user code', async () => {
  const chatId = 'runtime-contract-history';
  const seed = await createSandbox({ driver: 'local', persistKey: chatId });
  await seed.writeFile('outputs/keep.txt', 'untouched');
  await seed.destroy();
  const beforeProbes = probes;
  const beforeCommands = commandsAfterMismatch;
  mismatch = true;
  try {
    await assert.rejects(runAgentRunner({
      files: [], chatId, instruction: 'crea un archivo de texto',
      client: scriptedClient([
        { tool: 'execute_bash', args: { command: 'echo changed > /workspace/outputs/keep.txt' } },
        { tool: 'list_files', args: { path: 'outputs' } },
        { text: 'No pude continuar.' },
      ]),
      driver: 'remote', requireFileOutput: false, persistMemory: false, maxIterations: 4,
    }), (error) => error.code === 'sandbox_capabilities_mismatch' && error.reason === 'catalog_mismatch');
  } finally {
    mismatch = false;
  }
  assert.equal(probes - beforeProbes, 1, 'a failed preparation is not retried by subsequent tools');
  assert.equal(commandsAfterMismatch - beforeCommands, 0);
  const workspace = await createSandbox({ driver: 'local', persistKey: chatId });
  try {
    assert.equal((await workspace.readFile('outputs/keep.txt')).toString(), 'untouched');
  } finally {
    await workspace.destroy();
  }
});
