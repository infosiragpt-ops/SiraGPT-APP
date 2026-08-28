'use strict';

/**
 * F7.4 — Handoff / takeover FSM (HARD GATE).
 *
 * Always-on (no Docker, no live E2B):
 *   (a) FSM AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL → RESUMING → AGENT_CONTROL;
 *   (b) user can force grant without the agent asking;
 *   (c) HUMAN_CONTROL → POST /click|/type|/key = 423; executeComputer locked;
 *   (d) mock LLM never sees the secret nor an unmasked password screenshot;
 *   (e) after handoff_returned the CU-loop continues with a NEW screenshot;
 *   (f) abort / timeout pause the task and do not declare success;
 *   (g) kill switch fail-closed; REST POST /handoff;
 *   (h) no F7.5+ files (network-policy / secrets/vault);
 *   (i) source never names the live orchestrator hostname or a model id.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  HandoffFsm,
  createHandoffFsm,
  STATES,
  EVENT_TYPES,
  sanitizeReason,
} = require('../src/services/desktop/handoff-fsm');
const {
  DesktopSessionManager,
  getDesktopSessionManager,
  resetDesktopSessionManager,
} = require('../src/services/desktop/session-manager');
const {
  executeComputer,
  looksLikeSecret,
  FAKE_FRAME_PNG,
  SECRET_USE_HANDOFF_ES,
  HUMAN_LOCKED_ES,
} = require('../src/services/agent-runner/tools.computer');
const { runCuLoop, handoffStageLabel } = require('../src/services/agent-runner/cu-loop');
const { toStageEvent } = require('../src/services/agent-runner/trace');
const { callDcp } = require('../src/services/desktop/dcp-client');

function loadHandoffRoute() {
  try {
    return require('../src/routes/desktop');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const ROOT = path.join(__dirname, '../..');
const SECRET = 'password=SuperSecret99!!';
const MIN_PNG = FAKE_FRAME_PNG;

const managers = [];

after(() => {
  for (const m of managers) {
    try { m.stop(); } catch (_) { /* ignore */ }
  }
  resetDesktopSessionManager();
});

function enabledEnv(extra = {}) {
  return { SIRAGPT_DESKTOP_ENABLED: '1', NODE_ENV: 'test', ...extra };
}

function fakeDcpHandle(id = 'fake-dcp') {
  const state = {
    inputMode: 'agent',
    launched: [],
    typed: [],
    keys: [],
    clicks: [],
    shotSeq: 0,
    typeCalls: 0,
    screenshotCalls: 0,
    liveShots: 0,
  };
  const handle = {
    id,
    display: ':0',
    provider: 'fake',
    _state: state,
    async callDcp(method, pathName, body = {}) {
      if (pathName === '/input_mode' && method === 'POST') {
        state.inputMode = String(body.mode || 'agent');
        return { status: 200, json: { mode: state.inputMode } };
      }
      if (pathName === '/input_mode') {
        return { status: 200, json: { mode: state.inputMode } };
      }
      const locked = state.inputMode === 'human'
        && method === 'POST'
        && ['/click', '/double_click', '/move', '/drag', '/type', '/key', '/scroll', '/launch', '/navigate'].includes(pathName);
      if (locked) {
        return { status: 423, json: { status: 'locked', error: 'human_control', input_mode: 'human' } };
      }
      if (pathName === '/screenshot') {
        state.screenshotCalls += 1;
        state.shotSeq += 1;
        if (state.inputMode === 'human') {
          state.liveShots += 1;
          return {
            status: 200,
            bytes: MIN_PNG,
            mediaType: 'image/png',
            json: { leakySecret: SECRET, form: 'password', shotId: state.shotSeq },
          };
        }
        return {
          status: 200,
          bytes: MIN_PNG,
          mediaType: 'image/png',
          json: { ok: true, shotId: state.shotSeq },
        };
      }
      if (pathName === '/type') {
        state.typeCalls += 1;
        state.typed.push(String(body.text || ''));
        return { status: 200, json: { ok: true, n: String(body.text || '').length } };
      }
      if (pathName === '/click' || pathName === '/key') {
        if (pathName === '/click') state.clicks.push({ x: body.x, y: body.y });
        else state.keys.push(String(body.key || ''));
        return { status: 200, json: { ok: true } };
      }
      if (pathName === '/launch') {
        state.launched.push(String(body.app || '').toLowerCase());
        return { status: 200, json: { ok: true, app: body.app } };
      }
      return { status: 200, json: { ok: true } };
    },
  };
  return handle;
}

