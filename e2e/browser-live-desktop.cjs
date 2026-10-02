'use strict';
// Real Chromium + X11 input AND real Docker Engine CDP transport. The browser
// stays on the CI X11 host; the compuser bridge runs in a disposable container
// sharing that test network. Docker Engine and CDP responses are not mocked.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { createOrchestrator } = require('../services/computer-orchestrator/server');
const { buildChatComputerTools } = require('../backend/src/services/computer/chat-computer-tools');
const { observePage, browserState, browserAction, navigatePage } = require('../backend/src/services/computer/live-page');
const { ensureSession } = require('../backend/src/services/computer/persistent');
const { CHROME_DOCKER_FLAGS } = require('../backend/src/services/computer/chrome-desktop-flags');
const handoff = require('../backend/src/services/computer/login-handoff');
const { verifyLiveViewport } = require('./browser-live-viewport.cjs');
const exec = promisify(execFile);
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.closeAllConnections(); s.close(r); });


// Closed diagnostics for GitHub annotations: never echo provider/page/error
// messages, arbitrary stack text, paths, bodies, credentials or command output.
const GATE_PHASES = new Set(['docker', 'start', 'cdp', 'form', 'tabs', 'rfb', 'password', 'cleanup']);
const GATE_FRAMES = new Map([
  ['e2e/browser-live-desktop.cjs', 'browser-live-desktop.cjs'],
  ['e2e/browser-live-viewport.cjs', 'browser-live-viewport.cjs'],
  ['backend/src/services/computer/live-page.js', 'live-page.js'],
  ['backend/src/services/computer/chat-computer-tools.js', 'chat-computer-tools.js'],
  ['backend/src/services/computer/persistent.js', 'persistent.js'],
  ['services/computer-orchestrator/server.js', 'server.js'],
  ['services/computer-orchestrator/agent-actions.js', 'agent-actions.js'],
  ['services/computer-orchestrator/cdp-exec.js', 'cdp-exec.js'],
]);
function safeGateFailure(error, phase) {
  const safePhase = GATE_PHASES.has(phase) ? phase : 'start';
  let kind = 'other';
  let frame = 'unavailable';
  try {
    const kinds = new Map([
      ['AssertionError', 'assertion'], ['TimeoutError', 'timeout'],
      ['AbortError', 'abort'], ['TypeError', 'type'],
      ['ReferenceError', 'reference'], ['SyntaxError', 'syntax'], ['RangeError', 'range'],
    ]);
    kind = kinds.get(error?.name) || 'other';
    if (['ETIMEDOUT', 'ERR_OPERATION_TIMED_OUT'].includes(error?.code)) kind = 'timeout';
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOENT', 'EACCES'].includes(error?.code)) kind = 'io';
    if (typeof error?.stack === 'string') {
      for (const line of error.stack.split('\n').slice(1, 40)) {
        const location = /^\s+at (?:.* \()?([^()]+):(\d{1,6}):\d{1,6}\)?$/.exec(line);
        if (!location) continue;
        const normalized = location[1].replace(/\\/g, '/');
        const known = [...GATE_FRAMES].find(([suffix]) => normalized === suffix || normalized.endsWith('/' + suffix));
        if (known && Number(location[2]) > 0) { frame = known[1] + ':' + Number(location[2]); break; }
      }
    }
  } catch { /* Malformed error objects still produce only closed diagnostics. */ }
  return `phase=${safePhase} kind=${kind} frame=${frame}`;
}
const reportedFailures = new Set();
let phase = 'start';
let chromeStartupNotReady = false;
function reportGateFailure(error, failedPhase) {
  if (reportedFailures.has(error)) return;
  reportedFailures.add(error);
  console.error('::error title=Browser desktop gate::' + safeGateFailure(error, failedPhase));
  // Preserve the existing narrow CI retry marker only for failed CDP startup.
  if (failedPhase === 'start' && chromeStartupNotReady) console.error('desktop Chrome must start its CDP endpoint');
}

