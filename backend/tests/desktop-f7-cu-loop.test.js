'use strict';

/**
 * F7.3 — CU-loop + SiraAction adapters + computer tool.
 *
 * Always-on (no Docker, no live E2B):
 *   (a) Anthropic / OpenAI / Gemini adapters → SiraAction[];
 *   (b) executeComputer always returns a screenshot (fake DCP);
 *   (c) looksLikeSecret blocks type (no DCP /type, no secret echo);
 *   (d) request_handoff returns HANDOFF_REQUESTED without typing;
 *   (e) "abre chromium y busca X" with a fake LLM → verified done;
 *   (f) Abort/Detener releases the session (destroy called);
 *   (g) kill switch fail-closed;
 *   (h) no F7.5+ files (network-policy);
 *   (i) source never names the live computer orchestrator hostname.
 *
 * Live E2B / Docker paths are skipped honestly if someone adds them later.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  anthropicToSira,
  openaiToSira,
  geminiToSira,
  toSiraActions,
  scalePoint,
} = require('../src/services/agent-runner/adapters');
const {
  executeComputer,
  looksLikeSecret,
  FAKE_FRAME_PNG,
  SECRET_USE_HANDOFF_ES,
} = require('../src/services/agent-runner/tools.computer');
const {
  runCuLoop,
  verifyGoal,
  compactScreenshotHistory,
  inferVerification,
  DEFAULT_MAX_STEPS,
  DEFAULT_WALL_MS,
} = require('../src/services/agent-runner/cu-loop');
const {
  shouldUseComputerOperator,
} = require('../src/services/agent-runner/orchestrator/computer-operator');
const { shouldRunComputerLoop } = require('../src/services/agent-runner/orchestrator');
const {
  DesktopSessionManager,
  isDesktopEnabled,
} = require('../src/services/desktop/session-manager');

const ROOT = path.join(__dirname, '../..');
const MIN_PNG = FAKE_FRAME_PNG;

function fakeDcpHandle(id = 'fake-dcp') {
  const state = {
    launched: [],
    typed: [],
    keys: [],
    clicks: [],
    files: new Map([['outputs/ok.txt', 'ok']]),
    typeCalls: 0,
  };
  const handle = {
    id,
    display: ':0',
    provider: 'fake',
    _state: state,
    async callDcp(method, pathName, body = {}) {
      if (pathName === '/screenshot') {
        return { status: 200, bytes: MIN_PNG, mediaType: 'image/png' };
      }
      if (pathName === '/launch') {
        state.launched.push(String(body.app || '').toLowerCase());
        return { status: 200, json: { ok: true, app: body.app } };
      }
      if (pathName === '/type') {
        state.typeCalls += 1;
        state.typed.push(String(body.text || ''));
        return { status: 200, json: { ok: true, n: String(body.text || '').length } };
      }
      if (pathName === '/key') {
        state.keys.push(String(body.key || ''));
        return { status: 200, json: { ok: true, key: body.key } };
      }
      if (pathName === '/click' || pathName === '/double_click' || pathName === '/move') {
        state.clicks.push({ path: pathName, x: body.x, y: body.y });
        return { status: 200, json: { ok: true, x: body.x, y: body.y } };
      }
      if (pathName === '/navigate') {
        state.url = body.url;
        return { status: 200, json: { ok: true, url: body.url } };
      }
      if (pathName === '/file' && method === 'GET') {
        const rel = String(body.path || '');
        if (state.files.has(rel)) {
          return { status: 200, bytes: Buffer.from(state.files.get(rel)), json: { ok: true } };
        }
        return { status: 404, json: { error: 'not_found' } };
      }
      return { status: 200, json: { ok: true } };
    },
  };
  return handle;
}

function fakeProvider(opts = {}) {
  let seq = 0;
  const destroyed = [];
  return {
    kind: 'fake',
    destroyed,
    async create() {
      const id = `fake-${++seq}`;
      const handle = fakeDcpHandle(id);
      if (opts.onCreate) opts.onCreate(handle);
      return handle;
    },
    async destroy(handle) {
      destroyed.push(handle && handle.id);
    },
    async health() { return { status: 'ok', display: ':0' }; },
    async screenshot() { return { bytes: MIN_PNG, mediaType: 'image/png' }; },
  };
}

function enabledEnv(extra = {}) {
  return { SIRAGPT_DESKTOP_ENABLED: '1', NODE_ENV: 'test', ...extra };
}

function scriptedLlm(script) {
  let i = 0;
  return {
    async complete() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(i - 1) : step;
    },
  };
}

describe('F7.3 SiraAction adapters', () => {
  test('F7.3(a): anthropic / openai / gemini → SiraAction[]', () => {
    const anth = anthropicToSira([
      { action: 'left_click', coordinate: [10, 20] },
      { action: 'type', text: 'hola' },
      { action: 'key', text: 'Return' },
    ]);
    assert.equal(anth[0].type, 'click');
    assert.equal(anth[0].x, 10);
    assert.equal(anth[0].y, 20);
    assert.equal(anth[0].button, 'left');
    assert.equal(anth[1].type, 'type');
    assert.equal(anth[1].text, 'hola');
    assert.equal(anth[2].type, 'key');

    const oai = openaiToSira([
      { type: 'click', x: 5, y: 6, button: 'right' },
      { type: 'keypress', keys: ['ENTER'] },
      { type: 'double_click', x: 1, y: 2 },
    ]);
    assert.equal(oai[0].type, 'click');
    assert.equal(oai[0].button, 'right');
    assert.equal(oai[1].type, 'key');
    assert.match(oai[1].key, /ENTER/i);
    assert.equal(oai[2].type, 'double_click');

    const gem = geminiToSira([
      { name: 'click_at', x: 500, y: 500 },
      { name: 'type_text_at', x: 100, y: 100, text: 'query' },
      { name: 'open_web_browser' },
    ], { native: { width: 1920, height: 1080 } });
    assert.equal(gem[0].type, 'click');
    assert.equal(gem[0].x, 960);
    assert.equal(gem[0].y, 540);
    assert.equal(gem[1].type, 'type');
    assert.equal(gem[1].text, 'query');
    assert.equal(gem[2].type, 'launch');
    assert.equal(gem[2].app, 'chromium');

    const mixed = toSiraActions({ action: 'left_click', coordinate: [3, 4] });
    assert.equal(mixed[0].type, 'click');
    assert.equal(mixed[0].x, 3);
  });

  test('F7.3(a2): scalePoint maps resized-image coords to native', () => {
    const pt = scalePoint(100, 50, {
      image: { width: 960, height: 540 },
      native: { width: 1920, height: 1080 },
    });
    assert.equal(pt.x, 200);
    assert.equal(pt.y, 100);
  });
});

describe('F7.3 executeComputer', () => {
  test('F7.3(b): always returns a screenshot (fake DCP)', async () => {
    const handle = fakeDcpHandle();
    const out = await executeComputer({ type: 'click', x: 8, y: 9 }, { handle });
    assert.ok(out.screenshot);
    assert.ok(out.screenshot.base64);
    assert.equal(out.screenshot.mediaType, 'image/png');
    assert.ok(out.__f7Image);
    assert.equal(handle._state.clicks.length, 1);
  });

  test('F7.3(c): looksLikeSecret blocks type and does not echo the secret', async () => {
    assert.equal(looksLikeSecret('password: hunter2'), true);
    assert.equal(looksLikeSecret('sk-ant-api03-aaaaaaaaaaaaaaaaaaaa'), true);
    assert.equal(looksLikeSecret('hola mundo'), false);

    const handle = fakeDcpHandle();
    const secret = 'password: hunter2';
    const out = await executeComputer({ type: 'type', text: secret }, { handle });
    assert.match(out.text, /ERROR: use request_handoff/);
    assert.equal(out.text, SECRET_USE_HANDOFF_ES);
    assert.equal(out.status, 'secret_blocked');
    assert.doesNotMatch(out.text, /hunter2/);
    assert.equal(handle._state.typeCalls, 0);
    assert.ok(out.screenshot.base64);
  });

  test('F7.3(d): request_handoff pauses without executing type', async () => {
    const handle = fakeDcpHandle();
    const out = await executeComputer(
      { type: 'request_handoff', reason: 'login' },
      { handle },
    );
    assert.equal(out.status, 'HANDOFF_REQUESTED');
    assert.equal(out.text, 'HANDOFF_REQUESTED');
    assert.equal(handle._state.typeCalls, 0);
    assert.ok(out.screenshot.base64);
  });

  test('F7.3(g): kill switch fail-closed', async () => {
    const mgr = new DesktopSessionManager({
      env: { NODE_ENV: 'test' },
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    assert.equal(isDesktopEnabled(mgr.env), false);
    const out = await executeComputer(
      { type: 'launch', app: 'chromium' },
      { sessionManager: mgr, chatId: 'c1', env: mgr.env },
    );
    assert.match(out.text, /^ERROR:/);
    assert.match(out.text, /desactiv/i);
    assert.ok(out.screenshot);
  });
});

describe('F7.3 CU-loop', () => {
  test('F7.3(e): abre chromium y busca X → verified done', async () => {
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider,
      autoStart: false,
      poolMin: 0,
    });
    const goal = 'abre chromium y busca X';
    assert.equal(shouldUseComputerOperator(goal), true);
    assert.equal(shouldRunComputerLoop(goal), true);
    const inferred = inferVerification(goal);
    assert.equal(inferred.launch, 'chromium');
    assert.equal(inferred.search, 'X');

    const result = await runCuLoop({
      goal,
      chatId: 'chat-cr',
      sessionManager: mgr,
      env: enabledEnv(),
      llm: scriptedLlm([
        { actions: [{ type: 'launch', app: 'chromium' }] },
        { actions: [{ type: 'type', text: 'X' }, { type: 'key', key: 'Return' }] },
        { actions: [{ type: 'done', summary: 'busqué X' }] },
      ]),
    });
    assert.equal(result.status, 'done');
    assert.equal(result.verified.ok, true);
    assert.ok(result.ok);
    assert.ok(result.trace.launched.includes('chromium'));
    assert.ok(result.trace.typed.some((t) => t.includes('X')));
    assert.equal(mgr.sessions.size, 0, 'session released after done');
    assert.ok(provider.destroyed.length >= 1);
  });

  test('F7.3(e2): verifyGoal file-exists is programmatic', async () => {
    const v = await verifyGoal('el archivo outputs/ok.txt existe', {
      trace: { files: new Set(['outputs/ok.txt']), launched: [], typed: [] },
    });
    assert.equal(v.ok, true);
    const missing = await verifyGoal('el archivo nowhere.txt existe', {
      trace: { files: new Set(), launched: [], typed: [] },
    });
    assert.equal(missing.ok, false);
  });

  test('F7.3(f): Detener/abort releases and destroys the session', async () => {
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider,
      autoStart: false,
      poolMin: 0,
    });
    const ac = new AbortController();
    const llm = {
      async complete({ signal }) {
        ac.abort();
        if (signal && signal.aborted) {
          const err = new Error('operation_aborted');
          err.name = 'AbortError';
          err.code = 'ABORTED';
          throw err;
        }
        return { actions: [{ type: 'launch', app: 'chromium' }] };
      },
    };
    const result = await runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-abort',
      sessionManager: mgr,
      env: enabledEnv(),
      signal: ac.signal,
      llm,
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.ok, false);
    assert.equal(mgr.sessions.size, 0);
    assert.ok(provider.destroyed.length >= 1);
  });

  test('F7.3(g2): CU-loop fail-closed when desktop disabled', async () => {
    const mgr = new DesktopSessionManager({
      env: { NODE_ENV: 'test' },
      provider: fakeProvider(),
      autoStart: false,
      poolMin: 0,
    });
    const result = await runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-off',
      sessionManager: mgr,
      env: { NODE_ENV: 'test' },
      llm: scriptedLlm([{ actions: [{ type: 'done' }] }]),
    });
    assert.equal(result.status, 'disabled');
    assert.equal(result.ok, false);
    assert.equal(mgr.sessions.size, 0);
  });

  test('F7.3(d2): CU-loop request_handoff does not type secrets', async () => {
    const provider = fakeProvider();
    let handleRef = null;
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider: {
        ...provider,
        async create() {
          handleRef = fakeDcpHandle('handoff');
          return handleRef;
        },
      },
      autoStart: false,
      poolMin: 0,
    });
    const result = await runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-ho',
      sessionManager: mgr,
      env: enabledEnv(),
      waitForHandoff: false,
      llm: scriptedLlm([
        { actions: [{ type: 'type', text: 'password: hunter2' }] },
        { actions: [{ type: 'request_handoff', reason: 'login' }] },
      ]),
    });
    assert.equal(result.status, 'HANDOFF_REQUESTED');
    assert.equal(handleRef._state.typeCalls, 0);
    assert.ok(!result.trace.typed.includes('password: hunter2'));
  });

  test('F7.3 budgets default to 40 / 5min / compact-8', () => {
    assert.equal(DEFAULT_MAX_STEPS, 40);
    assert.equal(DEFAULT_WALL_MS, 5 * 60 * 1000);
    const compacted = compactScreenshotHistory([
      { role: 'user', screenshot: { base64: 'a' } },
      { role: 'user', screenshot: { base64: 'b' } },
      { role: 'user', screenshot: { base64: 'c' } },
    ], { keepLast: 2 });
    assert.equal(compacted[0].screenshot.compacted, true);
    assert.ok(compacted[1].screenshot.base64);
    assert.ok(compacted[2].screenshot.base64);
  });

  test('F7.3 reuse existing chat session (no second acquire)', async () => {
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      env: enabledEnv(),
      provider,
      autoStart: false,
      poolMin: 0,
    });
    const first = await mgr.acquire('chat-reuse', { userId: 'u1', chatId: 'chat-reuse' });
    const found = mgr.findByChatId('chat-reuse');
    assert.equal(found.sessionId, first.sessionId);
    const createdBefore = provider.destroyed.length;
    const result = await runCuLoop({
      goal: 'abre chromium y busca X',
      chatId: 'chat-reuse',
      sessionManager: mgr,
      env: enabledEnv(),
      llm: scriptedLlm([
        { actions: [{ type: 'launch', app: 'chromium' }] },
        { actions: [{ type: 'type', text: 'X' }] },
        { actions: [{ type: 'done' }] },
      ]),
    });
    assert.equal(result.status, 'done');
    assert.equal(createdBefore, 0);
    assert.equal(mgr.findByChatId('chat-reuse'), null);
  });
});

describe('F7.3 honesty / scope', () => {
  test('F7.3(h): no F7.5+ files', () => {
    const desktopDir = path.join(__dirname, '../src/services/desktop');
    const runnerDir = path.join(__dirname, '../src/services/agent-runner');
    const names = [
      ...fs.readdirSync(desktopDir),
      ...fs.readdirSync(runnerDir),
    ];
    assert.ok(!names.includes('network-policy.js'));
    assert.ok(fs.existsSync(path.join(runnerDir, 'cu-loop.js')));
    assert.ok(fs.existsSync(path.join(runnerDir, 'tools.computer.js')));
  });

  test('F7.3(i): source never names the live orchestrator hostname', () => {
    const files = [
      path.join(__dirname, '../src/services/agent-runner/cu-loop.js'),
      path.join(__dirname, '../src/services/agent-runner/tools.computer.js'),
      path.join(__dirname, '../src/services/desktop/dcp-client.js'),
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(src, /siragpt-computer-orchestrator/);
      assert.doesNotMatch(src, /DeepSeek/);
      assert.doesNotMatch(src, /model_id/);
    }
  });

  test('F7.3 computer_operator heuristic is a one-liner, not F4 rewrite', () => {
    assert.equal(shouldUseComputerOperator('crea una ppt rosada'), false);
    assert.equal(shouldRunComputerLoop('crea una ppt rosada'), false);
    assert.equal(shouldUseComputerOperator('abre chromium y busca recetas'), true);
  });
});