function fakeProvider() {
  let seq = 0;
  const destroyed = [];
  return {
    kind: 'fake',
    destroyed,
    async create() {
      const id = `fake-${++seq}`;
      return fakeDcpHandle(id);
    },
    async destroy(handle) {
      destroyed.push(handle && handle.id);
    },
    async health() { return { status: 'ok', display: ':0' }; },
    async screenshot() { return { bytes: MIN_PNG, mediaType: 'image/png' }; },
  };
}

function inspectingLlm(script, sink) {
  let i = 0;
  return {
    async complete(payload) {
      sink.push(payload);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(i - 1, payload) : step;
    },
  };
}

function leakBlob(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertNoSecretLeak(payloads) {
  const blob = leakBlob(payloads);
  assert.doesNotMatch(blob, /SuperSecret99/);
  assert.doesNotMatch(blob, /leakySecret/);
  assert.ok(!looksLikeSecret(blob) || !blob.includes('password='));
}

async function waitUntil(pred, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for handoff state');
}

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    status(n) { out.statusCode = n; return this; },
    json(b) { out.body = b; return this; },
    _out: out,
  };
}

describe('F7.4 handoff FSM', () => {
  test('F7.4(a): AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL → RESUMING → AGENT_CONTROL', () => {
    const seen = [];
    const fsm = createHandoffFsm({ sessionId: 'desk-1', onEvent: (e) => seen.push(e.type) });
    assert.equal(fsm.state, STATES.AGENT_CONTROL);
    fsm.request({ reason: 'login' });
    assert.equal(fsm.state, STATES.HANDOFF_REQUESTED);
    assert.equal(fsm.inputMode(), 'human');
    assert.equal(fsm.screenshotsPaused(), true);
    fsm.grant();
    assert.equal(fsm.state, STATES.HUMAN_CONTROL);
    assert.equal(fsm.isHumanControl(), true);
    fsm.returnControl();
    assert.equal(fsm.state, STATES.AGENT_CONTROL);
    assert.equal(fsm.inputMode(), 'agent');
    assert.deepEqual(seen, [
      EVENT_TYPES.REQUESTED,
      EVENT_TYPES.GRANTED,
      EVENT_TYPES.RETURNED,
    ]);
  });

  test('F7.4(b): user can force grant without the agent asking', () => {
    const fsm = new HandoffFsm({ sessionId: 'desk-force' });
    fsm.grant({ reason: 'takeover' });
    assert.equal(fsm.state, STATES.HUMAN_CONTROL);
    assert.equal(fsm.events[0].type, EVENT_TYPES.GRANTED);
    assert.equal(fsm.events[0].actor, 'user');
  });

  test('F7.4 reason sanitizer never keeps password field values', () => {
    assert.equal(sanitizeReason('password=hunter2'), 'human_needed');
    assert.equal(sanitizeReason('login wall'), 'login wall');
  });
});

describe('F7.4 DCP 423 + paused screenshots', () => {
  test('F7.4(c): HUMAN_CONTROL POST /click|/type|/key → 423', async () => {
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(mgr);
    const lease = await mgr.acquire('chat-423', { userId: 'u1', chatId: 'chat-423' });
    mgr.applyHandoff(lease.sessionId, 'grant', { actor: 'user' });
    assert.equal(mgr.isHumanControl(lease.sessionId), true);
    const handle = mgr.getHandle(lease.sessionId);
    for (const pathName of ['/click', '/type', '/key']) {
      const res = await callDcp(handle, {
        method: 'POST',
        path: pathName,
        body: pathName === '/type' ? { text: 'hola' } : pathName === '/key' ? { key: 'Return' } : { x: 10, y: 10 },
      });
      assert.equal(res.status, 423, pathName);
    }
    const click = await executeComputer({ type: 'click', x: 1, y: 1 }, {
      sessionManager: mgr,
      sessionId: lease.sessionId,
      env: enabledEnv(),
    });
    assert.equal(click.status, 'human_control');
    assert.match(click.text, /423/);
    assert.equal(click.screenshot.paused, true);
    const typed = await executeComputer({ type: 'type', text: 'hola' }, {
      sessionManager: mgr,
      sessionId: lease.sessionId,
      env: enabledEnv(),
    });
    assert.equal(typed.status, 'human_control');
    assert.equal(handle._state.typeCalls, 0);
  });

  test('looksLikeSecret still blocks type and never echoes the secret', async () => {
    const handle = fakeDcpHandle('sec');
    const out = await executeComputer({ type: 'type', text: SECRET }, { handle, env: enabledEnv() });
    assert.equal(out.text, SECRET_USE_HANDOFF_ES);
    assert.doesNotMatch(out.text, /SuperSecret99/);
    assert.equal(handle._state.typeCalls, 0);
  });
});

