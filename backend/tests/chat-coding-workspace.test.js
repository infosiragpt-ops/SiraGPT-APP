'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { authorizeChatCoding, codingTools } = require('../src/services/codex/chat-coding-workspace');
const { authorizeComposerTool } = require('../src/services/composer-permission');
const { projectListTool } = require('../src/services/agents/project-workspace-tools');
const input = { user: { id: 'u1' }, chatId: 'chat1', db: { chat: { findFirst: async ({ where }) => where.userId === 'u1' && where.id === 'chat1' ? { id: 'chat1' } : null } } };
const deps = { enabled: () => true, canUse: () => true, binding: { findProjectForChat: async () => ({ id: 'p1' }) } };

test('coding intent requires enabled runtime, account access, owned chat and bound project', async () => {
  assert.deepEqual(await authorizeChatCoding(input, deps), { ok: true, projectId: 'p1' });
  for (const patch of [{ enabled: () => false }, { canUse: () => false }]) {
    assert.equal((await authorizeChatCoding(input, { ...deps, ...patch })).status, 403);
  }
  assert.equal((await authorizeChatCoding({ ...input, chatId: 'foreign' }, deps)).status, 404);
  assert.equal((await authorizeChatCoding({ ...input, user: { id: 'u2' } }, deps)).status, 404);
  assert.equal((await authorizeChatCoding(input, { ...deps, binding: { findProjectForChat: async () => null } })).status, 409);
  await assert.rejects(authorizeChatCoding({ ...input, db: { chat: { findFirst: async () => { throw Error('db down'); } } } }, deps));
});

test('project write/exec/preview/PR obey read, protected and workspace permissions', () => {
  for (const name of ['project_write', 'project_exec', 'project_preview_start', 'project_preview_stop', 'project_open_pull_request']) {
    assert.equal(authorizeComposerTool('read', name).denied, true, name);
    assert.equal(authorizeComposerTool('workspace', name).allowed, true, name);
  }
  assert.equal(authorizeComposerTool('protected', 'project_write').needsPermission, true);
  assert.equal(authorizeComposerTool('read', 'project_list').allowed, true);
  assert.equal(authorizeComposerTool('read', 'project_read').allowed, true);
});

test('coding tool surface contains only project-scoped tools, never host or alternate scaffold engines', () => {
  const tools = codingTools();
  assert.equal(tools.length, 10);
  for (const tool of tools) { assert.match(tool.name, /^project_/); assert.equal(typeof tool.execute, 'function'); }
});

test('coding research reuses only audited read-only public web tools', async () => {
  const { baseWebTools } = require('../src/services/agentic-chat-stream')._internal;
  const tools = codingTools({ researchTools: [...baseWebTools(), { name: 'host_bash', readOnly: true }, { name: 'browser_type', readOnly: true }] });
  assert.deepEqual(tools.filter((tool) => !tool.name.startsWith('project_')).map((tool) => tool.name), ['web_search', 'read_url']);
  const read = tools.find((tool) => tool.name === 'read_url');
  for (const url of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/']) {
    const result = await read.execute({ url }, { userId: 'u1' });
    assert.ok(result.error || result.ok === false, 'non-public URL must be rejected');
  }
});

test('project_list filters secrets and reports runner failure honestly', async () => {
  const context = { userId: 'u1', chatId: 'chat1', projectTools: { binding: deps.binding, runner: { exec: async () => ({ ok: true, stdout: 'src/app.js\n.env\nx/.env.local\n../escape\nid_ed25519\n' }) } } };
  assert.deepEqual((await projectListTool.execute({}, context)).files, ['src/app.js']);
  context.projectTools.runner.exec = async () => ({ ok: false });
  assert.equal((await projectListTool.execute({}, context)).ok, false);
});

