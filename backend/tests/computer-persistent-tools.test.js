'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const persistent = require('../src/services/computer/persistent');
const flags = require('../src/services/computer/flags');
const tools = require('../src/services/computer/computer-tools');
const control = require('../src/services/computer/control-loop');
const cdp = require('../src/services/computer/cdp-client');
describe('memberKey / persistent session', () => {
  test('memberKey is per user, not per department', () => {
    assert.equal(persistent.memberKey('user-42'), 'member:user-42');
    assert.equal(persistent.memberKey('user-42'), persistent.memberKey('user-42'));
    assert.notEqual(persistent.memberKey('user-42'), persistent.memberKey('user-99'));
  });

  test('ensureSession POSTs userId to the orchestrator', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          sessionId: 'sess-1',
          userId: 'user-42',
          agentUrl: 'http://127.0.0.1:8080',
          cdpUrl: 'http://127.0.0.1:9222',
          persistent: true,
        }),
      };
    };
    const session = await persistent.ensureSession('user-42', {
      env: { COMPUTER_ORCH_URL: 'http://orch.local', COMPUTER_ORCH_SECRET: 's3cret' },
      fetchImpl,
    });
    assert.equal(session.userId, 'user-42');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sessions$/);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { userId: 'user-42' });
  });
});

describe('selectComputerExecutor prefers persistent over webtop', () => {
  test('persistent wins when both backends claim availability', () => {
    const selected = persistent.selectComputerExecutor({
      userId: 'user-42',
      env: { COMPUTER_ORCH_URL: 'http://orch.local', COMPUTER_ORCH_SECRET: 's3cret' },
      webtop: { isAvailable: () => true, kind: 'webtop' },
    });
    assert.equal(selected.kind, 'persistent');
    assert.equal(selected.reason, 'member_session');
    assert.equal(selected.memberKey, 'member:user-42');
  });

  test('webtop is only used when persistent is unavailable', () => {
    const selected = persistent.selectComputerExecutor({
      userId: 'user-42',
      env: {},
      persistent: { isAvailable: () => false },
      webtop: { isAvailable: () => true },
    });
    assert.equal(selected.kind, 'webtop');
    assert.equal(selected.reason, 'fallback_only');
  });

  test('computer tools require the persistent executor, not webtop', async () => {
    const desktop = tools.buildComputerTools({
      userId: 'user-42',
      env: {},
      persistent: { isAvailable: () => false },
      webtop: { isAvailable: () => true },
    });
    const click = desktop.find((t) => t.name === 'computer_click');
    const typed = await click.execute({ x: 10, y: 20 }, { userId: 'user-42' });
    assert.match(String(typed), /webtop desktop is not used|persistent member desktop is not available/);
    assert.doesNotMatch(String(typed), /CEO Office/i);
  });
});

describe('computerOnly tool set', () => {
  test('narrow set is computer_* plus web_search and read_url', () => {
    const names = tools.buildComputerOnlyTools({ userId: 'user-42' }, [
      { name: 'web_search', execute: async () => 'ok' },
      { name: 'read_url', execute: async () => 'ok' },
      { name: 'host_bash', execute: async () => 'nope' },
      { name: 'create_document', execute: async () => 'nope' },
    ]).map((t) => t.name);
    assert.deepEqual(names, [
      'computer_navigate',
      'computer_screenshot',
      'computer_click',
      'computer_type',
      'web_search',
      'read_url',
    ]);
    assert.ok(!names.includes('host_bash'));
    assert.ok(!names.includes('create_document'));
    assert.ok(!names.includes('generate_image'));
  });

  test('descriptions never mention webtop CEO Office', () => {
    const desktop = tools.buildComputerTools({ userId: 'user-42' });
    const blob = desktop.map((t) => `${t.name} ${t.description}`).join('\n');
    assert.doesNotMatch(blob, /webtop/i);
    assert.doesNotMatch(blob, /CEO Office/i);
    assert.ok(desktop.some((t) => t.name === 'computer_click'));
    assert.ok(desktop.some((t) => t.name === 'computer_type'));
  });

  test('system instruction requires navigate → screenshot → click/type', () => {
    assert.match(tools.COMPUTER_SYSTEM_INSTRUCTION, /computer_navigate/);
    assert.match(tools.COMPUTER_SYSTEM_INSTRUCTION, /computer_screenshot/);
    assert.match(tools.COMPUTER_SYSTEM_INSTRUCTION, /computer_click/);
    assert.match(tools.COMPUTER_SYSTEM_INSTRUCTION, /computer_type/);
    assert.match(tools.COMPUTER_SYSTEM_INSTRUCTION, /computer\.siragpt\.com/);
    assert.doesNotMatch(tools.COMPUTER_SYSTEM_INSTRUCTION, /chatagic/i);
    assert.doesNotMatch(tools.COMPUTER_SYSTEM_INSTRUCTION, /webtop/i);
    assert.doesNotMatch(tools.COMPUTER_SYSTEM_INSTRUCTION, /OpenRouter/i);
  });
});