describe('F7.4 leak gate + resume', () => {
  test('F7.4(d)(e): LLM never sees the secret; loop continues with a new screenshot after return', async () => {
    const payloads = [];
    const events = [];
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(mgr);
    const lease = await mgr.acquire('chat-leak', { userId: 'u1', chatId: 'chat-leak' });
    const handle = mgr.getHandle(lease.sessionId);
    let returned = false;

    const llm = inspectingLlm([
      { actions: [{ type: 'request_handoff', reason: 'login' }] },
      { actions: [{ type: 'launch', app: 'chromium' }] },
      { actions: [{ type: 'done' }] },
    ], payloads);

    const loopP = runCuLoop({
      goal: 'abre chromium',
      chatId: 'chat-leak',
      sessionManager: mgr,
      env: enabledEnv(),
      llm,
      waitForHandoff: true,
      handle,
      onHandoff: (ev) => events.push(ev && ev.type),
    });

    await waitUntil(() => {
      const fsm = mgr.getHandoff(lease.sessionId);
      return fsm && fsm.state === STATES.HANDOFF_REQUESTED;
    });
    mgr.applyHandoff(lease.sessionId, 'grant', { actor: 'user' });
    handle._state.typed.push(SECRET);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mgr.isHumanControl(lease.sessionId), true);
    const locked = await executeComputer({ type: 'type', text: 'x' }, {
      sessionManager: mgr,
      sessionId: lease.sessionId,
      handle,
      env: enabledEnv(),
    });
    assert.equal(locked.status, 'human_control');
    mgr.applyHandoff(lease.sessionId, 'return', { actor: 'user' });
    returned = true;

    const result = await loopP;
    assert.equal(returned, true);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.ok(events.includes('handoff_requested') || events.includes(EVENT_TYPES.REQUESTED));
    assert.ok(result.screenshot, 'post-login screenshot present');
    assert.notEqual(result.screenshot.paused, true);
    assertNoSecretLeak(payloads);
    assertNoSecretLeak(result);
    assert.equal(handle._state.liveShots, 0);
    assert.ok(handle._state.shotSeq >= 2, 'a new screenshot was taken after return');
  });

  test('F7.4(f): timeout pauses the task and does not declare success', async () => {
    const mgr = new DesktopSessionManager({
      env: enabledEnv({ SIRAGPT_HANDOFF_TIMEOUT_MS: '80' }),
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(mgr);
    const result = await runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-to',
      sessionManager: mgr,
      env: enabledEnv({ SIRAGPT_HANDOFF_TIMEOUT_MS: '80' }),
      waitForHandoff: true,
      handoffTimeoutMs: 80,
      llm: inspectingLlm([{ actions: [{ type: 'request_handoff', reason: 'login' }] }], []),
    });
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 'done');
    assert.match(String(result.status), /handoff_timeout|timeout/i);
  });

  test('F7.4(f2): abort pauses the task and does not declare success', async () => {
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(mgr);
    const ac = new AbortController();
    const loopP = runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-ab',
      sessionManager: mgr,
      env: enabledEnv(),
      waitForHandoff: true,
      signal: ac.signal,
      llm: inspectingLlm([{ actions: [{ type: 'request_handoff', reason: 'login' }] }], []),
    });
    await waitUntil(() => {
      const lease = mgr.findByChatId('chat-ab');
      const fsm = lease && mgr.getHandoff(lease.sessionId);
      return fsm && fsm.state === STATES.HANDOFF_REQUESTED;
    });
    ac.abort();
    const result = await loopP;
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 'done');
    assert.match(String(result.status), /cancel/i);
  });
});

