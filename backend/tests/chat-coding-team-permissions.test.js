'use strict';

// Real chat assembly, permission manager and ReAct loop. Provider replies and
// runner I/O are explicit doubles; no external API or user workspace is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const permissions = require('../src/services/agent-harness/permission-manager');
const harness = require('../src/services/agent-harness/run-agent-turn');
const { runAgenticChat } = require('../src/services/agentic-chat-stream');

function toolReply(index, name, args) {
  return { choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: `permission-call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

async function runProtected(t, decision) {
  const controller = new AbortController();
  const res = new PassThrough(); res.setHeader = () => {};
  const events = [], calls = [];
  let writes = 0, pending = '';
  const timeout = setTimeout(() => controller.abort(), 3_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); res.destroy(); });
  const userId = `permissions-user-${randomUUID()}`;
  res.on('data', chunk => {
    pending += String(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.startsWith('data: {')) continue;
      const event = JSON.parse(line.slice(6)); events.push(event);
      if (event.type !== 'permission_request') continue;
      assert.equal(writes, 0, 'the real mutation cannot happen before approval');
      assert.equal(event.name, 'project_write');
      if (decision === 'abort') controller.abort();
      else {
        const foreign = permissions.resolvePermission({ permissionId: event.permissionId, decision: 'allow', userId: 'foreign-user' });
        assert.equal(foreign.ok, false, 'another user cannot approve this mutation');
        const result = permissions.resolvePermission({ permissionId: event.permissionId, decision, userId });
        assert.equal(result.ok, true);
      }
    }
  });
  const client = { chat: { completions: { create: async request => {
    calls.push(request);
    return calls.length === 1
      ? toolReply(calls.length, 'project_write', { path: 'proof.cjs', content: 'module.exports = 2;\n' })
      : toolReply(calls.length, 'finalize', { answer: 'No puedo confirmar el resultado.' });
  } } } };
  const result = await runAgenticChat({ openai: client, model: 'gpt-4o', provider: 'OpenAI',
    userQuery: 'Cambia proof.cjs a 2.', maxSteps: 4, maxRuntimeMs: 10_000, res, signal: controller.signal,
    toolContext: { userId, chatId: `permissions-chat-${randomUUID()}`, permission: 'protected',
      codingWorkspace: { projectId: 'permissions-project' }, projectTools: {
        binding: { findProjectForChat: async () => ({ id: 'permissions-project' }) },
        runner: { writeFiles: async (id, files) => {
          assert.equal(id, 'permissions-project'); assert.equal(files[0].path, 'proof.cjs');
          writes += 1; return { ok: true, written: 1 };
        } },
      } },
  });
  return { result, writes, events, calls };
}

for (const decision of ['deny', 'allow', 'abort']) {
  test(`coding project_write keeps the actual protected reviewer: ${decision}`, { timeout: 5_000 }, async t => {
    const state = await runProtected(t, decision);
    assert.equal(state.events.filter(event => event.type === 'permission_request').length, 1);
    assert.equal(state.writes, decision === 'allow' ? 1 : 0);
    const resolution = state.events.find(event => event.type === 'permission_resolved');
    assert.equal(resolution?.decision, decision === 'allow' ? 'allow' : 'deny');
    assert.ok(state.calls.every(request => request.model === 'gpt-4o'));
    const names = state.calls[0].tools.map(tool => tool.function.name);
    assert.ok(names.includes('run_subagent'));
    for (const name of ['host_bash', 'computer_click', 'document_edit', 'ws_write', 'run_javascript']) {
      assert.ok(!names.includes(name), `coding harness cannot add ${name} outside its audited tool surface`);
    }
    if (decision === 'abort') assert.notEqual(state.result.stoppedReason, 'finalized');
  });
}

test('coding fails closed if the permission harness cannot attach', { timeout: 5_000 }, async t => {
  const original = harness.attachHarness;
  harness.attachHarness = async () => { throw Object.assign(new Error('reviewer unavailable'), { code: 'reviewer_unavailable' }); };
  t.after(() => { harness.attachHarness = original; });
  await assert.rejects(runProtected(t, 'deny'), /reviewer unavailable|harness/i);
});

test('cancelling the coordinator aborts both child provider requests and never applies their proposals', { timeout: 5_000 }, async t => {
  const controller = new AbortController();
  const res = new PassThrough(); res.setHeader = () => {}; res.resume();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); res.destroy(); });
  const childSignals = [], calls = [];
  let writes = 0, saves = 0;
  const childQueries = ['CANCEL_LEFT: revisa left.cjs.', 'CANCEL_RIGHT: revisa right.cjs.'];
  const client = { chat: { completions: { create: async (request, options) => {
    calls.push(request);
    const query = request.messages.find(message => message.role === 'user')?.content;
    if (childQueries.includes(query)) {
      assert.ok(options?.signal, 'each real child provider request receives the linked cancellation signal');
      childSignals.push(options.signal);
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
        if (childSignals.length === 2) controller.abort();
      });
    }
    return toolReply(calls.length, 'run_subagent', { tasks: [
      { name: 'Izquierda', task: childQueries[0], files: ['left.cjs'] },
      { name: 'Derecha', task: childQueries[1], files: ['right.cjs'] },
    ] });
  } } } };
  const result = await runAgenticChat({ openai: client, model: 'gpt-4o', provider: 'OpenAI',
    userQuery: 'Revisa los dos archivos mediante colaboradores.', maxSteps: 16, maxRuntimeMs: 10_000, res, signal: controller.signal,
    toolContext: { userId: 'cancel-user', chatId: `cancel-chat-${randomUUID()}`, permission: 'workspace',
      codingWorkspace: { projectId: 'cancel-project' }, projectTools: {
        binding: { findProjectForChat: async () => ({ id: 'cancel-project' }) },
        runner: {
          writeFiles: async () => { writes += 1; return { ok: true, written: 1 }; },
          saveEditorFile: async () => { saves += 1; throw Error('cancelled work cannot be applied'); },
        },
      } },
  });
  assert.equal(childSignals.length, 2, 'the cancellation happens after both children actually start');
  assert.ok(childSignals.every(signal => signal.aborted));
  assert.equal(writes, 0); assert.equal(saves, 0);
  assert.ok(calls.every(request => request.model === 'gpt-4o'));
  assert.notEqual(result.stoppedReason, 'finalized');
});
