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

test('project_list filters secrets and reports runner failure honestly', async () => {
  const context = { userId: 'u1', chatId: 'chat1', projectTools: { binding: deps.binding, runner: { exec: async () => ({ ok: true, stdout: 'src/app.js\n.env\nx/.env.local\n../escape\nid_ed25519\n' }) } } };
  assert.deepEqual((await projectListTool.execute({}, context)).files, ['src/app.js']);
  context.projectTools.runner.exec = async () => ({ ok: false });
  assert.equal((await projectListTool.execute({}, context)).ok, false);
});

test('chat ReAct edits and tests the SAME persistent project, preserving selected model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-code-integration-'));
  await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n');
  const runnerCalls = [], requests = [];
  const runner = {
    async readFile(id, rel) { runnerCalls.push(id); return { content: await fs.readFile(path.join(root, rel), 'utf8') }; },
    async writeFiles(id, files) { runnerCalls.push(id); for (const f of files) await fs.writeFile(path.join(root, f.path), f.content); return { ok: true }; },
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
    requests.push(req);
    const [name, args] = script[Math.min(index++, script.length - 1)];
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
  } } } };
  const res = new PassThrough(); res.resume(); res.setHeader = () => {};
  try {
    const result = await require('../src/services/agentic-chat-stream').runAgenticChat({
      openai, model: 'grok-4.6', provider: 'xAI', userQuery: 'Cambia el valor a 2 y comprueba la prueba.',
      res, toolsOverride: [], maxSteps: 7,
      toolContext: { userId: 'u1', chatId: 'chat1', permission: 'workspace', codingWorkspace: { projectId: 'p1' }, projectTools: { runner, binding: deps.binding } },
    });
    assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
    assert.deepEqual(new Set(runnerCalls), new Set(['p1']));
    assert.ok(requests.every((r) => r.model === 'grok-4.6'));
    assert.match(result.finalAnswer, /pasó la prueba/);
    const names = requests[0].tools.map((t) => t.function.name);
    assert.ok(names.includes('project_write'));
    assert.ok(!names.includes('host_bash') && !names.includes('construir_scaffold'));
  } finally { res.destroy(); await fs.rm(root, { recursive: true, force: true }); }
});