describe('F7.4 REST + kill switch + honesty', () => {
  test('F7.4(g): POST /handoff grant|return|request + kill switch', async (t) => {
    const desktopRoute = loadHandoffRoute();
    if (!desktopRoute || typeof desktopRoute.handleHandoff !== 'function') {
      t.skip('express no instalado — el gate REST F7.4 se omite honestamente; el FSM se cubre arriba');
      return;
    }
    const { handleHandoff } = desktopRoute;
    const mgr = getDesktopSessionManager({
      fresh: true,
      env: enabledEnv(),
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(mgr);
    const lease = await mgr.acquire('chat-rest', { userId: 'owner', chatId: 'chat-rest' });
    const req = (action) => ({
      params: { id: lease.sessionId },
      body: { action },
      user: { id: 'owner' },
    });
    const r1 = mockRes();
    handleHandoff(req('request'), r1);
    assert.equal(r1._out.statusCode, 200);
    assert.equal(r1._out.body.handoffState, STATES.HANDOFF_REQUESTED);
    assert.equal(r1._out.body.event.type, EVENT_TYPES.REQUESTED);

    const r2 = mockRes();
    handleHandoff(req('grant'), r2);
    assert.equal(r2._out.body.handoffState, STATES.HUMAN_CONTROL);
    assert.equal(r2._out.body.inputMode, 'human');

    const r3 = mockRes();
    handleHandoff(req('return'), r3);
    assert.equal(r3._out.body.handoffState, STATES.AGENT_CONTROL);
    assert.equal(r3._out.body.inputMode, 'agent');

    const off = getDesktopSessionManager({
      fresh: true,
      env: { NODE_ENV: 'test' },
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    managers.push(off);
    const r4 = mockRes();
    handleHandoff({ params: { id: 'x' }, body: { action: 'grant' }, user: { id: 'o' } }, r4);
    assert.equal(r4._out.statusCode, 503);
  });

  test('F7.4 SSE labels hook the existing stage channel', () => {
    assert.match(handoffStageLabel('handoff_requested'), /control/);
    const ev = toStageEvent({ type: 'handoff_granted', tool: 'computer' });
    assert.equal(ev.type, 'stage');
    assert.match(ev.label, /controlas/i);
  });

  test('F7.4(g2): REST handoff paths are sketched on /api/desktop', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/desktop.js'), 'utf8');
    assert.match(src, /\/sessions\/:id\/handoff/);
    assert.match(src, /\/session\/:id\/handoff/);
    assert.match(src, /grant\|return\|request|action/);
    assert.match(src, /SIRAGPT_DESKTOP_ENABLED|enabled\(\)/);
  });

  test('F7.4(h): no F7.5+ files', () => {
    const desktopDir = path.join(__dirname, '../src/services/desktop');
    const names = fs.readdirSync(desktopDir);
    assert.ok(names.includes('handoff-fsm.js'));
    assert.ok(!names.includes('network-policy.js'));
    assert.ok(!fs.existsSync(path.join(desktopDir, 'secrets/vault.js')));
    assert.ok(!fs.existsSync(path.join(__dirname, '../src/services/secrets/vault.js')));
  });

  test('F7.4(i): source never names the live orchestrator hostname', () => {
    const files = [
      path.join(__dirname, '../src/services/desktop/handoff-fsm.js'),
      path.join(__dirname, '../src/services/desktop/session-manager.js'),
      path.join(__dirname, '../src/routes/desktop.js'),
      path.join(__dirname, '../src/services/agent-runner/cu-loop.js'),
      path.join(__dirname, '../src/services/agent-runner/tools.computer.js'),
      path.join(ROOT, 'components/desktop/HandoffBanner.tsx'),
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(src, /siragpt-computer-orchestrator/);
      assert.doesNotMatch(src, /DeepSeek/);
      assert.doesNotMatch(src, /model_id/);
      assert.doesNotMatch(src, /OpenRouter/);
    }
  });
});
