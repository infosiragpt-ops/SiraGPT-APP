'use strict';
// Real Chromium + X11 input. The only substitution is local desktop process
// hosting instead of Docker: HTTP/session/action/CDP contracts stay production.
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
const handoff = require('../backend/src/services/computer/login-handoff');
const exec = promisify(execFile);
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.closeAllConnections(); s.close(r); });

async function main() {
  assert.ok(process.env.DISPLAY, 'Real desktop gate requires Xvfb; never skip silently');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-browser-gate-'));
  const wm = spawn('openbox', [], { stdio: 'ignore' });
  const env = { NODE_ENV: 'test', SIRAGPT_AGENT_COMPUTER: '1', AGENT_COMPUTER_API_KEY: 'desktop-fixture-only' };
  const fixture = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><title>Formulario local de prueba</title><style>body{margin:40px;font:18px sans-serif}input,button{display:block;padding:12px;margin:12px 0}#long{margin-top:1100px}#wide{width:2400px;height:60px}</style><form onsubmit="event.preventDefault();document.querySelector('output').textContent='Guardado: '+this.city.value+' / '+this.subject.value"><label>Ciudad<input name="city"></label><label>Asunto<input name="subject"></label><button>Guardar</button></form><output></output><div id="long">Final del formulario</div><div id="wide">Desplazamiento horizontal</div><button id="secret" onclick="document.querySelector('#wall').hidden=false;document.querySelector('#pw').focus()">Entrar</button><div id="wall" hidden><h2>Inicia sesión</h2><label>Contraseña<input id="pw" type="password" value="fixture-private-do-not-echo"></label></div></html>`);
  });
  const orch = createOrchestrator({ env, driver: 'local-real-desktop', runtime: {
    ensureContainer: async () => ({ info: {}, reused: true }), containerIp: () => '127.0.0.1',
    execIn: async (_container, command) => exec('bash', ['-c', command], { timeout: 20000, maxBuffer: 12 * 1024 * 1024 }),
  }});
  let context;
  try {
    await listen(fixture); await listen(orch.server);
    env.AGENT_COMPUTER_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null, args: ['--no-sandbox', '--remote-debugging-port=9222', '--window-position=0,0', '--window-size=1280,900'] });
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
    const page = context.pages()[0];
    await page.waitForSelector('input[name=city]');
    const session = await ensureSession(owner);
    const snap = await observePage(session, env);
    const city = snap.controls.find(c => c.label === 'Ciudad');
    assert.ok(city, 'real observation must identify the visible form field');
    await run('computer_click', { x: city.x, y: city.y });
    await run('computer_type', { text: 'Lima' });
    await run('computer_keypress', { key: 'Tab' });
    await run('computer_type', { text: 'Solicitud' });
    await run('computer_keypress', { key: 'Tab', modifiers: ['Shift'] });
    await run('computer_keypress', { key: 'a', modifiers: ['Control'] });
    await run('computer_type', { text: 'Cusco' });
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
  } finally {
    await context?.close();
    await close(orch.server); await close(fixture);
    wm.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
