'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { run } = require('../src/services/react-agent');
const { prepareDeepSeekDirectToolRequest, withDeepSeekDirectModelIds } = require('../src/services/ai/deepseek-billing-failover');
const { safeReadFile, safeWriteFiles } = require('../../scripts/code-runner-fs-helper');

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const forced = (name) => ({ type: 'function', function: { name } });
const client = (create) => ({ chat: { completions: { create } } });
const schema = [{ type: 'function', function: { name: 'project_list', parameters: { type: 'object', properties: {} } } }];

// This double implements the direct API's documented rejection, rather than
// accepting every payload: thinking defaults to enabled and forced choice 400s.
function rejectUnsupportedThinkingChoice(body) {
  if (body.thinking?.type === 'disabled' || body.reasoning_effort === 'none') return;
  if (body.tool_choice === 'required' || body.tool_choice?.type === 'function') {
    const error = new Error('tool_choice required/named is not supported in thinking mode');
    error.status = 400;
    throw error;
  }
}

test('direct V4 adapters repair the actual default-thinking 400 without changing model, thinking, tools or history', async () => {
  for (const toolChoice of [forced('project_list'), forced('finalize'), 'required']) {
    const messages = [
      { role: 'system', content: 'Native tool contract' },
      { role: 'assistant', content: null, reasoning_content: 'original reasoning\n  exact', tool_calls: [call('first', 'project_list')] },
      { role: 'tool', tool_call_id: 'first', content: '{"files":["app.js"]}' },
    ];
    const body = { model: 'deepseek/deepseek-v4-pro', tools: schema, tool_choice: toolChoice, messages };
    const original = structuredClone(body);
    const options = { signal: new AbortController().signal };
    let received;
    const direct = client(async (payload, requestOptions) => {
      rejectUnsupportedThinkingChoice(payload);
      assert.equal(requestOptions, options);
      received = payload;
      return { choices: [] };
    });
    await assert.rejects(() => direct.chat.completions.create(body, options), { status: 400 });
    await withDeepSeekDirectModelIds(direct).chat.completions.create(body, options);
    assert.equal(received.model, 'deepseek-v4-pro');
    assert.equal(received.tool_choice, 'auto');
    assert.equal(received.thinking, undefined, 'the provider default is preserved');
    assert.equal(received.tools, schema, 'the full schema remains unchanged');
    assert.equal(received.messages[1].content, '');
    assert.equal(received.messages[1].reasoning_content, messages[1].reasoning_content);
    assert.deepEqual(received.messages[1].tool_calls, messages[1].tool_calls);
    assert.match(received.messages.at(-1).content, toolChoice === 'required' ? /at least one provided function/ : new RegExp(`"${toolChoice.function.name}"`));
    assert.deepEqual(body, original, 'request adaptation never rewrites the cached transcript');
    assert.deepEqual(prepareDeepSeekDirectToolRequest(received), received, 'nested direct wrappers do not duplicate suffixes');
  }
});

test('historical assistant turns without reasoning remain replayable in thinking without fabricating CoT or rewriting checkpoints', async () => {
  const messages = [
    { role: 'user', content: 'Historical query' },
    { role: 'assistant', content: null, tool_calls: [call('old', 'project_list')] },
    { role: 'tool', tool_call_id: 'old', content: '{"files":[]}' },
    { role: 'assistant', content: 'Historical plain answer' },
    { role: 'assistant', content: 'Actual thinking response', reasoning_content: '  actual reasoning\nexact ' },
    { role: 'assistant', content: null, reasoning_content: null },
    { role: 'assistant', content: null, reasoning_content: undefined },
  ];
  const body = { model: 'deepseek-v4-pro', messages, tools: schema, tool_choice: 'auto' };
  const original = structuredClone(body);
  const strict = client(async (payload) => {
    for (const assistant of payload.messages.filter((message) => message.role === 'assistant')) {
      if (typeof assistant.reasoning_content !== 'string') {
        const error = new Error('Missing reasoning_content in assistant replay'); error.status = 400; throw error;
      }
    }
    return payload;
  });
  await assert.rejects(() => strict.chat.completions.create(body), { status: 400 });
  const result = await withDeepSeekDirectModelIds(strict).chat.completions.create(body);
  assert.equal(result.messages[1].reasoning_content, '');
  assert.equal(result.messages[3].reasoning_content, '');
  assert.equal(result.messages[4].reasoning_content, messages[4].reasoning_content);
  assert.equal(result.messages[3].content, messages[3].content);
  for (const index of [5, 6]) {
    assert.equal(result.messages[index].reasoning_content, '');
    assert.equal(result.messages[index].content, '');
  }
  assert.equal(result.messages.length, messages.length, 'normal auto calls add no protocol suffix');
  assert.deepEqual(body, original);
  const disabled = prepareDeepSeekDirectToolRequest({ ...body, thinking: { type: 'disabled' } });
  assert.ok(!('reasoning_content' in disabled.messages[1]));
});

