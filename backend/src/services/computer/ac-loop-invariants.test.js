'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const flags = require('./flags');
const control = require('./control-loop');
const cdp = require('./cdp-client');
const persistent = require('./persistent');

describe('computer control loop 25/3 + cdpMode', () => {
  test('caps steps at 25', () => {
    assert.equal(control.MAX_CONTROL_STEPS, 25);
    assert.equal(control.capControlSteps(100), 25);
    assert.equal(control.capControlSteps(4), 4);
    assert.equal(flags.MAX_CONTROL_STEPS, 25);
    assert.equal(flags.REPEAT_ACTION_LIMIT, 3);
  });

  test('aborts when the same computer action repeats 3 times', async () => {
    const guarded = control.withRepeatGuard([
      { name: 'computer_click', async execute() { return 'clicked'; } },
    ]);
    assert.equal(await guarded[0].execute({ x: 1, y: 1 }), 'clicked');
    assert.equal(await guarded[0].execute({ x: 1, y: 1 }), 'clicked');
    const third = await guarded[0].execute({ x: 1, y: 1 });
    assert.match(String(third), /repeated_action/);
  });

  test('DeepSeek without vision observes via CDP, not PNG', () => {
    assert.equal(flags.resolveObservationMode({ model: 'deepseek-v4-flash', env: {} }), 'cdp');
    assert.equal(flags.resolveObservationMode({ model: 'deepseek-v4-pro', env: {} }), 'cdp');
    assert.equal(flags.resolveComputerModel('openrouter/gpt-4o'), flags.DEEPSEEK_FLASH);
    assert.equal(flags.publicComputerHost({ COMPUTER_PUBLIC_HOST: 'computer.chatagic.com' }), 'siragpt.com');
    assert.equal(flags.publicComputerHost({ AGENT_COMPUTER_PUBLIC_BASE: 'https://computer.siragpt.com' }), 'siragpt.com');
  });

  test('observe() returns CDP text and never a PNG when cdpConnect is used', async () => {
    const observation = await persistent.observe({
      sessionId: 'sess-1',
      cdpUrl: 'http://127.0.0.1:9222',
      agentUrl: 'http://127.0.0.1:8080',
    }, {
      model: 'deepseek-v4-flash',
      env: {},
      cdpConnect: async () => ({ url: 'https://example.com', title: 'Example', text: 'url: https://example.com\nbutton "Go"' }),
    });
    assert.equal(observation.mode, 'cdp');
    assert.match(observation.text, /button "Go"/);
    assert.equal(observation.png, undefined);
  });

  test('rewriteCdpWs maps localhost debugger URL onto the orch proxy', () => {
    const ws = cdp.rewriteCdpWs(
      'ws://127.0.0.1:9222/devtools/page/ABC',
      'http://siragpt-computer-orchestrator:8090/sessions/sid1/cdp',
    );
    assert.equal(ws, 'ws://siragpt-computer-orchestrator:8090/sessions/sid1/cdp/devtools/page/ABC');
  });

  test('existing persistent helpers remain exported', () => {
    assert.equal(typeof persistent.ensureSession, 'function');
    assert.equal(typeof persistent.agentGet, 'function');
    assert.equal(typeof persistent.agentPost, 'function');
    assert.equal(typeof persistent.dockerExec, 'function');
    assert.equal(typeof persistent.observe, 'function');
    assert.equal(typeof persistent.computerToolsAvailable, 'function');
  });
});
