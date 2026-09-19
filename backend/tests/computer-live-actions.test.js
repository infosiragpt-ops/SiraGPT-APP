'use strict';

/**
 * Tests for the Claude-style live browser: chat computer tools act on the
 * SAME per-chat container browser the user watches (live-actions.js), plus
 * the new computer_scroll / computer_keypress tools and the side-panel
 * activity feed.
 *
 * Fully offline: persistent session, login-handoff verdicts and the
 * orchestrator HTTP layer are stubbed. The action mapper stays real so
 * coordinate clamping and key normalisation are genuinely exercised.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SERVICE_DIR = path.resolve(__dirname, '../src/services');
const COMPUTER_DIR = path.join(SERVICE_DIR, 'computer');

// ── Stubs (registered before loading the units under test) ────────────────

const fetchCalls = [];
let fetchHandler = null;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
  if (fetchHandler) return fetchHandler(url, opts);
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

let refuseNext = { refuse: false };
const loginHandoffStub = {
  refuseAgentType: () => refuseNext,
  detectLoginGate: () => ({ site: 'test', kind: 'password' }),
  beginTakeover: () => ({ event: 'takeover' }),
  getTakeover: () => ({ active: true }),
  loginHandoffToolResult: (gate) => ({ ok: false, loginHandoff: true, site: gate && gate.site }),
  waitUntilReleased: async () => ({ released: true }),
  loginHandoffResumeResult: () => ({ ok: true, resumed: true }),
};

const persistentStub = {
  ensureSession: async ({ userId, conversationId }) => ({
    sessionId: 'sess-1',
    userId,
    conversationId,
  }),
  peekPage: async () => ({ url: 'https://ejemplo.com/form', title: 'Formulario', text: 'Nombre:' }),
};

require.cache[require.resolve(path.join(COMPUTER_DIR, 'login-handoff'))] = { exports: loginHandoffStub };
require.cache[require.resolve(path.join(COMPUTER_DIR, 'persistent'))] = { exports: persistentStub };

const liveActions = require(path.join(COMPUTER_DIR, 'live-actions'));
const chatComputer = require(path.join(COMPUTER_DIR, 'chat-computer-tools'));

const TEST_ENV = { SIRAGPT_AGENT_COMPUTER: '1', NODE_ENV: 'test' };

function owner() {
  return { userId: 'user-1', conversationId: 'chat-1', env: TEST_ENV };
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchHandler = null;
  refuseNext = { refuse: false };
});

afterEach(() => {
  if (global.fetch !== realFetch && fetchCalls.length >= 0) { /* keep stub for whole file */ }
});

// ── Action builders (pure) ────────────────────────────────────────────────

describe('live-actions builders', () => {
  test('scrollAction maps directions to scroll vectors', () => {
    assert.deepEqual(liveActions.scrollAction({ direction: 'down' }), { type: 'scroll', scrollX: 0, scrollY: 500 });
    assert.deepEqual(liveActions.scrollAction({ direction: 'up', amount: 1000 }), { type: 'scroll', scrollX: 0, scrollY: -1000 });
    assert.deepEqual(liveActions.scrollAction({ dx: 10, dy: -20 }), { type: 'scroll', scrollX: 10, scrollY: -20 });
  });

  test('scrollAction rejects empty specs', () => {
    assert.throws(() => liveActions.scrollAction({}), { code: 'E_PARAMS' });
    assert.throws(() => liveActions.scrollAction({ direction: 'diagonal' }), { code: 'E_PARAMS' });
  });

  test('keypressAction normalises keys and modifiers', () => {
    assert.deepEqual(liveActions.keypressAction({ key: 'ENTER' }), { type: 'keypress', keys: ['Enter'] });
    assert.deepEqual(
      liveActions.keypressAction({ key: 'tab', modifiers: ['shift'] }),
      { type: 'keypress', keys: ['Shift', 'Tab'] }
    );
  });

  test('keypressAction requires a key', () => {
    assert.throws(() => liveActions.keypressAction({}), { code: 'E_PARAMS' });
  });

  test('activity feed counts steps per conversation', () => {
    const a1 = liveActions.recordActivity('chat-A', { action: 'computer_click', url: 'https://a.com' });
    const a2 = liveActions.recordActivity('chat-A', { action: 'computer_type', url: 'https://a.com/x' });
    const b1 = liveActions.recordActivity('chat-B', { action: 'computer_navigate', url: 'https://b.com' });
    assert.equal(a1.step, 1);
    assert.equal(a2.step, 2);
    assert.equal(a2.lastAction, 'computer_type');
    assert.equal(a2.lastUrl, 'https://a.com/x');
    assert.equal(b1.step, 1, 'conversations are isolated');
    assert.deepEqual(liveActions.getActivity('chat-A'), a2);
    assert.equal(liveActions.getActivity('chat-missing'), null);
  });
});