test('chat ReAct edits and tests the SAME persistent project after context compaction, preserving selected model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-code-integration-'));
  await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n');
  // Execute the real compactor against an in-memory persistence boundary;
  // summary creation must not update/delete the visible message rows.
  const compactor = require('../src/services/conversation-compactor');
  const visibleRows = [
    { role: 'USER', content: 'DECISION_CODING_418: conservar app.js y las pruebas existentes.', timestamp: new Date('2026-09-01T10:00:00Z') },
    { role: 'ASSISTANT', content: 'Pendiente cambiar solo el valor exportado.', timestamp: new Date('2026-09-01T10:01:00Z') },
  ];
  const originalRows = structuredClone(visibleRows);
  const persisted = [];
  const compacted = await compactor.compactChat({
    chatId: 'chat1', rows: visibleRows, env: {},
    prisma: { chat: { update: async (update) => { persisted.push(update); } } },
  });
  assert.equal(compacted.ok, true);
  assert.equal(compacted.source, 'extractive');
  assert.equal(persisted.length, 1);
  const history = [{ role: 'system', content: compactor.summaryBlock(compacted.summary, compacted.meta) }];
  for (let i = 0; i < 12; i += 1) {
    history.push({ role: 'user', content: `Earlier step ${i}: ` + 'Details '.repeat(200) });
    history.push({ role: 'assistant', content: 'Reviewed files. '.repeat(100) });
  }
  const originalHistory = structuredClone(history);
  const runnerCalls = [], requests = [];
  const runner = {
    async readFile(id, rel) { runnerCalls.push(id); return { content: await fs.readFile(path.join(root, rel), 'utf8') }; },
    async writeFiles(id, files) { runnerCalls.push(id); for (const f of files) await fs.writeFile(path.join(root, f.path), f.content); return { ok: true, written: files.length }; },
    async exec(id, cmd) {
      runnerCalls.push(id);
      if (cmd[0] === 'git') return { ok: true, stdout: 'app.js\n', exitCode: 0 };
      const { stdout, stderr } = await promisify(execFile)(cmd[0], cmd.slice(1), { cwd: root });
      return { ok: true, stdout, stderr, exitCode: 0 };
    },
  };
  const script = [
    ['project_list', {}], ['project_read', { path: 'app.js' }],
    ['project_write', { path: 'app.js', content: 'module.exports = 2;\n' }],
    ['project_exec', { cmd: ['node', '-e', "require('node:assert/strict').equal(require('./app'),2); console.log('test passed')"] }],
    ['finalize', { answer: 'Actualicé app.js a 2 y pasó la prueba.' }],
  ];
  let index = 0;
  const openai = { chat: { completions: { create: async (req) => {
    requests.push(structuredClone(req));
    const [name, args] = script[Math.min(index++, script.length - 1)];
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
  } } } };
  const res = new PassThrough(); res.resume(); res.setHeader = () => {};
  try {
    const result = await require('../src/services/agentic-chat-stream').runAgenticChat({
      openai, model: 'grok-4.6', provider: 'xAI', userQuery: 'Cambia el valor a 2 y comprueba la prueba.',
      res, history, toolsOverride: [], maxSteps: 7,
      toolContext: { userId: 'u1', chatId: 'chat1', permission: 'workspace', codingWorkspace: { projectId: 'p1' }, projectTools: { runner, binding: deps.binding } },
    });
    assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
    assert.deepEqual(new Set(runnerCalls), new Set(['p1']));
    assert.ok(requests.every((r) => r.model === 'grok-4.6'));
    assert.ok(requests.every((r) => JSON.stringify(r.tools) === JSON.stringify(requests[0].tools)), 'compaction preserves the tool schema');
    assert.ok(requests.every((r) => r.messages.some((m) => String(m.content).includes('DECISION_CODING_418'))));
    assert.ok(requests.every((r) => r.messages.some((m) => String(m.content).includes('Cambia el valor a 2 y comprueba la prueba.'))));
    assert.deepEqual(visibleRows, originalRows, 'compaction never deletes or rewrites the visible transcript');
    assert.deepEqual(history, originalHistory, 'the agent cannot mutate the caller-owned history');
    assert.match(result.finalAnswer, /pasó la prueba/);
    const names = requests[0].tools.map((t) => t.function.name);
    assert.ok(names.includes('project_write'));
    assert.ok(!names.includes('host_bash') && !names.includes('construir_scaffold'));
  } finally { res.destroy(); await fs.rm(root, { recursive: true, force: true }); }
});

test('real coding loop forwards ready preview metadata without its URL or token', async () => {
  const { runAgenticChat } = require('../src/services/agentic-chat-stream');
  const res = new PassThrough(); res.setHeader = () => {};
  let output = '', index = 0;
  res.on('data', chunk => { output += chunk; });
  const openai = { chat: { completions: { create: async () => {
    const next = index++ === 0
      ? ['project_preview_status', {}]
      : ['finalize', { answer: 'La vista previa está lista.' }];
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `preview-${index}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } }] };
  } } } };
  try {
    await runAgenticChat({ openai, model: 'gpt-4o', provider: 'OpenAI', res, userQuery: 'Abre la vista previa del mismo proyecto.', maxSteps: 3,
      toolContext: { userId: 'u1', chatId: 'chat1', permission: 'workspace', codingWorkspace: { projectId: 'p1' }, projectTools: {
        previewService: { previewStatusForChat: async () => ({ ok: true, project: { id: 'p1' }, status: { running: true, ready: true }, previewUrl: 'https://siragpt.com/api/codex/projects/p1/preview/TEST-ACCESS-TOKEN/app/' }) },
      } },
    });
    const events = output.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(events.filter(event => event.type === 'coding_preview_ready'), [{ type: 'coding_preview_ready', chatId: 'chat1', projectId: 'p1' }]);
    assert.ok(!JSON.stringify(events.filter(event => event.type === 'coding_preview_ready')).includes('TOKEN'));
  } finally { res.destroy(); }
});
