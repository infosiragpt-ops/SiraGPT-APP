'use strict';

/**
 * Remote sandbox pipeline — offline E2E.
 *
 * Boots the REAL sandbox microservice (services/sandbox/server.js) over HTTP on
 * a random localhost port, with the docker session factory swapped for the
 * backend's local sandbox (no Docker needed). Then drives it with the REAL
 * remote driver + the REAL doc-agent loop: app loop → remote driver → HTTP
 * (Bearer) → service → session → real file ops → edited docx. Plus the auth
 * matrix (no key 401 / wrong key 401 / right key works) and /health (no auth).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// The service refuses to start without a key — set it BEFORE requiring it.
const KEY = 'test-sandbox-key-' + Math.random().toString(36).slice(2);
process.env.SANDBOX_API_KEY = KEY;

const { buildServer } = require('../../services/sandbox/server');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const { createRemoteSandbox } = require('../src/services/doc-agent/remote-sandbox');
const { makeToolExecutors } = require('../src/services/doc-agent/tools');
const { runDocAgentLoop } = require('../src/services/doc-agent/loop');
const { buildDocAgentSystemPrompt } = require('../src/services/doc-agent/skills');
const { TOOL_DEFINITIONS } = require('../src/services/doc-agent/tools');
const { parseZip } = require('../src/services/zip-parser');

let server;
let base;

before(async () => {
  // Inject: each "container" is a backend local sandbox; docker always "up".
  server = buildServer({
    createSession: () => createSandbox({ driver: 'local' }),
    isDockerAvailable: async () => true,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { try { server.close(); } catch (_) {} });

test('health is public; protected endpoints require the Bearer key', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const hj = await health.json();
  assert.equal(hj.ok, true);
  assert.equal(hj.maxConcurrency, 15);

  const noKey = await fetch(`${base}/v1/sessions`, { method: 'POST' });
  assert.equal(noKey.status, 401);

  const wrongKey = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrongKey.status, 401);

  const ok = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(ok.status, 201);
  const { sessionId } = await ok.json();
  assert.ok(sessionId);
  await fetch(`${base}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } });
});

test('full doc edit runs through the remote driver over HTTP and yields a valid docx', async () => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const docxBuffer = await Packer.toBuffer(new Document({
    sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Informe Preliminar')] }),
      new Paragraph({ children: [new TextRun('Contenido base.')] }),
    ] }],
  }));

  const repack = 'cd /workspace/tmp/x && zip -q -r /workspace/outputs/informe-editado.docx .';
  const script = [
    { toolCalls: [{ name: 'bash', args: { command: "mkdir -p /workspace/tmp/x && cd /workspace/tmp/x && python3 -c \"import zipfile; zipfile.ZipFile('/workspace/uploads/informe.docx').extractall('.')\"" } }] },
    { toolCalls: [{ name: 'str_replace', args: { path: 'tmp/x/word/document.xml', old_str: 'Informe Preliminar', new_str: 'Informe Final' } }] },
    { toolCalls: [{ name: 'bash', args: { command: repack } }] },
    { content: 'Listo: informe-editado.docx' },
  ];
  let i = 0;
  const client = { chat: { completions: { create: async () => {
    const turn = script[i++];
    if (turn.toolCalls) return { choices: [{ message: { content: null, tool_calls: turn.toolCalls.map((c, k) => ({ id: `c${i}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] };
    return { choices: [{ message: { content: turn.content } }] };
  } } } };

  const remote = createRemoteSandbox({ baseUrl: base, apiKey: KEY });
  try {
    await remote.putFile('uploads/informe.docx', docxBuffer);
    const result = await runDocAgentLoop({
      client,
      model: 'fake',
      messages: [{ role: 'system', content: buildDocAgentSystemPrompt(['informe.docx']) }, { role: 'user', content: 'cambia el título a Informe Final' }],
      tools: TOOL_DEFINITIONS,
      executors: makeToolExecutors(remote),
      maxIterations: 8,
    });
    assert.equal(result.stoppedReason, 'final');
    assert.equal(result.steps.filter((s) => !s.ok).length, 0, JSON.stringify(result.steps.filter((s) => !s.ok)));

    const outputs = await remote.collectOutputs();
    const edited = outputs.find((o) => o.name === 'informe-editado.docx');
    assert.ok(edited, 'edited docx must be collected from the remote sandbox');

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-verify-'));
    try {
      const p = path.join(tmp, 'out.docx');
      await fs.writeFile(p, edited.buffer);
      const text = String(await parseZip(p));
      assert.ok(text.includes('Informe Final'));
      assert.ok(!text.includes('Informe Preliminar'));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  } finally {
    await remote.destroy();
  }
});

test('remote driver requires service url + key', () => {
  // Bypass env fallback (the test process has SANDBOX_API_KEY set for the server).
  const savedUrl = process.env.SANDBOX_SERVICE_URL;
  const savedKey = process.env.SANDBOX_API_KEY;
  delete process.env.SANDBOX_SERVICE_URL;
  delete process.env.SANDBOX_API_KEY;
  try {
    assert.throws(() => createRemoteSandbox({ baseUrl: '', apiKey: 'k' }), /SERVICE_URL/);
    assert.throws(() => createRemoteSandbox({ baseUrl: 'http://x', apiKey: '' }), /API_KEY/);
  } finally {
    if (savedUrl !== undefined) process.env.SANDBOX_SERVICE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SANDBOX_API_KEY = savedKey;
  }
});
