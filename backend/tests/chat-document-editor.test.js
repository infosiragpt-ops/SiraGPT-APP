'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runChatDocumentEdit,
  resolveEditSources,
  toAssistantFiles,
  cleanSummary,
  MESSAGES,
  INTERNAL,
} = require('../src/services/document-editor/chat-document-editor');
const { createPromptedToolClient } = require('../src/services/document-editor/prompted-tool-client');
const { createFailoverClient } = require('../src/services/doc-agent/llm-runtime');

const USER = 'user-1';
const DOCX = Buffer.from('PKfake-docx');

function fakePrisma({ files = [], messages = [] } = {}) {
  const calls = { file: [], message: [] };
  return {
    calls,
    file: {
      findMany: async (query) => {
        calls.file.push(query);
        const ids = query.where.id.in;
        return files.filter((row) => ids.includes(row.id) && row.userId === query.where.userId);
      },
    },
    message: {
      findMany: async (query) => {
        calls.message.push(query);
        return messages;
      },
    },
  };
}

function tempArtifactDir(entries = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-artifacts-'));
  for (const [id, { metadata, bytes }] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(metadata));
    if (bytes) fs.writeFileSync(path.join(dir, metadata.storedRelPath || `${id}-${metadata.filename}`), bytes);
  }
  return dir;
}

function baseDeps(overrides = {}) {
  const saved = [];
  const agentCalls = [];
  const deps = {
    env: {},
    artifactDir: tempArtifactDir(),
    objectStorage: { toLocalTemp: async () => { throw new Error('not remote'); } },
    readSourceBuffer: async () => ({ buffer: DOCX, cleanup: async () => {} }),
    extractFileIds: (files) => (Array.isArray(files) ? files : JSON.parse(files || '[]')).map((f) => (typeof f === 'string' ? f : f.id)).filter(Boolean),
    saveArtifact: (input) => {
      saved.push(input);
      const id = `abc${saved.length}def`;
      return {
        id,
        filename: input.filename,
        format: input.filename.split('.').pop(),
        mime: input.mime,
        sizeBytes: Buffer.from(input.base64, 'base64').length,
        downloadUrl: `/api/agent/artifact/${id}?name=${encodeURIComponent(input.filename)}`,
      };
    },
    runDocumentAgent: async (opts) => {
      agentCalls.push(opts);
      opts.onEvent({ type: 'phase', phase: 'execute' });
      return {
        finalText: 'Listo. Generé el archivo **`informe-editado.docx`** en `/workspace/outputs`.',
        outputs: [{ name: 'informe-editado.docx', buffer: Buffer.from('edited'), valid: true }],
      };
    },
    resolveDocAgentCandidates: () => [],
    createFailoverClient,
    defaultCreateClient: () => { throw new Error('ladder client must not be created'); },
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
  return { deps, saved, agentCalls };
}

test('attached documents are edited by the picked model client and saved as chat artifacts', async () => {
  const picked = { chat: { completions: { create: async (payload) => ({ choices: [{ message: { content: `model=${payload.model}` } }] }) } } };
  const { deps, saved, agentCalls } = baseDeps();
  const prisma = fakePrisma({ files: [{ id: 'f1', userId: USER, originalName: 'informe.docx', path: 'r2:uploads/f1' }] });
  const stages = [];
  const result = await runChatDocumentEdit({
    prisma, userId: USER, chatId: 'chat-1', fileIds: ['f1'], instruction: 'Cambia el título',
    llm: { client: picked, model: 'deepseek-v4-pro', provider: 'DeepSeek', toolCallMode: 'native' },
    onEvent: (stage) => stages.push(stage), deps,
  });

  assert.equal(result.ok, true);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].model, 'deepseek-v4-pro');
  assert.deepEqual(agentCalls[0].files.map((f) => f.name), ['informe.docx']);
  const reply = await agentCalls[0].client.chat.completions.create({ model: 'ignored', messages: [] });
  assert.equal(reply.choices[0].message.content, 'model=deepseek-v4-pro', 'the picked client and model answer the loop');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ownerUserId, USER);
  assert.equal(saved[0].chatId, 'chat-1');
  assert.equal(result.artifacts[0].downloadUrl, '/api/agent/artifact/abc1def?name=informe-editado.docx');
  assert.equal(result.summary, 'Listo. Generé el archivo **`informe-editado.docx`**.');
  assert.deepEqual(stages.map((s) => s.label), ['Abriendo el documento', 'Editando el documento']);
});

