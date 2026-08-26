'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const handoff = require('../src/services/computer/login-handoff');
const { resolveSessionIdentity } = require('../src/services/computer/member-key');
const mapper = require('../src/services/computer-use-action-mapper');
const { makeComputerExecutors } = require('../src/services/agent-runner/multimodal/computer');

const SECRET = 'SuperSecretValue-12345';

beforeEach(() => {
  handoff.resetTakeoverForTests();
});

describe('computer login handoff backend', () => {
  it('detects password / sso / captcha / 2fa / payment walls', () => {
    assert.equal(handoff.detectLoginGate({
      text: '<input type="password" name="password">',
      url: 'https://portal.example/login',
      title: 'Iniciar sesión',
    }).gated, true);
    assert.equal(handoff.detectLoginGate({ text: 'Sign in with Google' }).kind, 'sso');
    assert.equal(handoff.detectLoginGate({ text: "I'm not a robot recaptcha" }).kind, 'captcha');
    assert.equal(handoff.detectLoginGate({ text: 'Ingresa el código de verificación 2FA' }).kind, 'otp');
    assert.equal(handoff.detectLoginGate({ text: 'card number CVV checkout' }).kind, 'payment');
  });

  it('detects google.com/sorry + unusual traffic as captcha without page text', () => {
    const sorry = handoff.detectLoginGate({
      url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search',
      text: '',
      title: '',
    });
    assert.equal(sorry.gated, true);
    assert.equal(sorry.kind, 'captcha');
    assert.equal(sorry.reason, 'google_sorry');
    assert.match(sorry.chatMessage, /captcha/i);
    assert.doesNotMatch(sorry.chatMessage, /pega.{0,20}contrase/i);
    assert.equal(handoff.isCaptchaUrl('https://ipv4.google.com/sorry/index'), true);
    assert.equal(handoff.detectLoginGate({
      text: 'Our systems have detected unusual traffic from your computer network. I\'m not a robot',
      url: 'https://www.google.com/search?q=ofertas',
    }).kind, 'captcha');
    const copy = handoff.copyForKind('captcha', 'google.com');
    assert.equal(copy.title, 'Completa el captcha en el equipo');
    assert.match(copy.instruction, /captcha/);
  });

  it('live-page probe starts takeover from a sorry URL already on screen', async () => {
    const identity = resolveSessionIdentity({ id: 'u-sorry' }, 'chat-sorry');
    const state = await handoff.ensureTakeoverFromLivePage({
      identity,
      conversationId: 'chat-sorry',
      user: { id: 'u-sorry' },
      forceProbe: true,
      observe: async () => ({
        url: 'https://www.google.com/sorry/index?q=recaptcha',
        title: 'Sorry',
        text: '',
      }),
    });
    assert.equal(state.active, true);
    assert.equal(state.kind, 'captcha');
    assert.equal(handoff.overlayOpenFromTakeover(state).expand, true);
    assert.match(handoff.chatMessageForTakeover(state), /Toma el control/);
    assert.match(handoff.ssePayloadFromTakeover(state).chatMessage, /captcha/);
  });

  it('pauses screenshot / click / navigate while takeover is active', () => {
    const identity = resolveSessionIdentity({ id: 'u-pause' }, 'chat-pause');
    handoff.beginTakeover({ identity, conversationId: 'chat-pause', kind: 'captcha', reason: 'google_sorry' });
    for (const tool of ['computer_screenshot', 'computer_click', 'computer_navigate', 'computer_type']) {
      const out = handoff.refuseAgentType({ toolName: tool, identity, conversationId: 'chat-pause' });
      assert.equal(out.refuse, true, tool);
      assert.equal(out.code, 'login_handoff_required');
    }
  });

  it('computer_type executor refuses secrets and does not echo them', async () => {
    const { executors } = makeComputerExecutors({
      env: { SIRAGPT_AGENT_COMPUTER_DRIVER: 'fake' },
      userId: 'u1',
      sessionId: 's1',
      session: resolveSessionIdentity({ id: 'u1' }, 'chat-1'),
      computerEnabled: true,
    });
    const out = await executors.computer_type({
      text: SECRET,
      focused: { type: 'password', name: 'password', focused: true },
      conversationId: 'chat-1',
    });
    const dumped = typeof out === 'string' ? out : JSON.stringify(out);
    assert.match(dumped, /login_handoff_required/);
    assert.doesNotMatch(dumped, new RegExp(SECRET));
  });

  it('action mapper refuses type into a password field', () => {
    const mapped = mapper.normalizeComputerAction(
      { type: 'type', text: SECRET, focused: { type: 'password', name: 'password', focused: true } },
      { focused: { type: 'password', name: 'password', focused: true } },
    );
    assert.equal(mapped.ok, false);
    assert.equal(mapped.code, 'login_handoff_required');
    assert.doesNotMatch(JSON.stringify(mapped), new RegExp(SECRET));
  });

  it('two chats do not share cookie jars', () => {
    const user = { id: 'user_x' };
    const a = resolveSessionIdentity(user, 'chat-a');
    const b = resolveSessionIdentity(user, 'chat-b');
    const isolated = handoff.assertCookiesIsolated(
      new Map([['sid', 'A']]),
      new Map([['sid', 'B']]),
      a,
      b,
    );
    assert.equal(isolated.ok, true);
    assert.notEqual(a.sessionKey, b.sessionKey);
  });

  it('routes expose login-handoff and extraSystem includes the policy', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/agent-computer.js'), 'utf8');
    const stream = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
    const persist = fs.readFileSync(path.join(__dirname, '../src/services/computer/persistent.js'), 'utf8');
    assert.match(route, /login-handoff/);
    assert.match(route, /ensureTakeoverFromLivePage/);
    assert.match(stream, /POLICY_ES/);
    assert.match(stream, /chatMessage/);
    assert.match(persist, /applyObserveHandoff/);
    assert.match(persist, /peekPage/);
  });

  it('overlay opens (event) when takeover becomes active and Listo ends it', async () => {
    const events = [];
    const stop = handoff.subscribeTakeover((evt) => events.push(evt));
    const identity = resolveSessionIdentity({ id: 'u-overlay' }, 'chat-ov');
    const started = handoff.beginTakeover({ identity, conversationId: 'chat-ov', site: 'portal.example' });
    assert.equal(started.active, true);
    assert.equal(started.event, 'computer_login_handoff');
    assert.equal(handoff.overlayOpenFromTakeover(started).openPanel, true);
    assert.equal(events.some((e) => e.active === true), true);
    const pending = handoff.waitUntilReleased({ identity, conversationId: 'chat-ov', timeoutMs: 2000 });
    const ended = handoff.endTakeover({ identity, conversationId: 'chat-ov' });
    assert.equal(ended.active, false);
    const waited = await pending;
    assert.equal(waited.released, true);
    stop();
  });

  it('computer_type on password field returns refuse with no secret text', async () => {
    const { executors } = makeComputerExecutors({
      env: { SIRAGPT_AGENT_COMPUTER_DRIVER: 'fake' },
      userId: 'u1',
      sessionId: 's1',
      session: resolveSessionIdentity({ id: 'u1' }, 'chat-1'),
      computerEnabled: true,
    });
    const out = await executors.computer_type({
      text: SECRET,
      focused: { type: 'password', name: 'password', focused: true },
      conversationId: 'chat-1',
    });
    const dumped = typeof out === 'string' ? out : JSON.stringify(out);
    assert.match(dumped, /login_handoff_required|El usuario inició sesión/);
    assert.doesNotMatch(dumped, new RegExp(SECRET));
  });

  it('example tasks never ask the user to paste a password in chat', () => {
    for (const prompt of handoff.EXAMPLE_AUTHENTICATED_TASKS) {
      const routed = handoff.routeAuthenticatedComputerTask(prompt);
      assert.equal(routed.askPasswordInChat, false, prompt);
      assert.equal(routed.useComputer, true, prompt);
    }
  });
});