test('explicit thinking states keep supported choices and scope adaptation to direct V4', () => {
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-flash']) {
    for (const state of [{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }, { reasoning_effort: 'max' }, {}]) {
      const input = { model, messages: [{ role: 'user', content: 'edit' }], tools: schema, tool_choice: forced('project_list'), ...state };
      const output = prepareDeepSeekDirectToolRequest(input);
      rejectUnsupportedThinkingChoice(output);
      assert.equal(output.tool_choice, 'auto');
      assert.equal(output.thinking, input.thinking);
      assert.equal(output.reasoning_effort, input.reasoning_effort);
    }
    for (const state of [{ thinking: { type: 'disabled' } }, { reasoning_effort: 'none' }]) {
      const input = { model, messages: [], tools: schema, tool_choice: forced('project_list'), ...state };
      assert.equal(prepareDeepSeekDirectToolRequest(input), input, 'non-thinking supports forced choices');
    }
    for (const toolChoice of ['none', 'auto']) {
      const input = { model, messages: [], tools: schema, tool_choice: toolChoice };
      assert.equal(prepareDeepSeekDirectToolRequest(input), input);
    }
  }
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o', 'grok-4.6']) {
    const input = { model, messages: [], tools: schema, tool_choice: forced('project_list') };
    assert.equal(prepareDeepSeekDirectToolRequest(input), input);
  }
});

test('native loop preserves first-tool/finalize contracts for non-thinking V4 and other providers', async () => {
  const cases = [
    { provider: 'DeepSeek', model: 'deepseek-v4-pro', thinkingLevel: 'low', thinkingLevelExplicit: true },
    { provider: 'DeepSeek', model: 'deepseek-v4-pro', thinkingLevel: 'disabled', thinkingLevelExplicit: true },
    { provider: 'DeepSeek', model: 'deepseek/deepseek-v4-pro', thinkingLevel: 'low', thinkingLevelExplicit: true },
    { provider: 'DeepSeek', model: 'deepseek/deepseek-v4-pro', thinkingLevel: 'disabled', thinkingLevelExplicit: true },
    { provider: 'OpenAI', model: 'gpt-4o' },
    { provider: 'xAI', model: 'grok-4.6' },
    { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro' },
  ];
  for (const sample of cases) {
    const requests = [];
    const native = client(async (body) => {
      requests.push(structuredClone(body));
      const name = requests.length === 1 ? 'project_list' : 'finalize';
      assert.deepEqual(body.tool_choice, forced(name));
      if (sample.provider === 'DeepSeek') {
        assert.deepEqual(body.thinking, { type: 'disabled' });
        rejectUnsupportedThinkingChoice(body);
      }
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [call(`n${requests.length}`, name, name === 'finalize' ? { answer: 'Verified.' } : {})] } }] };
    });
    const result = await run(native, { query: 'Read the project', model: sample.model, ctx: { provider: sample.provider }, tools: [{ name: 'project_list', description: 'List', parameters: { type: 'object', properties: {} }, execute: async () => ({ files: ['app.js'] }) }], initialToolChoice: 'project_list', maxSteps: 2, ...sample });
    assert.equal(result.stoppedReason, 'finalized', sample.provider);
    assert.ok(requests.every((request) => request.model === sample.model));
    assert.deepEqual(requests[0].tools, requests[1].tools);
  }
});

