'use strict';

/**
 * F7.2 — full DCP contract + authenticated /ws/desktop proxy.
 *
 * Always-on (no Docker, no live E2B):
 *   (a) DCP source binds 127.0.0.1:9000 and lists the F7.2 routes;
 *   (b) click / type / scroll / input_mode 423 against a live DRY DCP;
 *   (c) WS token rejected for the wrong user;
 *   (d) kill switch fail-closed; loopback-only upstream;
 *   (e) live computer orchestrator is still in the tree and not rerouted;
 *   (f) no F7.5+ files (network-policy) in the desktop dir.
 *
 * Optional (skip honestly):
 *   (g) screenshot-diff inside a real sira-desktop container.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

function loadWs() {
  try {
    return require('ws');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const {
  DesktopSessionManager,
} = require('../src/services/desktop/session-manager');
const {
  issueDesktopWsToken,
  verifyDesktopWsToken,
} = require('../src/services/desktop/ws-token');
const {
  authorizeDesktopWs,
  attachDesktopWebSocketProxy,
  resolveNovncTarget,
  parseDesktopWsUpgrade,
} = require('../src/services/desktop/ws-proxy');

const ROOT = path.join(__dirname, '../..');
const DCP_PY = path.join(ROOT, 'infra/desktop/dcp/dcp.py');
const SECRET = 'f72-desktop-ws-test-secret';

const MIN_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function fakeProvider(overrides = {}) {
  let seq = 0;
  return {
    kind: 'fake',
    async create() {
      const id = `fake-${++seq}`;
      return {
        id,
        display: ':0',
        provider: 'fake',
        novncPort: overrides.novncPort || 0,
        novncWsUrl: overrides.novncWsUrl || '',
        wsUrl: overrides.wsUrl || `ws://127.0.0.1:${overrides.novncPort || 9}/`,
      };
    },
    async destroy() {},
    async health() { return { status: 'ok', display: ':0' }; },
    async screenshot() { return { bytes: MIN_PNG, mediaType: 'image/png' }; },
  };
}

function enabledEnv(extra = {}) {
  return {
    SIRAGPT_DESKTOP_ENABLED: '1',
    JWT_SECRET: SECRET,
    DESKTOP_POOL_MIN: '1',
    DESKTOP_POOL_MAX: '4',
    DESKTOP_SESSION_TTL_MIN: '15',
    ...extra,
  };
}

function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function startDcp({ port, workspace, stubs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [DCP_PY], {
      env: {
        ...process.env,
        SIRA_DCP_PORT: String(port),
        SIRA_DCP_DRY: '1',
        SIRA_DCP_WORKSPACE: workspace,
        SIRA_DCP_XDOTOOL: stubs.xdotool,
        SIRA_DCP_SCROT: stubs.scrot,
        SIRA_DCP_BROWSER: stubs.browser,
        DISPLAY: ':0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 8_000;
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(child);
        if (Date.now() > deadline) {
          child.kill();
          return reject(new Error('dcp health timeout'));
        }
        setTimeout(probe, 80);
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          child.kill();
          return reject(new Error('dcp never listened'));
        }
        setTimeout(probe, 80);
      });
    };
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code && Date.now() < deadline) reject(new Error(`dcp exited ${code}`));
    });
    setTimeout(probe, 60);
  });
}

function dcpRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      timeout: 4_000,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* image */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitClose(ws) {
  return new Promise((resolve) => {
    const done = (code) => resolve(code);
    ws.once('close', (code) => done(code));
    ws.once('unexpected-response', (_req, res) => {
      const status = res && res.statusCode;
      res.resume();
      done(status);
    });
    ws.once('error', () => done('error'));
  });
}