describe('disableAgentic still attaches computer-only tools', () => {
  test('resolveComputerOnlyTurn is true for /code disableAgentic + member + flag', () => {
    assert.equal(persistent.resolveComputerOnlyTurn({
      disableAgentic: true,
      publicWebReadonly: false,
      userId: 'user-42',
      toolCallMode: 'prompted',
      env: { SIRAGPT_AGENT_COMPUTER: '1' },
    }), true);
  });

  test('resolveComputerOnlyTurn stays off without a member or when tools are none', () => {
    assert.equal(persistent.resolveComputerOnlyTurn({
      disableAgentic: true,
      userId: '',
      toolCallMode: 'prompted',
      env: { SIRAGPT_AGENT_COMPUTER: '1' },
    }), false);
    assert.equal(persistent.resolveComputerOnlyTurn({
      disableAgentic: true,
      userId: 'user-42',
      toolCallMode: 'none',
      env: { SIRAGPT_AGENT_COMPUTER: '1' },
    }), false);
  });
});

describe('control loop bounds and CDP observation', () => {
  test('caps steps at 25 and never invents a destroy TTL', () => {
    assert.equal(control.MAX_CONTROL_STEPS, 25);
    assert.equal(control.capControlSteps(100), 25);
    assert.equal(control.capControlSteps(4), 4);
    assert.equal(persistent.isConfigured({}), false);
  });

  test('aborts when the same computer action repeats 3 times', async () => {
    const guarded = control.withRepeatGuard([
      {
        name: 'computer_click',
        async execute() { return 'clicked'; },
      },
    ]);
    assert.equal(await guarded[0].execute({ x: 1, y: 1 }), 'clicked');
    assert.equal(await guarded[0].execute({ x: 1, y: 1 }), 'clicked');
    const third = await guarded[0].execute({ x: 1, y: 1 });
    assert.match(third, /repeated_action/);
  });

  test('models without vision observe via CDP accessibility tree, not PNG', async () => {
    assert.equal(flags.resolveObservationMode({
      model: 'deepseek-v4-flash',
      env: {},
    }), 'cdp');
    assert.equal(flags.resolveComputerModel('openrouter/gpt-4o'), flags.DEEPSEEK_FLASH);
    assert.equal(flags.publicComputerHost({ COMPUTER_PUBLIC_HOST: 'computer.chatagic.com' }), 'computer.siragpt.com');

    const observation = await persistent.observe('user-42', {
      session: { sessionId: 'sess-1', cdpUrl: 'http://127.0.0.1:9222', agentUrl: 'http://127.0.0.1:8080' },
      model: 'deepseek-v4-flash',
      env: {},
      cdpConnect: async () => ({ url: 'https://example.com', title: 'Example', text: 'url: https://example.com\nbutton "Go"' }),
    });
    assert.equal(observation.mode, 'cdp');
    assert.match(observation.text, /button "Go"/);
    assert.equal(observation.png, undefined);
  });

  test('flattenA11y is a text tree, not a screenshot payload', () => {
    const text = cdp.flattenA11y({
      role: 'WebArea',
      name: 'Home',
      children: [{ role: 'button', name: 'Login' }],
    }).join('\n');
    assert.match(text, /WebArea "Home"/);
    assert.match(text, /button "Login"/);
  });
});

describe('computer_* executors hit the persistent session', () => {
  test('click and type POST /action on the member agent', async () => {
    const actions = [];
    const client = {
      ensureSession: async () => ({ sessionId: 'sess-1', agentUrl: 'http://agent', cdpUrl: 'http://cdp' }),
      async click(_userId, args) {
        actions.push(['click', args]);
        return { ok: true };
      },
      async typeText(_userId, args) {
        actions.push(['type', args]);
        return { ok: true };
      },
      async navigate() { return { url: 'https://example.com' }; },
      async observe() { return { mode: 'cdp', text: 'tree', session: { sessionId: 'sess-1' } }; },
    };
    const desktop = tools.buildComputerTools({
      userId: 'user-42',
      client,
      env: { COMPUTER_ORCH_URL: 'http://orch', COMPUTER_ORCH_SECRET: 'x' },
    });
    const click = desktop.find((t) => t.name === 'computer_click');
    const type = desktop.find((t) => t.name === 'computer_type');
    const clickResult = JSON.parse(await click.execute({ x: 8, y: 16 }, { userId: 'user-42' }));
    const typeResult = JSON.parse(await type.execute({ text: 'hola' }, { userId: 'user-42' }));
    assert.equal(clickResult.backend, 'persistent');
    assert.equal(typeResult.backend, 'persistent');
    assert.deepEqual(actions, [
      ['click', { x: 8, y: 16 }],
      ['type', { text: 'hola' }],
    ]);
  });
});