test('only provider-level failures of the picked model move to another configured provider', async () => {
  const failing = { chat: { completions: { create: async () => { const err = new Error('credit'); err.status = 402; throw err; } } } };
  const ladder = { chat: { completions: { create: async (payload) => ({ choices: [{ message: { content: `ladder=${payload.model}` } }] }) } } };
  const created = [];
  const { deps } = baseDeps({
    resolveDocAgentCandidates: () => [
      { provider: 'DeepSeek', model: 'deepseek-v4-pro' },
      { provider: 'Gemini', model: 'gemini-x' },
    ],
    defaultCreateClient: (candidate) => { created.push(candidate.provider); return ladder; },
  });
  const client = INTERNAL.buildEditorClient({ client: failing, model: 'grok-4.6', provider: 'xAI', toolCallMode: 'native', deps: { ...deps, onFailover: () => {} } });
  const reply = await client.chat.completions.create({ model: 'grok-4.6', messages: [] });
  assert.equal(reply.choices[0].message.content, 'ladder=deepseek-v4-pro');
  assert.deepEqual(created, ['DeepSeek']);

  const badRequest = { chat: { completions: { create: async () => { const err = new Error('bad'); err.status = 400; throw err; } } } };
  const strict = INTERNAL.buildEditorClient({ client: badRequest, model: 'grok-4.6', provider: 'xAI', toolCallMode: 'native', deps: { ...deps, onFailover: () => {} } });
  await assert.rejects(strict.chat.completions.create({ messages: [] }), /bad/);
});

test('the ladder never retries the provider the user already picked', () => {
  const { deps } = baseDeps({
    resolveDocAgentCandidates: () => [{ provider: 'DeepSeek', model: 'deepseek-v4-pro' }, { provider: 'Meta', model: 'muse' }],
  });
  let seen = null;
  deps.createFailoverClient = (candidates) => { seen = candidates.map((c) => c.provider); return {}; };
  INTERNAL.buildEditorClient({ client: {}, model: 'deepseek-v4-flash', provider: 'DeepSeek', toolCallMode: 'native', deps: { ...deps, onFailover: () => {} } });
  assert.deepEqual(seen, ['__picked__', 'Meta']);
});