test('DeepSeek default/high thinking edits, rereads and executes the same real persistent project through canonical chat', async () => {
  for (const effort of [{}, { thinkingLevel: 'high', thinkingLevelExplicit: true }, { thinkingLevel: 'max', thinkingLevelExplicit: true, model: 'deepseek/deepseek-v4-pro' }]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-deepseek-code-'));
    const before = 'module.exports = 1;\n';
    const after = 'module.exports = 2;\n';
    await fs.writeFile(path.join(root, 'app.js'), before);
    await fs.writeFile(path.join(root, 'app.test.js'), "require('node:test')('export value', () => require('node:assert/strict').equal(require('./app'), 2));\n");
    const runnerCalls = [], requests = [], emitted = [], observed = [];
    const binding = { findProjectForChat: async () => ({ id: 'persistent-project' }) };
    const runner = {
      async readFile(id, rel) { runnerCalls.push(id); const result = safeReadFile(root, rel); observed.push(result.content); return result; },
      async writeFiles(id, files) { runnerCalls.push(id); return { ok: true, ...safeWriteFiles(root, files) }; },
      async exec(id, cmd) {
        runnerCalls.push(id);
        if (cmd[0] === 'git') return { ok: true, stdout: 'app.js\n', exitCode: 0 };
        const childEnv = { ...process.env };
        delete childEnv.NODE_TEST_CONTEXT; // The project suite runs independently of this test worker.
        const result = await promisify(execFile)(cmd[0], cmd.slice(1), { cwd: root, env: childEnv });
        return { ok: true, ...result, exitCode: 0 };
      },
    };
    const plan = [
      ['project_list', {}], ['project_read', { path: 'app.js' }],
      ['project_write', { path: 'app.js', content: after }],
      ['project_exec', { cmd: ['node', '--test', 'app.test.js'] }],
      ['project_read', { path: 'app.js' }],
      ['finalize', { answer: 'Actualicé app.js, releí el archivo guardado y pasó la prueba.' }],
    ];
    const direct = client(async (body) => {
      rejectUnsupportedThinkingChoice(body);
      assert.equal(body.model, 'deepseek-v4-pro');
      assert.equal(body.tool_choice, 'auto');
      for (const assistant of body.messages.filter((message) => message.role === 'assistant')) {
        const original = emitted.find((message) => message.tool_calls[0].id === assistant.tool_calls[0].id);
        assert.equal(assistant.content, '');
        assert.equal(assistant.reasoning_content, original.reasoning_content, 'exact original reasoning is replayed');
        assert.deepEqual(assistant.tool_calls, original.tool_calls);
      }
      if (effort.thinkingLevel) {
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, effort.thinkingLevel);
      } else assert.equal(body.thinking, undefined);
      requests.push(structuredClone(body));
      const [name, args] = plan[requests.length - 1];
      const message = { role: 'assistant', content: null, reasoning_content: `reasoning ${requests.length}\n  preserved`, tool_calls: [call(`step_${requests.length}`, name, args)] };
      emitted.push(structuredClone(message));
      return { choices: [{ message }] };
    });
    const res = new PassThrough(); res.resume(); res.setHeader = () => {};
    try {
      const result = await require('../src/services/agentic-chat-stream').runAgenticChat({
        openai: withDeepSeekDirectModelIds(direct), model: 'deepseek-v4-pro', provider: 'DeepSeek',
        userQuery: 'Cambia app.js a 2, relee y comprueba con node.', res, toolsOverride: [], maxSteps: plan.length, ...effort,
        toolContext: { userId: 'u1', chatId: 'owned-chat', permission: 'workspace', codingWorkspace: { projectId: 'persistent-project' }, projectTools: { runner, binding } },
      });
      assert.equal(result.stoppedReason, 'finalized');
      assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), after);
      assert.deepEqual(observed, [before, after]);
      assert.deepEqual(new Set(runnerCalls), new Set(['persistent-project']));
      assert.equal(requests.length, plan.length);
      assert.match(requests[0].messages.at(-1).content, /"project_list"/);
      assert.match(requests.at(-1).messages.at(-1).content, /"finalize"/);
      assert.ok(requests.every((request) => JSON.stringify(request.tools) === JSON.stringify(requests[0].tools)));
      assert.match(result.finalAnswer, /pasó la prueba/);
    } finally { res.destroy(); await fs.rm(root, { recursive: true, force: true }); }
  }
});
