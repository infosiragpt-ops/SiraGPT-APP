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
const { observePage } = require('../backend/src/services/computer/live-page');
const { ensureSession } = require('../backend/src/services/computer/persistent');
const { CHROME_DOCKER_FLAGS, chromeMaximizeOrLaunch } = require('../backend/src/services/computer/chrome-desktop-flags');
const handoff = require('../backend/src/services/computer/login-handoff');
const exec = promisify(execFile);
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.closeAllConnections(); s.close(r); });
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForExit(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('Owned Chrome process did not exit');
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
  const launcherBin = path.join(profile, 'fixture-bin');
  const launcherPidFile = path.join(profile, 'relaunched-chrome.pid');
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    await docker(['pull', 'node:22-bookworm-slim'], 120000);
    await listen(fixture); await listen(orch.server);
    env.AGENT_COMPUTER_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.server.address().port}`;
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
    assert.ok(ready, `desktop Chrome must start its CDP endpoint: ${fs.readFileSync('/tmp/browser-gate-chrome.log', 'utf8').slice(-1500)}`);
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
    const url = `http://127.0.0.1:${fixture.address().port}/form`;
    await run('computer_navigate', { url });
    assert.equal(context.pages().length, 1, 'first navigation creates a tab in the existing Chrome');
    let page = context.pages()[0];
    await page.waitForSelector('input[name=city]');
    // Exercise the production visible launcher after its hidden parent exits.
    // The wrapper only selects the installed test binary; it adds NO CDP flags.
    // Only the profile path is replaced, keeping this CI profile isolated.
    await context.addCookies([{ name: 'relaunch_fixture', value: 'preserved', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const initialConnection = await browser.newBrowserCDPSession();
    await initialConnection.send('Browser.close');
    await waitForExit(chromeProcess.pid);
    browser = undefined;
    context = undefined;
    await assert.rejects(fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(500) }), 'the original CDP listener must be closed');
    fs.mkdirSync(launcherBin);
    fs.writeFileSync(path.join(launcherBin, 'google-chrome'), `#!/bin/bash\nprintf '%s\\n' "$$" > ${shellQuote(launcherPidFile)}\nexec ${shellQuote(chromium.executablePath())} "$@"\n`, { mode: 0o700 });
    const relaunch = chromeMaximizeOrLaunch().replaceAll('--user-data-dir=/workspace/.chrome', `--user-data-dir=${shellQuote(profile)}`);
    const opened = await exec('bash', ['-c', relaunch], { env: { ...process.env, PATH: `${launcherBin}:${process.env.PATH}` }, timeout: 10000 });
    assert.match(opened.stdout, /desktop_app_ready/);
    const restored = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(5000) });
    assert.equal(restored.status, 200, 'the production launcher restores CDP without fixture-injected debugging flags');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    context = browser.contexts()[0];
    assert.ok((await context.cookies(url)).some(cookie => cookie.name === 'relaunch_fixture' && cookie.value === 'preserved'), 'visible relaunch preserves the persistent browser profile');
    await run('computer_navigate', { url });
    page = context.pages().find(candidate => candidate.url() === url);
    assert.ok(page, 'navigation after relaunch reaches the actual visible browser');
    await page.waitForSelector('input[name=city]');
    console.log('PASS real browser: close original parent -> production visible relaunch -> restored private CDP -> persistent profile -> navigation');
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
    await page.locator('#secret').click();
    const blocked = await tools.find(t => t.name === 'computer_screenshot').execute();
    assert.ok(JSON.stringify(blocked).includes('loginHandoff'));
    assert.ok(!JSON.stringify(blocked).includes('fixture-private-do-not-echo'));
    const paused = await tools.find(t => t.name === 'computer_type').execute({ text: 'must-not-type' });
    assert.ok(JSON.stringify(paused).includes('loginHandoff'));
    assert.equal(await page.locator('#pw').inputValue(), 'fixture-private-do-not-echo');
    console.log('PASS real browser: password gate -> private user takeover -> writes refused');
    handoff.resetTakeoverForTests();
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
    const removed = await Promise.allSettled([...createdContainers.values()].map(id => docker(['rm', '--force', id])));
    if (browser?.isConnected()) {
      const shutdown = await browser.newBrowserCDPSession().catch(() => null);
      await shutdown?.send('Browser.close').catch(() => {});
      await browser.close();
    }
    if (fs.existsSync(launcherPidFile)) {
      const ownedPid = Number(fs.readFileSync(launcherPidFile, 'utf8').trim());
      assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 1, 'only the PID created by this fixture may be cleaned up');
      try { process.kill(ownedPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await waitForExit(ownedPid);
    }
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
main().catch(e => { console.error(e.message); process.exitCode = 1; });
