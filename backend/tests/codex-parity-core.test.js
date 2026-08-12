'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../src/services/codex/tool-scheduler');
const hooks = require('../src/services/codex/project-hooks');
const agentLoop = require('../src/services/codex/agent-loop');
const runService = require('../src/services/codex/run-service');
const PERMISSION_BINDING = 'b'.repeat(64);

test('general tool scheduler parallelizes independent reads and distinct writes', () => {
  const readBatches = scheduler.scheduleToolCalls([
    { name: 'read_file', args: { path: 'a.ts' } },
    { name: 'read_file', args: { path: 'b.ts' } },
    { name: 'web_fetch', args: { url: 'https://example.com' } },
  ]);
  assert.equal(readBatches.length, 1);
  assert.equal(readBatches[0].length, 3);

  const writeBatches = scheduler.scheduleToolCalls([
    { name: 'write_file', args: { path: 'a.ts' } },
    { name: 'write_file', args: { path: 'b.ts' } },
  ]);
  assert.equal(writeBatches.length, 1);

  const dependencyBatches = scheduler.scheduleToolCalls([
    { name: 'write_file', args: { path: 'a.ts' } },
    { name: 'read_file', args: { path: 'a.ts' } },
    { name: 'run_command', args: { cmd: ['git', 'status'] } },
  ]);
  assert.deepEqual(dependencyBatches.map((batch) => batch.length), [1, 1, 1]);
});

test('project hooks validate, transform, and deny deterministically', () => {
  const parsed = hooks.parseHooks(JSON.stringify({
    version: 1,
    preToolUse: [
      { matcher: 'read_*', action: 'transform', args: { lineStart: 2 } },
      { matcher: 'run_command', action: 'deny', message: 'shell blocked' },
    ],
    postToolUse: [{ matcher: 'web_*', action: 'transform', args: { summary: 'redacted' } }],
  }));
  assert.deepEqual(
    hooks.applyPreHooks(parsed, 'read_file', { path: 'a.ts' }),
    { allowed: true, args: { path: 'a.ts', lineStart: 2 }, message: '' },
  );
  assert.equal(hooks.applyPreHooks(parsed, 'run_command', { cmd: ['ls'] }).allowed, false);
  assert.equal(hooks.applyPostHooks(parsed, 'web_fetch', { summary: 'raw' }).summary, 'redacted');
  assert.throws(() => hooks.parseHooks('{"preToolUse":[{"matcher":"*","action":"exec"}]}'), /invalid hook/);
});

test('brief permissions support exact and wildcard tool matchers', () => {
  const project = { brief: { permissions: { requireApproval: ['run_command', 'mcp__*'] } } };
  assert.equal(hooks.requiresApproval(project, 'run_command'), true);
  assert.equal(hooks.requiresApproval(project, 'mcp__github__create_issue'), true);
  assert.equal(hooks.requiresApproval(project, 'read_file'), false);
});

test('SIRA.md and operational notes are both loaded into project memory', async () => {
  const runner = {
    async readFile(_projectId, path) {
      if (path === 'SIRA.md') return { content: '# Convenciones\nUsar TypeScript.' };
      if (path === '.sira/notes.md') return { content: 'Pendiente: pruebas.' };
      throw new Error('not found');
    },
  };
  const memory = await agentLoop.safeProjectNotes(runner, 'p1');
  assert.match(memory, /SIRA\.md/);
  assert.match(memory, /Usar TypeScript/);
  assert.match(memory, /\.sira\/notes\.md/);
});

