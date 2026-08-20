'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const flags = require('../src/services/computer/flags');
const {
  agentLoop,
  repeatedSameAction,
  actionFingerprint,
  MAX_STEPS,
} = require('../src/services/computer/agent-loop');
const { flattenA11y } = require('../src/services/computer/cdp-client');
const { createDeepSeekClient } = require('../src/services/computer/deepseek');

test('flag is off unless explicitly enabled (does not inherit F7 default-on)', () => {
  assert.equal(flags.agentComputerEnabled({}), false);
  assert.equal(flags.agentComputerEnabled({ SIRAGPT_AGENT_COMPUTER: '' }), false);
  assert.equal(flags.agentComputerEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(flags.agentComputerEnabled({ SIRAGPT_AGENT_COMPUTER: '1' }), true);
  assert.equal(flags.agentComputerEnabled({ NEXT_PUBLIC_AGENT_COMPUTER: '1' }), true);
  assert.equal(flags.agentComputerEnabled({ SIRAGPT_AGENT_COMPUTER: '0' }), false);
});

test('only DeepSeek V4 Flash / Pro are resolved', () => {
  assert.equal(flags.resolveComputerModel('anything'), 'deepseek-v4-flash');
  assert.equal(flags.resolveComputerModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(flags.resolveComputerModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(flags.resolveComputerModel('openrouter/foo'), 'deepseek-v4-flash');
});

test('DeepSeek models do not accept images unless allow-listed', () => {
  assert.equal(flags.modelAcceptsImages('deepseek-v4-flash', {}), false);
  assert.equal(flags.modelAcceptsImages('deepseek-v4-pro', {}), false);
  assert.equal(flags.modelAcceptsImages('deepseek-v4-flash', {
    COMPUTER_VISION_MODELS: 'deepseek-v4-flash',
  }), true);
});

test('observation mode defaults to cdp when the model has no vision', () => {
  assert.equal(flags.resolveObservationMode({ env: {} }), 'cdp');
  assert.equal(flags.resolveObservationMode({ cdpMode: true, env: {} }), 'cdp');
  assert.equal(flags.resolveObservationMode({
    cdpMode: false,
    model: 'deepseek-v4-flash',
    env: { COMPUTER_VISION_MODELS: 'deepseek-v4-flash', COMPUTER_CDP_DEFAULT: '0' },
  }), 'screenshot');
});

test('repeatedSameAction trips on the third identical fingerprint', () => {
  const click = actionFingerprint({ type: 'click', x: 10, y: 20 });
  assert.equal(repeatedSameAction([click]), false);
  assert.equal(repeatedSameAction([click, click]), false);
  assert.equal(repeatedSameAction([click, click, click]), true);
  assert.equal(repeatedSameAction([click, click, actionFingerprint({ type: 'type', text: 'a' })]), false);
});

test('agentLoop aborts after the same action repeats 3 times', async () => {
  const actions = [];
  const result = await agentLoop({
    goal: 'open settings',
    agentUrl: 'http://127.0.0.1:9',
    cdpUrl: 'http://127.0.0.1:9',
    env: { COMPUTER_CDP_DEFAULT: '1' },
    createClient: async () => ({}),
    complete: async () => ({ action: { type: 'click', x: 1, y: 1 } }),
    observe: async () => ({ text: 'desktop' }),
    act: async ({ action }) => { actions.push(action); },
  });
  assert.equal(result.stoppedReason, 'repeated_action');
  assert.equal(result.steps, 3);
  assert.equal(actions.length, 2);
  assert.equal(result.mode, 'cdp');
  assert.equal(result.model, 'deepseek-v4-flash');
});

test('agentLoop stops on done and respects max 25 steps', async () => {
  let n = 0;
  const done = await agentLoop({
    goal: 'finish',
    createClient: async () => ({}),
    complete: async () => ({ action: { type: 'done', result: 'ok' } }),
    observe: async () => ({ text: 'ok' }),
    act: async () => { throw new Error('should not act'); },
  });
  assert.equal(done.stoppedReason, 'done');
  assert.equal(done.ok, true);

  const capped = await agentLoop({
    goal: 'wander',
    maxSteps: MAX_STEPS,
    createClient: async () => ({}),
    complete: async () => {
      n += 1;
      return { action: { type: 'move', x: n, y: n } };
    },
    observe: async () => ({ text: 'ok' }),
    act: async () => {},
  });
  assert.equal(capped.stoppedReason, 'max_steps');
  assert.equal(capped.steps, 25);
});

test('agentLoop uses screenshot observation only when the model accepts images', async () => {
  const modes = [];
  await agentLoop({
    goal: 'look',
    model: 'deepseek-v4-flash',
    cdpMode: false,
    env: { COMPUTER_VISION_MODELS: 'deepseek-v4-flash', COMPUTER_CDP_DEFAULT: '0' },
    createClient: async () => ({}),
    complete: async () => ({ action: { type: 'done' } }),
    observe: async ({ mode }) => {
      modes.push(mode);
      return { png: 'aaaa' };
    },
    act: async () => {},
  });
  assert.deepEqual(modes, ['screenshot']);
});

test('agentLoop ensures /workspace/<task-id>/ and logs taskId per step', async () => {
  const tasks = [];
  const result = await agentLoop({
    goal: 'save a file',
    taskId: 'task-77',
    createClient: async () => ({}),
    complete: async () => ({ action: { type: 'done', result: 'ok' } }),
    observe: async () => ({ text: 'desktop' }),
    ensureTask: async ({ taskId }) => {
      tasks.push(taskId);
      return { path: taskId, workspacePath: `/workspace/${taskId}` };
    },
    act: async () => {},
  });
  assert.deepEqual(tasks, ['task-77']);
  assert.equal(result.taskId, 'task-77');
  assert.equal(result.log[0].taskId, 'task-77');
  assert.match(require('../src/services/computer/agent-loop').systemPrompt('cdp', 'g', 'task-77'), /\/workspace\/task-77/);
});

test('flattenA11y walks the accessibility tree into text', () => {
  const text = flattenA11y({
    role: 'RootWebArea',
    name: 'Example',
    children: [{ role: 'button', name: 'OK' }],
  }).join('\n');
  assert.match(text, /RootWebArea/);
  assert.match(text, /button "OK"/);
});

test('createDeepSeekClient refuses to construct without a key and never uses OpenRouter', () => {
  assert.throws(
    () => createDeepSeekClient({ env: {} }),
    /DEEPSEEK_API_KEY/,
  );
  const client = createDeepSeekClient({
    env: { DEEPSEEK_API_KEY: 'sk-test' },
    createClient: () => ({ baseURL: 'https://api.deepseek.com', marker: true }),
  });
  assert.equal(client.marker, true);
});