async function main() {
  assert.ok(process.env.DISPLAY, 'Real desktop gate requires Xvfb; never skip silently');
  assert.ok(process.env.CI && process.platform === 'linux', 'Docker host networking is restricted to this Linux CI gate');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-browser-gate-'));
  const wm = spawn('openbox', [], { stdio: 'ignore' });
  const createdContainers = new Map();
  const docker = (args, timeout = 20000) => exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { timeout, maxBuffer: 1024 * 1024 });
  const env = { NODE_ENV: 'test', SIRAGPT_AGENT_COMPUTER: '1', AGENT_COMPUTER_API_KEY: require('node:crypto').randomUUID() };
  const fixture = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><title>Formulario local de prueba</title><style>body{margin:40px;font:18px sans-serif}input,button{display:block;padding:12px;margin:12px 0}#long{margin-top:1100px}#wide{width:2400px;height:60px}</style><form onsubmit="event.preventDefault();document.querySelector('output').textContent='Guardado: '+this.city.value+' / '+this.subject.value"><label>Ciudad<input name="city"></label><label>Asunto<input name="subject"></label><button>Guardar</button></form><output></output><div id="long">Final del formulario</div><div id="wide">Desplazamiento horizontal</div><button id="secret" onclick="document.querySelector('#wall').hidden=false;document.querySelector('#pw').focus()">Entrar</button><div id="wall" hidden><h2>Inicia sesión</h2><label>Contraseña<input id="pw" type="password" value="fixture-private-do-not-echo"></label></div></html>`);
  });
  const orch = createOrchestrator({ env, driver: 'local-real-desktop', runtime: {
    ensureContainer: async name => {
      if (!createdContainers.has(name)) {
        const created = await docker(['create', '--network', 'host', '--name', name, 'node:22-bookworm-slim', 'sleep', 'infinity']);
        const id = created.stdout.trim();
        assert.match(id, /^[a-f0-9]{64}$/);
        createdContainers.set(name, id);
        await docker(['start', id]);
        await docker(['exec', '--user', 'root', id, 'useradd', '--create-home', '--shell', '/bin/bash', 'compuser']);
      }
      return { info: {}, reused: true };
    }, containerIp: () => '127.0.0.1',
    execIn: async (_container, command) => exec('bash', ['-c', command], { timeout: 20000, maxBuffer: 12 * 1024 * 1024 }),
  }});
  let context, browser, chromeProcess;
  try {
    phase = 'docker';
    await docker(['info', '--format', '{{.ServerVersion}}']);
    await docker(['pull', 'node:22-bookworm-slim'], 120000);
    await listen(fixture); await listen(orch.server);
    env.AGENT_COMPUTER_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.server.address().port}`;
    phase = 'start';
    const chromeLog = fs.openSync('/tmp/browser-gate-chrome.log', 'w');
    const desktopFlags = CHROME_DOCKER_FLAGS.split(' ').filter(flag => !flag.startsWith('--user-data-dir='));
    chromeProcess = spawn(chromium.executablePath(), [...desktopFlags, '--no-startup-window', `--user-data-dir=${profile}`, '--remote-debugging-port=9222', '--window-position=0,0', '--window-size=1280,900'], { stdio: ['ignore', 'ignore', chromeLog] });
    fs.closeSync(chromeLog);
    let ready = false;
    // Bounded startup: up to 30 s. A cold, loaded CI runner sometimes needs
    // more than the previous 10 s before Chrome opens its CDP port; a Chrome
    // that never opens it still fails this gate.
    for (let i = 0; i < 120; i++) {
      try { ready = (await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(500) })).ok; } catch { /* bounded startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    chromeStartupNotReady = !ready;
    assert.ok(ready, 'desktop Chrome must start its CDP endpoint');
    phase = 'cdp';
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    context = browser.contexts()[0];
    assert.equal(context.pages().length, 0, 'fresh production desktop starts with no tab');
    const owner = { userId: 'desktop-e2e', conversationId: 'form-e2e', env };
    const tools = buildChatComputerTools(owner);
    const run = async (name, args = {}) => {
      const result = await tools.find(t => t.name === name).execute(args);
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      assert.equal(parsed.ok, true, `${name}: ${JSON.stringify(parsed)}`);
      return parsed;
    };
    phase = 'form';
    const url = `http://127.0.0.1:${fixture.address().port}/form`;
    await run('computer_navigate', { url });
    assert.equal(context.pages().length, 1, 'first navigation creates a tab in the existing Chrome');
    const page = context.pages()[0];
    await page.waitForSelector('input[name=city]');
    const session = await ensureSession(owner);
    const snap = await observePage(session, env);
    const city = snap.controls.find(c => c.label === 'Ciudad');
    assert.ok(city, 'real observation must identify the visible form field');
    console.log('Observed form target', JSON.stringify(city));
    await run('computer_click', { x: city.x, y: city.y });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'city', 'click must focus the observed field');
    await run('computer_type', { text: 'Lima' });
    assert.equal(await page.locator('[name=city]').inputValue(), 'Lima', 'click/type target the observed field');
    await run('computer_keypress', { key: 'Tab' });
    await run('computer_type', { text: 'Solicitud' });
    assert.equal(await page.locator('[name=subject]').inputValue(), 'Solicitud', 'Tab advances to next field');
    await run('computer_keypress', { key: 'Tab', modifiers: ['Shift'] });
    await run('computer_keypress', { key: 'a', modifiers: ['Control'] });
    await run('computer_type', { text: 'Cusco' });
    assert.equal(await page.locator('[name=city]').inputValue(), 'Cusco', 'Shift+Tab and Ctrl+A replace original field');
    await run('computer_keypress', { key: 'Enter' });
    await page.waitForFunction(() => document.querySelector('output').textContent === 'Guardado: Cusco / Solicitud');
    const shot = await run('computer_screenshot');
    assert.match(shot.text, /Guardado: Cusco \/ Solicitud/);
    assert.ok(!JSON.stringify(shot).includes('iVBORw0'));
    await run('computer_scroll', { direction: 'down', amount: 800 });
    await page.waitForFunction(() => scrollY > 100);
    await run('computer_scroll', { direction: 'right', amount: 800 });
    await page.waitForFunction(() => scrollX > 100);
    console.log('PASS real browser: navigate -> observe -> click -> type -> Tab/Shift+Tab/Ctrl+A -> Enter -> visible saved result -> vertical/horizontal scroll');
    phase = 'tabs';
    const tabState = await browserState(session, env);
    const originalTab = tabState.activeTabId;
    assert.equal(tabState.tabs.length, 1);
    const windowCdp = await context.newCDPSession(page);
    const windowInfo = await windowCdp.send('Browser.getWindowForTarget');
    await browserAction(session, { type: 'browser_present', tabId: originalTab }, env);
    assert.equal((await windowCdp.send('Browser.getWindowForTarget')).bounds.windowState, 'fullscreen');
    await browserAction(session, { type: 'browser_present', tabId: originalTab }, env);
    let controlled = await browserAction(session, { type: 'browser_tab_create' }, env);
    const newTab = controlled.activeTabId;
    assert.notEqual(newTab, originalTab);
    assert.equal(controlled.tabs.length, 2);
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).url, 'about:blank');
    await navigatePage(session, url + '?second=1', env, undefined, { tabId: newTab });
    await navigatePage(session, url + '?third=1', env, undefined, { tabId: newTab });
    controlled = await browserAction(session, { type: 'browser_back', tabId: newTab }, env);
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).url, url + '?second=1');
    assert.equal(controlled.canGoForward, true);
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).title, 'Formulario local de prueba');
    let refreshedHistory = await browserState(session, env);
    assert.equal(refreshedHistory.tabs.find(tab => tab.id === newTab).url, url + '?second=1');
    assert.equal(refreshedHistory.tabs.find(tab => tab.id === newTab).title, 'Formulario local de prueba');
    const observedBack = await observePage(session, env);
    assert.equal(observedBack.url, url + '?second=1');
    assert.equal(observedBack.title, 'Formulario local de prueba');
    controlled = await browserAction(session, { type: 'browser_forward', tabId: newTab }, env);
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).url, url + '?third=1');
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).title, 'Formulario local de prueba');
    refreshedHistory = await browserState(session, env);
    assert.equal(refreshedHistory.tabs.find(tab => tab.id === newTab).url, url + '?third=1');
    assert.equal(refreshedHistory.tabs.find(tab => tab.id === newTab).title, 'Formulario local de prueba');
    const observedForward = await observePage(session, env);
    assert.equal(observedForward.url, url + '?third=1');
    assert.equal(observedForward.title, 'Formulario local de prueba');
    controlled = await browserAction(session, { type: 'browser_reload', tabId: newTab }, env);
    assert.equal(controlled.tabs.find(tab => tab.id === newTab).url, url + '?third=1');
    controlled = await browserAction(session, { type: 'browser_tab_select', tabId: originalTab }, env);
    assert.equal(controlled.activeTabId, originalTab);
    assert.equal(page.url(), url);
    await assert.rejects(browserAction(session, { type: 'browser_tab_close', tabId: 'missing-target' }, env), error => error.code === 'browser_tab_missing');
    controlled = await browserAction(session, { type: 'browser_tab_close', tabId: newTab }, env);
    assert.equal(controlled.tabs.length, 1);
    assert.equal(controlled.activeTabId, originalTab);
    await browserAction(session, { type: 'browser_restore' }, env);
    assert.equal((await windowCdp.send('Browser.getWindowForTarget')).bounds.windowState, windowInfo.bounds.windowState);
    await windowCdp.detach();
    console.log('PASS real browser: target tabs -> history -> reload -> select -> close -> fullscreen -> original window restored');
    phase = 'rfb';
    await verifyLiveViewport({
      page,
      resize: (width, height) => browserAction(session, { type: 'browser_resize', tabId: originalTab, width, height }, env),
      restore: () => browserAction(session, { type: 'browser_restore' }, env),
    });
    phase = 'password';
    await page.locator('#secret').click();
    const blocked = await tools.find(t => t.name === 'computer_screenshot').execute();
    assert.ok(JSON.stringify(blocked).includes('loginHandoff'));
    assert.ok(!JSON.stringify(blocked).includes('fixture-private-do-not-echo'));
    const paused = await tools.find(t => t.name === 'computer_type').execute({ text: 'must-not-type' });
    assert.ok(JSON.stringify(paused).includes('loginHandoff'));
    assert.equal(await page.locator('#pw').inputValue(), 'fixture-private-do-not-echo');
    console.log('PASS real browser: password gate -> private user takeover -> writes refused');
    handoff.resetTakeoverForTests();
    phase = 'cleanup';
    for (const id of createdContainers.values()) {
      const deadline = Date.now() + 3000;
      let commands;
      do {
        // Docker needs PID in ps output to map host processes to this container.
        const top = await docker(['top', id, '-eo', 'pid,comm']);
        commands = top.stdout.trim().split('\n').slice(1).filter(line => line.trim()).map(line => {
          const match = /^\s*\d+\s+(\S+)\s*$/.exec(line);
          assert.ok(match, 'Docker process rows must contain a PID and command');
          return match[1];
        });
        if (commands.length === 1 && commands[0] === 'sleep') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.deepEqual(commands, ['sleep'], 'all real Docker CDP helpers must exit after browser operations');
    }
    console.log('PASS real Docker: authenticated CDP bridge and no residual helper processes');
  } catch (error) {
    reportGateFailure(error, phase);
    // Fixture-only diagnostics; no input values or real credentials are logged.
    const page = context?.pages()[0];
    if (page) {
      console.log('Browser gate diagnostic', JSON.stringify(await page.evaluate(() => ({
        title: document.title, focus: document.activeElement?.getAttribute('name'),
        tag: document.activeElement?.tagName, focused: document.hasFocus(),
        viewport: [innerWidth, innerHeight],
        fields: Array.from(document.querySelectorAll('input')).map(el => ({name:el.name,type:el.type,length:el.value.length,rect:el.getBoundingClientRect().toJSON()})),
      })).catch(() => ({}))));
      await page.screenshot({ path: '/tmp/browser-gate-page.png' }).catch(() => {});
      await exec('import', ['-window', 'root', '/tmp/browser-gate-desktop.png']).catch(() => {});
    }
    throw error;
  } finally {
    phase = 'cleanup';
    const removed = await Promise.allSettled([...createdContainers.values()].map(id => docker(['rm', '--force', id])));
    await browser?.close();
    if (chromeProcess && chromeProcess.exitCode === null) {
      const exited = new Promise(resolve => chromeProcess.once('exit', resolve));
      chromeProcess.kill();
      await exited;
    }
    await close(orch.server); await close(fixture);
    wm.kill();
    fs.rmSync(profile, { recursive: true, force: true });
    assert.ok(removed.every(result => result.status === 'fulfilled'), 'every container created by this test must be removed');
  }
}
main().catch(error => { reportGateFailure(error, phase); process.exitCode = 1; });