test('a follow-up without attachments edits the latest delivered version before the original upload', async () => {
  const artifactDir = tempArtifactDir({
    abc123: { metadata: { id: 'abc123', filename: 'informe_editado.docx', ownerUserId: USER, storedRelPath: 'abc123-informe_editado.docx' }, bytes: Buffer.from('v2') },
  });
  const prisma = fakePrisma({
    files: [{ id: 'f1', userId: USER, originalName: 'informe.docx', path: '/tmp/x' }],
    messages: [
      { role: 'ASSISTANT', files: JSON.stringify([{ type: 'doc', url: '/api/agent/artifact/abc123?name=informe_editado.docx' }]) },
      { role: 'USER', files: JSON.stringify([{ id: 'f1', name: 'informe.docx' }]) },
    ],
  });
  const { deps, agentCalls } = baseDeps({ artifactDir });
  const result = await runChatDocumentEdit({
    prisma, userId: USER, chatId: 'chat-1', fileIds: [], instruction: 'ahora agrega una fila',
    llm: { client: {}, model: 'deepseek-v4-pro', provider: 'DeepSeek' }, deps,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(agentCalls[0].files.map((f) => [f.name, f.buffer.toString()]), [['informe_editado.docx', 'v2']]);
  assert.deepEqual(prisma.calls.message[0].where, { chatId: 'chat-1', deletedAt: null, chat: { userId: USER } });
});

test('artifacts owned by another user are never used as a source', async () => {
  const artifactDir = tempArtifactDir({
    abc999: { metadata: { id: 'abc999', filename: 'ajeno.docx', ownerUserId: 'other' }, bytes: Buffer.from('x') },
  });
  const prisma = fakePrisma({
    files: [{ id: 'f1', userId: USER, originalName: 'mio.docx', path: '/tmp/x' }],
    messages: [
      { role: 'ASSISTANT', files: [{ artifactId: 'abc999', filename: 'ajeno.docx' }] },
      { role: 'USER', files: [{ id: 'f1' }] },
    ],
  });
  const { deps } = baseDeps({ artifactDir });
  const sources = await resolveEditSources({ prisma, userId: USER, chatId: 'chat-1', deps });
  assert.deepEqual(sources.map((s) => s.name), ['mio.docx']);
});

test('uploads of other users or non-document files are ignored', async () => {
  const prisma = fakePrisma({
    files: [
      { id: 'f1', userId: 'other', originalName: 'ajeno.docx' },
      { id: 'f2', userId: USER, originalName: 'foto.png' },
    ],
  });
  const { deps } = baseDeps();
  const result = await runChatDocumentEdit({
    prisma, userId: USER, chatId: 'chat-1', fileIds: ['f1', 'f2'], instruction: 'edita',
    llm: { client: {}, model: 'm' }, deps,
  });
  assert.deepEqual(result, { ok: false, code: 'NO_DOCUMENT', message: MESSAGES.NO_DOCUMENT });
});

test('invalid outputs are never saved or delivered', async () => {
  const { deps, saved } = baseDeps({
    runDocumentAgent: async () => ({ finalText: 'hecho', outputs: [{ name: 'x.docx', buffer: Buffer.from('bad'), valid: false }] }),
  });
  const prisma = fakePrisma({ files: [{ id: 'f1', userId: USER, originalName: 'x.docx' }] });
  const result = await runChatDocumentEdit({ prisma, userId: USER, chatId: 'c', fileIds: ['f1'], instruction: 'edita', llm: { client: {}, model: 'm' }, deps });
  assert.equal(result.code, 'NO_VALID_OUTPUT');
  assert.equal(saved.length, 0);
});

test('engine errors become an honest message; a Stop abort propagates', async () => {
  const prisma = fakePrisma({ files: [{ id: 'f1', userId: USER, originalName: 'x.docx' }] });
  const failing = baseDeps({ runDocumentAgent: async () => { throw new Error('provider exploded'); } }).deps;
  const failed = await runChatDocumentEdit({ prisma, userId: USER, chatId: 'c', fileIds: ['f1'], instruction: 'edita', llm: { client: {}, model: 'm' }, deps: failing });
  assert.deepEqual(failed, { ok: false, code: 'ENGINE_FAILED', message: MESSAGES.ENGINE_FAILED });

  const controller = new AbortController();
  const aborting = baseDeps({ runDocumentAgent: async () => { controller.abort(); throw new Error('aborted'); } }).deps;
  await assert.rejects(runChatDocumentEdit({
    prisma, userId: USER, chatId: 'c', fileIds: ['f1'], instruction: 'edita', llm: { client: {}, model: 'm' }, signal: controller.signal, deps: aborting,
  }), /aborted/);
});

test('oversized sources are refused before the engine runs', async () => {
  const { deps, agentCalls } = baseDeps({ readSourceBuffer: async () => ({ buffer: Buffer.alloc(21 * 1024 * 1024), cleanup: async () => {} }) });
  const prisma = fakePrisma({ files: [{ id: 'f1', userId: USER, originalName: 'x.docx' }] });
  const result = await runChatDocumentEdit({ prisma, userId: USER, chatId: 'c', fileIds: ['f1'], instruction: 'edita', llm: { client: {}, model: 'm' }, deps });
  assert.equal(result.code, 'FILE_TOO_LARGE');
  assert.equal(agentCalls.length, 0);
});

test('assistant files render as document cards and stay discoverable for follow-ups', () => {
  const files = toAssistantFiles([{ id: 'abc1def0', filename: 'a.docx', format: 'docx', mime: 'm', sizeBytes: 3, downloadUrl: '/api/agent/artifact/abc1def0?name=a.docx' }]);
  assert.deepEqual(files, [{
    type: 'doc', format: 'docx', filename: 'a.docx', title: 'a.docx', artifactId: 'abc1def0',
    url: '/api/agent/artifact/abc1def0?name=a.docx', downloadUrl: '/api/agent/artifact/abc1def0?name=a.docx', mime: 'm', size: 3,
  }]);
  assert.equal(INTERNAL.artifactIdFromRef(files[0]), 'abc1def0');
  assert.equal(INTERNAL.artifactIdFromRef({ url: '/api/agent/artifact/abc1def0?name=a.docx' }), 'abc1def0');
  assert.equal(cleanSummary('Guardé `/workspace/outputs/a.docx` en /workspace/outputs.'), 'Guardé a.docx.');
});

test('prompted transports run the same loop through fenced tool calls', async () => {
  const sent = [];
  const replies = [
    'Reviso el archivo.\n```tool_call\n{"tool": "bash", "args": {"command": "ls /workspace/uploads"}}\n```',
    '```tool_call\n{"tool": "finalize", "args": {"answer": "Cambié el título."}}\n```',
  ];
  const raw = { chat: { completions: { create: async (payload) => { sent.push(payload); return { choices: [{ message: { content: replies.shift() } }] }; } } } };
  const client = createPromptedToolClient(raw);
  const tools = [{ type: 'function', function: { name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
  const messages = [{ role: 'system', content: 'Edita documentos.' }, { role: 'user', content: 'Cambia el título' }];

  const first = await client.chat.completions.create({ model: 'm', messages, tools, tool_choice: 'auto' });
  assert.equal(sent[0].tools, undefined);
  assert.equal(sent[0].tool_choice, undefined);
  assert.match(sent[0].messages[0].content, /Edita documentos\.[\s\S]*TOOL-CALL PROTOCOL[\s\S]*- bash:/);
  const call = first.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, 'bash');
  assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls /workspace/uploads' });

  messages.push({ role: 'assistant', content: first.choices[0].message.content, tool_calls: [call] });
  messages.push({ role: 'tool', tool_call_id: call.id, content: 'informe.docx' });
  const second = await client.chat.completions.create({ model: 'm', messages, tools });
  assert.equal(sent[1].messages.some((m) => m.role === 'tool'), false);
  assert.match(sent[1].messages.at(-1).content, /^\[TOOL_RESULT bash\]\ninforme\.docx/);
  assert.deepEqual(second.choices[0].message, { role: 'assistant', content: 'Cambié el título.' });
});

test('the prompted adapter is only used for prompted transports', () => {
  const wrapped = [];
  const { deps } = baseDeps({ createPromptedToolClient: (c) => { wrapped.push(c); return c; } });
  deps.createFailoverClient = () => ({});
  INTERNAL.buildEditorClient({ client: { native: true }, model: 'm', provider: 'P', toolCallMode: 'native', deps: { ...deps, onFailover: () => {} } });
  assert.equal(wrapped.length, 0);
  INTERNAL.buildEditorClient({ client: { prompted: true }, model: 'm', provider: 'P', toolCallMode: 'prompted', deps: { ...deps, onFailover: () => {} } });
  assert.equal(wrapped.length, 1);
});

test('stage relay maps loop events to Spanish progress labels', () => {
  assert.deepEqual(INTERNAL.stageFor({ type: 'phase', phase: 'validate' }), { label: 'Verificando el archivo editado' });
  assert.deepEqual(INTERNAL.stageFor({ type: 'phase', phase: 'execute', attempt: 2 }), { label: 'Corrigiendo la edición' });
  assert.equal(INTERNAL.stageFor({ type: 'llm_failover', from: 'xAI' }), null, 'provider names never reach the UI');
  assert.deepEqual(INTERNAL.stageFor({ type: 'tool_call', tool: 'bash', preview: 'cd /workspace && python3 edit.py' }), { label: 'Editando el documento' }, 'sandbox commands never reach the UI');
});

test('transient provider errors retry the picked model before any failover; hard errors do not', async () => {
  let calls = 0;
  const flaky = { chat: { completions: { create: async () => {
    calls += 1;
    if (calls < 3) { const err = new Error('unavailable'); err.status = 503; throw err; }
    return { choices: [{ message: { content: 'ok' } }] };
  } } } };
  const retried = INTERNAL.withTransientRetry(flaky, { sleep: async () => {} });
  assert.equal((await retried.chat.completions.create({})).choices[0].message.content, 'ok');
  assert.equal(calls, 3);

  let hardCalls = 0;
  const hard = { chat: { completions: { create: async () => { hardCalls += 1; const err = new Error('bad request'); err.status = 400; throw err; } } } };
  await assert.rejects(INTERNAL.withTransientRetry(hard, { sleep: async () => {} }).chat.completions.create({}), /bad request/);
  assert.equal(hardCalls, 1);
});

test('DeepSeek receives reasoning_content on tool-call turns it did not generate', async () => {
  let sent = null;
  const raw = { chat: { completions: { create: async (payload) => { sent = payload; return {}; } } } };
  const messages = [
    { role: 'user', content: 'edita' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'gemini-1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'assistant', content: null, reasoning_content: 'propio', tool_calls: [{ id: 'ds-1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'gemini-1', content: 'ok' },
  ];
  await INTERNAL.withDeepSeekToolTranscript(raw).chat.completions.create({ model: 'deepseek-v4-pro', messages });
  assert.equal(sent.messages[1].reasoning_content, '');
  assert.equal(sent.messages[2].reasoning_content, 'propio');
  assert.equal('reasoning_content' in sent.messages[0], false);
  assert.equal('reasoning_content' in messages[1], false, 'the loop transcript is not mutated');
});

test('only DeepSeek transports get the reasoning_content passback', async () => {
  const payloads = {};
  const recorder = (name) => ({ chat: { completions: { create: async (payload) => { payloads[name] = payload; const err = new Error('down'); err.status = 401; throw err; } } } });
  const { deps } = baseDeps({
    resolveDocAgentCandidates: () => [{ provider: 'DeepSeek', model: 'deepseek-v4-pro' }],
    defaultCreateClient: () => recorder('DeepSeek'),
  });
  const client = INTERNAL.buildEditorClient({ client: recorder('xAI'), model: 'grok-4.6', provider: 'xAI', toolCallMode: 'native', deps: { ...deps, onFailover: () => {} } });
  const messages = [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'bash', arguments: '{}' } }] }];
  await assert.rejects(client.chat.completions.create({ messages }), /down/);
  assert.equal('reasoning_content' in payloads.xAI.messages[0], false);
  assert.equal(payloads.DeepSeek.messages[0].reasoning_content, '');
});