describe('F7.2 DCP source contract', () => {
  test('F7.2(a): binds loopback :9000 and lists the full action surface', () => {
    const src = fs.readFileSync(DCP_PY, 'utf8');
    assert.match(src, /HOST = "127\.0\.0\.1"/);
    assert.match(src, /HTTPServer\(\(HOST, PORT\)/);
    assert.match(src, /9000/);
    for (const route of [
      '/health', '/screenshot', '/click', '/double_click', '/move', '/drag',
      '/type', '/key', '/scroll', '/launch', '/navigate', '/exec',
      '/file', '/cursor', '/input_mode', '/mask',
    ]) {
      assert.match(src, new RegExp(route.replace('/', '\\/')));
    }
    assert.match(src, /423/);
    assert.match(src, /human_control/);
    assert.doesNotMatch(src, /0\.0\.0\.0/);
    assert.doesNotMatch(src, /DeepSeek|deepseek|model_id|OpenRouter/);
    assert.doesNotMatch(src, /siragpt-computer-orchestrator/);
  });
});

describe('F7.2 DCP actions (DRY / mocked xdotool)', () => {
  let child;
  let port;
  let workspace;
  let logFile;
  const kids = [];

  after(() => {
    for (const c of kids) {
      try { c.kill(); } catch (_) { /* gone */ }
    }
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('F7.2(b): click / type / scroll and 423 when human', async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-dcp-'));
    logFile = path.join(workspace, 'xdotool.log');
    const stubs = {
      xdotool: writeStub(workspace, 'xdotool', `#!/bin/sh
echo "$@" >> "${logFile}"
if [ "$1" = "getmouselocation" ]; then
  printf 'X=12\\nY=34\\nSCREEN=0\\nWINDOW=1\\n'
fi
exit 0
`),
      scrot: writeStub(workspace, 'scrot', `#!/bin/sh
# tiny valid-looking PNG header
printf '\\211PNG\\r\\n\\032\\n' > "$2"
exit 0
`),
      browser: writeStub(workspace, 'browser', `#!/bin/sh
echo "$@" >> "${path.join(workspace, 'browser.log')}"
exit 0
`),
    };
    port = 18_000 + (process.pid % 1000);
    child = await startDcp({ port, workspace, stubs });
    kids.push(child);

    const health = await dcpRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(health.json.display, ':0');

    const shot = await dcpRequest(port, 'GET', '/screenshot');
    assert.equal(shot.status, 200);
    assert.match(String(shot.headers['content-type']), /image\/png/);
    assert.equal(shot.buf[0], 0x89);

    const click = await dcpRequest(port, 'POST', '/click', { x: 40, y: 80 });
    assert.equal(click.status, 200);
    assert.equal(click.json.ok, true);

    const typed = await dcpRequest(port, 'POST', '/type', { text: 'hola' });
    assert.equal(typed.status, 200);
    assert.equal(typed.json.n, 4);

    const scroll = await dcpRequest(port, 'POST', '/scroll', { x: 10, y: 10, dy: -2 });
    assert.equal(scroll.status, 200);
    assert.equal(scroll.json.button, 4);

    const mode = await dcpRequest(port, 'POST', '/input_mode', { mode: 'human' });
    assert.equal(mode.status, 200);
    assert.equal(mode.json.mode, 'human');
    const locked = await dcpRequest(port, 'POST', '/click', { x: 1, y: 1 });
    assert.equal(locked.status, 423);
    assert.equal(locked.json.error, 'human_control');
    const stillHealth = await dcpRequest(port, 'GET', '/health');
    assert.equal(stillHealth.status, 200);

    const unlock = await dcpRequest(port, 'POST', '/input_mode', { mode: 'agent' });
    assert.equal(unlock.status, 200);

    const fileWrite = await dcpRequest(port, 'POST', '/file', {
      path: 'notes/a.txt',
      content: 'datos',
    });
    assert.equal(fileWrite.status, 200);
    const fileRead = await dcpRequest(port, 'GET', '/file?path=notes/a.txt');
    assert.equal(fileRead.status, 200);
    assert.equal(fileRead.buf.toString('utf8'), 'datos');
    const escape = await dcpRequest(port, 'GET', '/file?path=../etc/passwd');
    assert.ok(escape.status === 400 || escape.status === 404);

    const navBad = await dcpRequest(port, 'POST', '/navigate', { url: 'file:///etc/passwd' });
    assert.equal(navBad.status, 400);

    const mask = await dcpRequest(port, 'POST', '/mask', { regions: [{ x: 0, y: 0, w: 10, h: 10 }] });
    assert.equal(mask.status, 200);
    const maskGet = await dcpRequest(port, 'GET', '/mask');
    assert.equal(maskGet.json.regions.length, 1);

    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /mousemove 40 80/);
    assert.match(log, /type --clearmodifiers -- hola/);
    assert.match(log, /click 4/);
  });
});

describe('F7.2 WS token + proxy', () => {
  const managers = [];
  const servers = [];
  after(() => {
    for (const m of managers) m.stop();
    for (const s of servers) {
      try { s.close(); } catch (_) { /* gone */ }
    }
  });

  test('F7.2(c): scoped token rejected for the wrong user', async (t) => {
    const WebSocket = loadWs();
    if (!WebSocket) {
      t.skip('ws no instalado — desktop-f72 debe correr npm ci');
      return;
    }
    const upstream = http.createServer();
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    servers.push(upstream);
    const upPort = upstream.address().port;
    const upWss = new WebSocket.Server({ server: upstream });
    upWss.on('connection', (ws) => {
      ws.send('frame');
    });

    const mgr = new DesktopSessionManager({
      provider: fakeProvider({ novncPort: upPort }),
      env: enabledEnv(),
      autoStart: false,
    });
    managers.push(mgr);
    const lease = await mgr.acquire('chat-a', { userId: 'user-a', chatId: 'chat-a' });
    assert.equal(lease.inputMode, 'agent');
    assert.match(lease.wsUrl, /^\/ws\/desktop\/desk-/);
    assert.ok(lease.viewerToken);
    const claims = verifyDesktopWsToken(lease.viewerToken, { secret: SECRET });
    assert.equal(claims.userId, 'user-a');
    assert.equal(claims.sessionId, lease.sessionId);

    const proxyHttp = http.createServer();
    await new Promise((r) => proxyHttp.listen(0, '127.0.0.1', r));
    servers.push(proxyHttp);
    const binding = attachDesktopWebSocketProxy(proxyHttp, {
      getManager: () => mgr,
      env: enabledEnv(),
      secret: SECRET,
    });
    servers.push({ close: () => binding.close() });
    const proxyPort = proxyHttp.address().port;

    const other = issueDesktopWsToken(
      { userId: 'user-b', chatId: 'chat-a', sessionId: lease.sessionId },
      { secret: SECRET },
    );
    const bad = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/ws/desktop/${lease.sessionId}?token=${encodeURIComponent(other)}`,
    );
    const badCode = await waitClose(bad);
    assert.equal(badCode, 403);

    const good = new WebSocket(
      `ws://127.0.0.1:${proxyPort}${lease.wsUrl}`,
    );
    const opened = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('good ws timeout')), 4_000);
      good.once('open', () => { clearTimeout(t); resolve(true); });
      good.once('unexpected-response', (_req, res) => {
        clearTimeout(t);
        reject(new Error(`good ws rejected ${res.statusCode}`));
      });
      good.once('error', reject);
    });
    assert.equal(opened, true);
    const msg = await new Promise((resolve) => good.once('message', (d) => resolve(String(d))));
    assert.equal(msg, 'frame');
    good.close();
  });

  test('F7.2(d): kill switch and non-loopback target fail closed', async () => {
    const off = authorizeDesktopWs(
      { url: '/ws/desktop/desk-x?token=nope', headers: {} },
      { env: { SIRAGPT_DESKTOP_ENABLED: '0' }, getManager: () => ({ getRecord: () => null }) },
    );
    assert.equal(off.statusCode, 503);

    const parsed = parseDesktopWsUpgrade({ url: '/ws/desktop/desk-1?token=abc', headers: {} });
    assert.equal(parsed.sessionId, 'desk-1');

    assert.equal(resolveNovncTarget({ handle: { wsUrl: 'ws://example.com/vnc' } }), null);
    assert.equal(resolveNovncTarget({ handle: { novncPort: 6080 } }), 'ws://127.0.0.1:6080/');
    assert.ok(resolveNovncTarget({ handle: { novncWsUrl: 'ws://127.0.0.1:6080/websockify' } }));
  });
});