test('LLM compaction produces a bounded resumable context snapshot', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
    ...Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index} ${'x'.repeat(800)}`,
    })),
  ];
  let usageSeen = 0;
  const summary = await agentLoop.summariseContextWithLlm({
    messages,
    llmTurn: async ({ tools }) => {
      assert.deepEqual(tools, []);
      return { text: 'Decisión: conservar TypeScript. Próximo paso: ejecutar tests.', usage: { inputTokens: 10 } };
    },
    metrics: { recordLlmUsage: () => { usageSeen += 1; } },
  });
  assert.match(summary, /conservar TypeScript/);
  assert.equal(usageSeen, 1);

  const persisted = [];
  const eventStore = {
    appendEvent: async (_runId, type, data) => persisted.push({ type, data }),
    listEvents: async () => persisted.map((row, seq) => ({ ...row, seq: seq + 1 })),
  };
  await agentLoop.persistContextSnapshot({
    run: { id: 'r1' },
    eventStore,
    prisma: {},
    summary,
    messages,
    state: { verifyRounds: 1, planTasks: [{ id: 't1', title: 'Test', status: 'in_progress' }] },
  });
  const restored = await agentLoop.loadLatestContextSnapshot({ runId: 'r1', eventStore, prisma: {} });
  assert.equal(restored.summary, summary);
  assert.equal(restored.tailMessages.length, 10);
  assert.equal(restored.state.verifyRounds, 1);
});

test('tool permission resolution is ownership scoped and requeues the same run', async () => {
  const events = [
    {
      seq: 4,
      type: 'tool_permission_required',
      data: { permissionId: 'r1:a1', toolName: 'run_command', bindingHash: PERMISSION_BINDING, humanDescription: 'git status' },
    },
  ];
  let status = 'waiting_approval';
  const db = {
    codexProject: {},
    codexRun: {
      findFirst: async () => ({ id: 'r1', userId: 'u1', projectId: 'p1', mode: 'build', status }),
      updateMany: async ({ data }) => { status = data.status; return { count: 1 }; },
      update: async () => ({}),
      findUnique: async () => ({ id: 'r1', projectId: 'p1', mode: 'build', status }),
    },
  };
  const eventStore = {
    listEvents: async () => events,
    appendEvent: async (_runId, type, data) => {
      events.push({ seq: events.length + 5, type, data });
    },
  };
  let enqueued = null;
  const run = await runService.resolveToolPermission({
    userId: 'u1',
    runId: 'r1',
    permissionId: 'r1:a1',
    decision: 'allow',
    db,
    eventStore,
    queue: { enqueueCodexRun: async (args) => { enqueued = args; return { id: args.jobId }; } },
    clock: () => new Date(1000),
  });
  assert.equal(run.status, 'queued');
  assert.equal(enqueued.runId, 'r1');
  assert.equal(enqueued.jobId, 'r1-permission-1000');
  assert.equal(enqueued.jobId.includes(':'), false);
  assert.equal(events.some((event) => event.type === 'tool_permission_resolved'), true);
});

test('tool permissions are restored only until their durable one-shot consumption', async () => {
  const rows = [
    {
      seq: 1,
      type: 'tool_permission_resolved',
      data: { permissionId: 'p1', toolName: 'run_command', bindingHash: PERMISSION_BINDING, decision: 'allow' },
    },
  ];
  const eventStore = { listEvents: async () => rows };
  const first = await agentLoop.loadResolvedToolPermissions({
    runId: 'r1',
    eventStore,
    prisma: {},
  });
  assert.equal(first.has(PERMISSION_BINDING), true);
  assert.equal(first.permissionIds.get(PERMISSION_BINDING), 'p1');

  rows.push({
    seq: 2,
    type: 'tool_permission_consumed',
    data: { permissionId: 'p1', toolName: 'run_command', bindingHash: PERMISSION_BINDING },
  });
  const restored = await agentLoop.loadResolvedToolPermissions({
    runId: 'r1',
    eventStore,
    prisma: {},
  });
  assert.equal(restored.has('run_command'), false);
  assert.equal(restored.permissionIds.has(PERMISSION_BINDING), false);
});

test('tool permissions bind to effective args and MCP requires approval by default', () => {
  const base = {
    runId: 'r1',
    projectId: 'p1',
    toolName: 'run_command',
  };
  const first = hooks.permissionBindingHash({ ...base, args: { cmd: ['git', 'status'] } });
  const same = hooks.permissionBindingHash({ ...base, args: { cmd: ['git', 'status'] } });
  const changed = hooks.permissionBindingHash({ ...base, args: { cmd: ['git', 'reset', '--hard'] } });
  assert.equal(first, same);
  assert.notEqual(first, changed);

  assert.equal(hooks.requiresApproval({ brief: {} }, 'mcp_call', { tool: 'mcp__github__get_issue' }), true);
  assert.equal(
    hooks.requiresApproval(
      { brief: { permissions: { mcpAllowWithoutApproval: ['mcp__github__get_*'] } } },
      'mcp_call',
      { tool: 'mcp__github__get_issue' },
    ),
    false,
  );
  assert.equal(
    hooks.requiresApproval(
      { brief: { permissions: { mcpAllowWithoutApproval: ['mcp__github__get_*'] } } },
      'mcp_call',
      { tool: 'mcp__github__create_issue' },
    ),
    true,
  );
});
