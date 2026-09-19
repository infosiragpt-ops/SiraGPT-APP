 'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../../services/computer-orchestrator/server');
const livePage = require('../src/services/computer/live-page');
const handoff = require('../src/services/computer/login-handoff');
const live = require('../src/services/computer/live-actions');
const chat = require('../src/services/computer/chat-computer-tools');
const { resolveSessionIdentity } = require('../src/services/computer/member-key');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let orch, env, commands = [], pageActions = [], page, fail = false, shot = PNG;
const originalObserve = livePage.observePage;
const originalAct = livePage.actPage;
before(async () => {
  env = { NODE_ENV: 'test', SIRAGPT_AGENT_COMPUTER: '1', AGENT_COMPUTER_API_KEY: require('node:crypto').randomUUID(), AGENT_COMPUTER_MAX_DESKTOPS: '50' };
  orch = createOrchestrator({ driver: 'fake', env, execImpl: async (container, command) => {
    commands.push({ container, command });
    if (fail) throw new Error('execution failed');
    return { stdout: command.includes('import -window') ? shot : '', stderr: '' };
  }});
  await new Promise(r => orch.server.listen(0, '127.0.0.1', r));
  env.AGENT_COMPUTER_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.server.address().port}`;
  livePage.observePage = async () => page;
  livePage.actPage = async (session, action) => {
    if (fail) throw new Error("execution failed");
    pageActions.push({ session, action });
    return { ok: true };
  };
});
after(async () => {
  livePage.observePage = originalObserve;
  livePage.actPage = originalAct;
  orch.server.closeAllConnections();
  await new Promise(r => orch.server.close(r));
});
beforeEach(() => {
  commands = []; pageActions = []; fail = false; shot = PNG;
  page = { url: 'https://example.com/form', title: 'Formulario', text: 'Nombre', focused: { type: 'text', name: 'city' }, center: { x: 800, y: 500 }, controls: [{ label: 'Ciudad', type: 'text', x: 50, y: 150 }] };
  handoff.resetTakeoverForTests();
});
const owner = (userId = 'u1', conversationId = 'chat1') => ({ userId, conversationId, env });
const tool = (name, who = owner()) => chat.buildChatComputerTools(who).find(t => t.name === name);

test('click and typed text select the same authenticated per-chat desktop', async () => {
  assert.equal((await tool('computer_click').execute({ x: 50, y: 150 })).ok, true);
  assert.equal((await tool('computer_type').execute({ text: 'Lima' })).ok, true);
  assert.equal(pageActions.length, 2);
  assert.equal(pageActions[0].session.sessionId, pageActions[1].session.sessionId);
  assert.equal(pageActions[0].action.x, 50);
  assert.equal(pageActions[1].action.text, 'Lima');
});
test('real screenshot envelope pngBase64 is retained; chat consumes text coordinates, never raw PNG', async () => {
  const image = await live.liveScreenshot(owner());
  assert.equal(image.__f7Image.base64, PNG);
  const result = await tool('computer_screenshot').execute();
  assert.match(result.text, /Ciudad.*50,150/);
  assert.equal(result.__f7Image, undefined);
  assert.ok(!JSON.stringify(result).includes(PNG));
});
test('empty screenshots fail rather than report fake success', async () => {
  shot = '';
  const result = await tool('computer_screenshot').execute();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'browser_screenshot_missing');
});
test('scroll targets observed page center, supports horizontal and vertical wheel', async () => {
  await tool('computer_scroll').execute({ direction: 'right', amount: 640 });
  assert.equal(pageActions[0].action.x, 800);
  assert.equal(pageActions[0].action.scrollX, 640);
  await tool('computer_scroll').execute({ direction: 'up', amount: 640 });
  assert.equal(pageActions[1].action.scrollY, -640);
});
test('keyboard modifiers are a chord, not sequential key presses', async () => {
  await tool('computer_keypress').execute({ key: 'Tab', modifiers: ['Shift'] });
  assert.deepEqual(pageActions[0].action.keys, ['Shift', 'Tab']);
});
test('live DOM login gate blocks typing even if model supplies benign fake page context', async () => {
  page = { ...page, text: 'Inicia sesión. Contraseña', focused: { type: 'password', name: 'password' } };
  const result = await tool('computer_type').execute({ text: 'private', focused: { type: 'text' }, dom: 'safe' });
  assert.match(JSON.stringify(result), /loginHandoff/);
  assert.equal(commands.length + pageActions.length, 0);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('password screenshot activates handoff without capturing pixels', async () => {
  page = { ...page, focused: { type: 'password' }, text: 'Inicia sesión. Contraseña' };
  const result = await live.liveScreenshot(owner());
  assert.equal(result.refused, true);
  assert.equal(commands.length + pageActions.length, 0);
  assert.equal(result.__f7Image, undefined);
});
test('active human takeover prevents reads and writes until explicit release', async () => {
  handoff.beginTakeover({ user: { id: 'u1' }, conversationId: 'chat1', kind: 'password' });
  livePage.observePage = async () => { throw new Error('must not observe during takeover'); };
  try {
    assert.equal((await live.liveScreenshot(owner())).refused, true);
    assert.equal((await live.liveAct({ ...owner(), toolName: 'computer_click', action: { type: 'click', x: 1, y: 2 } })).refused, true);
    assert.equal(commands.length + pageActions.length, 0);
  } finally { livePage.observePage = async () => page; }
});
test('failed observation prevents action rather than guessing where to type', async () => {
  page = null;
  assert.equal((await tool('computer_type').execute({ text: 'Lima' })).ok, false);
  assert.equal(commands.length + pageActions.length, 0);
});
test('upstream execution failure is not reported as completed activity', async () => {
  fail = true;
  const r = await tool('computer_click').execute({ x: 1, y: 2 });
  assert.equal(r.ok, false);
});
test('aborted actions do not execute', async () => {
  const c = new AbortController(); c.abort();
  assert.equal((await tool('computer_click').execute({ x: 1, y: 2 }, { signal: c.signal })).ok, false);
  assert.equal(commands.length + pageActions.length, 0);
});
test('model arguments cannot select another user or conversation', async () => {
  await tool('computer_click').execute({ x: 1, y: 2, userId: 'victim', conversationId: 'victim-chat' });
  assert.match(pageActions[0].session.sessionKey, /u1_c_chat1/);
});
test('activity and desktop are isolated by BOTH member and chat', async () => {
  await tool('computer_click', owner('a', 'shared')).execute({ x: 1, y: 2 });
  await tool('computer_type', owner('b', 'shared')).execute({ text: 'Lima' });
  const a = resolveSessionIdentity({ id: 'a' }, 'shared', env);
  const b = resolveSessionIdentity({ id: 'b' }, 'shared', env);
  assert.notEqual(pageActions[0].session.sessionId, pageActions[1].session.sessionId);
  assert.equal(live.getActivity(a.sessionKey).lastAction, 'computer_click');
  assert.equal(live.getActivity(b.sessionKey).lastAction, 'computer_type');
  assert.equal(live.getActivity('shared'), null);
});
test('tools are flag gated and include scroll plus keyboard', () => {
  assert.deepEqual(chat.buildChatComputerTools({ env: { NODE_ENV: 'test' } }), []);
  for (const n of ['computer_scroll', 'computer_keypress', 'computer_navigate']) assert.ok(tool(n));
});
test('malformed input is refused before mutation', async () => {
  assert.equal((await tool('computer_click').execute({ button: 'side' })).ok, false);
  assert.equal((await tool('computer_type').execute({ text: '' })).ok, false);
  assert.throws(() => live.scrollAction({ direction: 'diagonal' }));
  assert.throws(() => live.keypressAction({}));
  assert.equal(commands.length + pageActions.length, 0);
});