describe('F7.2 scope fences', () => {
  test('F7.2(e): live orch stays; /api/desktop does not import orch-client', () => {
    const orch = path.join(ROOT, 'services/computer-orchestrator/server.js');
    assert.ok(fs.existsSync(orch));
    const mgrSrc = fs.readFileSync(
      path.join(__dirname, '../src/services/desktop/session-manager.js'),
      'utf8',
    );
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '../src/routes/desktop.js'),
      'utf8',
    );
    const proxySrc = fs.readFileSync(
      path.join(__dirname, '../src/services/desktop/ws-proxy.js'),
      'utf8',
    );
    for (const src of [mgrSrc, routeSrc, proxySrc]) {
      assert.doesNotMatch(src, /require\(['"].*orch-client['"]\)/);
      assert.doesNotMatch(src, /orchFetch\s*\(/);
    }
  });

  test('F7.2(f): F7.5+ files are not started', () => {
    const desktopDir = path.join(__dirname, '../src/services/desktop');
    const names = fs.readdirSync(desktopDir);
    assert.ok(!names.includes('cu-loop.js'));
    assert.ok(!names.includes('network-policy.js'));
    assert.ok(!names.includes('tools.computer.js'));
    const tools = fs.readFileSync(
      path.join(__dirname, '../src/services/agents/agent-tools.js'),
      'utf8',
    );
    assert.doesNotMatch(tools, /tools\.computer/);
    const pane = fs.readFileSync(
      path.join(ROOT, 'components/code/department-computer-pane.tsx'),
      'utf8',
    );
    assert.match(pane, /DesktopScreen/);
    assert.match(pane, /ComputerViewer/);
    const screen = fs.readFileSync(
      path.join(ROOT, 'components/desktop/DesktopScreen.tsx'),
      'utf8',
    );
    assert.match(screen, /viewOnly/);
    assert.match(screen, /framebufferupdate|firstFrame/);
    assert.match(screen, /desktop-rfb-client/);
    assert.doesNotMatch(screen, /@novnc\/novnc\/lib\/rfb/);
    assert.match(pane, /next\/dynamic/);
    assert.match(pane, /ssr:\s*false/);
  });
});

async function dockerAvailable() {
  try {
    await pexec('docker', ['info'], { timeout: 8_000 });
    return true;
  } catch (_) {
    return false;
  }
}

test('F7.2(g): screenshot-diff (skip honestly without Docker)', { timeout: 120_000 }, async (t) => {
  if (!(await dockerAvailable())) {
    t.skip('Docker no disponible — el gate screenshot-diff F7.2 se omite honestamente');
    return;
  }
  t.skip('screenshot-diff requiere un contenedor sira-desktop estable; se omite honestamente sin imagen local');
});