// ── liveAct forwarding ────────────────────────────────────────────────────

describe('liveAct forwards to the live container session', () => {
  test('click reaches the orchestrator agent/action endpoint', async () => {
    const out = await liveActions.liveAct({
      ...owner(),
      toolName: 'computer_click',
      action: { type: 'click', x: 100, y: 200, button: 'left' },
    });
    assert.equal(out.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/sessions\/sess-1\/agent\/action/);
    const sent = JSON.parse(fetchCalls[0].body);
    assert.equal(sent.type, 'click');
    assert.equal(sent.x, 100);
    assert.equal(out.activity.step >= 1, true);
    assert.equal(out.activity.lastUrl, 'https://ejemplo.com/form');
  });

  test('refused actions never touch the network', async () => {
    refuseNext = { refuse: true, reason: 'password wall' };
    const out = await liveActions.liveAct({
      ...owner(),
      toolName: 'computer_type',
      action: { type: 'type', text: 'hunter2' },
      text: 'hunter2',
    });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(fetchCalls.length, 0);
    assert.equal(out.result.loginHandoff, true);
  });

  test('liveScreenshot returns vision payload plus page context', async () => {
    fetchHandler = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, screenshot: { base64: 'a'.repeat(200), mediaType: 'image/png' } }),
    });
    const out = await liveActions.liveScreenshot(owner());
    assert.equal(out.ok, true);
    assert.equal(out.url, 'https://ejemplo.com/form');
    assert.match(out.text, /ejemplo\.com/);
    assert.ok(out.__f7Image && out.__f7Image.base64.length > 100);
  });
});

// ── Chat tool surface ─────────────────────────────────────────────────────

describe('chat computer tools (live)', () => {
  test('offers scroll + keypress alongside the classic tools', () => {
    const tools = chatComputer.buildChatComputerTools(owner());
    const names = tools.map((t) => t.name);
    for (const name of [
      'computer_screenshot',
      'computer_click',
      'computer_type',
      'computer_scroll',
      'computer_keypress',
      'computer_navigate',
      'computer_list_files',
      'computer_read_file',
      'computer_write_file',
      'computer_edit_file',
    ]) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }
  });

  test('stays hidden when the flag is off', () => {
    assert.deepEqual(
      chatComputer.buildChatComputerTools({ userId: 'u', conversationId: 'c', env: { NODE_ENV: 'test' } }),
      []
    );
  });

  function tool(name) {
    return chatComputer.buildChatComputerTools(owner()).find((t) => t.name === name);
  }

  test('computer_scroll drives the live page', async () => {
    const r = await tool('computer_scroll').execute({ direction: 'down', amount: 800 }, {});
    assert.equal(r.ok, true);
    const sent = JSON.parse(fetchCalls[0].body);
    assert.equal(sent.type, 'scroll');
    assert.equal(sent.scrollY, 800);
  });

  test('computer_keypress sends Enter for form submit', async () => {
    const r = await tool('computer_keypress').execute({ key: 'Enter' }, {});
    assert.equal(r.ok, true);
    const sent = JSON.parse(fetchCalls[0].body);
    assert.equal(sent.type, 'keypress');
    assert.deepEqual(sent.keys, ['Enter']);
  });

  test('computer_click rejects bad buttons without network', async () => {
    const r = await tool('computer_click').execute({ x: 1, y: 2, button: 'side' }, {});
    assert.equal(r.ok, false);
    assert.equal(fetchCalls.length, 0);
  });

  test('computer_type requires text', async () => {
    const r = await tool('computer_type').execute({ text: '' }, {});
    assert.equal(r.ok, false);
    assert.equal(fetchCalls.length, 0);
  });

  test('computer_type writes into the live browser', async () => {
    const events = [];
    const r = await tool('computer_type').execute(
      { text: 'Luis' },
      { onEvent: (e) => events.push(e) }
    );
    assert.equal(r.ok, true);
    assert.equal(r.typed, 4);
    const sent = JSON.parse(fetchCalls[0].body);
    assert.equal(sent.type, 'type');
    assert.ok(events.some((e) => e.tool === 'computer_type'));
  });
});
