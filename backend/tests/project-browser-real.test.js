'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { verifyProjectPreviewForChat } = require('../src/services/codex/project-browser');
const { previewTokenFor } = require('../src/services/code/preview-proxy');
let playwright;
try { playwright = require('@playwright/test'); } catch { playwright = require('playwright'); }
const executablePath = playwright.chromium.executablePath();
const browserUnavailable = !fs.existsSync(executablePath) && 'Chromium is not installed in this test environment';

async function fixture(t, { html, script = '', redirect = false, hold = false, viteApp = false, socketRedirect = false } = {}) {
  const hits = [];
  const cookies = [];
  const socketHits = [];
  const socketMessages = [];
  let vite;
  const env = { NODE_ENV: 'test', CODE_RUNNER_PREVIEW_TOKEN_SECRET: 'fixture-project-browser-secret-only', PUPPETEER_EXECUTABLE_PATH: executablePath };
  const token = previewTokenFor({ projectId: 'p1', userId: 'u1' }, env);
  const basePath = `/api/codex/projects/p1/preview/${token}/app/`;
  const server = http.createServer((req, res) => {
    hits.push(req.url); cookies.push(req.headers.cookie || '');
    // Match the real signed preview proxy's CORS response to an opaque origin.
    if (req.headers.origin === 'null') res.setHeader('access-control-allow-origin', '*');
    if (vite) { vite.middlewares(req, res); return; }
    if (req.url === basePath) {
      if (hold) return;
      if (redirect) { res.writeHead(302, { location: redirect === true ? '/outside' : redirect === 'relative' ? `${basePath}nested/` : `${basePath}landing` }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'check=local; Path=/' });
      res.end(html || `<html><title>Aplicación real</title><body><main><h1>Aplicación verificada</h1><button>Comprar</button><p>Sin elemento root</p></main><script>${script}</script></body></html>`);
    } else if (req.url === `${basePath}nested/`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Preparando</h1><script src="./main.js"></script>');
    } else if (req.url === `${basePath}nested/main.js`) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end("document.querySelector('h1').textContent='Aplicación verificada';");
    } else if (req.url === `${basePath}landing`) {
      if (redirect === 'chain') res.writeHead(302, { location: '/outside' });
      else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Aplicación verificada</h1>');
    } else if (req.url === `${basePath}slow`) { return; }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('asset'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.on('upgrade', req => socketHits.push(req.url));
  if (viteApp) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-project-browser-vite-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Preparando</h1><script type="module" src="./main.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'main.js'), "document.querySelector('h1').textContent='Aplicación verificada';");
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: false, root, base: basePath, logLevel: 'silent', server: { middlewareMode: true, hmr: { server } } });
    t.after(async () => { await vite.close(); fs.rmSync(root, { recursive: true, force: true }); });
  } else {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (socketRedirect) { socket.end('HTTP/1.1 302 Found\r\nLocation: /outside-socket\r\nContent-Length: 0\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.send('connected');
        ws.on('message', message => socketMessages.push(String(message)));
      });
    });
    t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  }
  env.PUBLIC_FRONTEND_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let closes = 0;
  const injected = { chromium: { launch: async options => {
    const browser = await playwright.chromium.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      // Chromium treats fulfilled navigation as public; this permission is
      // fixture-only, so its real WebSocket can reach the loopback server.
      await context.grantPermissions(['local-network-access']);
      return context;
    };
    const close = browser.close.bind(browser);
    browser.close = async () => { closes++; return close(); };
    return browser;
  } } };
  const deps = { env, allowTestLoopback: true, playwrightImpl: injected,
    db: { user: { findUnique: async () => ({ id: 'u1', isAdmin: true }) } }, projectService: {}, githubApi: null,
    binding: { findProjectForChat: async ({ userId, chatId }) => userId === 'u1' && chatId === 'c1' ? { id: 'p1' } : null },
    runner: { devStatus: async id => ({ project: id, running: true, ready: true, basePath }) },
  };
  return { hits, cookies, socketHits, socketMessages, token, basePath, deps, closes: () => closes };
}
const args = { userId: 'u1', chatId: 'c1', projectId: 'p1', expectedText: 'Aplicación verificada' };

test('real Chromium verifies generic DOM, bounded screenshot and fresh cookies without #root', { skip: browserUnavailable }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const out = await verifyProjectPreviewForChat({ ...args, url: 'http://127.0.0.1/outside' }, f.deps);
    assert.equal(out.ok, true, JSON.stringify(out.verification || out));
    assert.equal(out.verification.mode, 'read_only'); assert.equal(out.verification.expectedTextFound, true);
    assert.match(out.verification.text, /Sin elemento root/); assert.equal(out.verification.controls, 1);
    assert.equal(out.screenshot.mediaType, 'image/jpeg'); assert.ok(out.screenshot.byteLength <= 900_000);
    assert.ok(Buffer.from(out.screenshot.dataUrl.split(',')[1], 'base64').length > 1000);
  }
  assert.equal(f.closes(), 2); assert.ok(f.cookies.every(value => !value));
  assert.ok(f.hits.every(path => path.startsWith(f.basePath)));
});
test('real Chromium catches runtime exceptions, missing expected content and empty HTML', { skip: browserUnavailable }, async t => {
  const bad = await fixture(t, { script: "throw new Error('runtime roto')" });
  const failure = await verifyProjectPreviewForChat(args, bad.deps);
  assert.equal(failure.ok, false); assert.equal(failure.code, 'browser_check_failed');
  assert.ok(failure.verification.errors.some(line => line.includes('runtime roto')));
  const stale = await verifyProjectPreviewForChat({ ...args, expectedText: 'Título futuro inexistente' }, bad.deps);
  assert.equal(stale.verification.expectedTextFound, false);
  const blank = await fixture(t, { html: '<html><body></body></html>' });
  assert.equal((await verifyProjectPreviewForChat({ ...args, expectedText: '' }, blank.deps)).verification.rendered, false);
});
test('real Chromium blocks other paths, POST and redirect escape before any request reaches them', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { script: "fetch('/outside').catch(()=>{});fetch(location.href+'mutation',{method:'POST',body:'x'}).catch(()=>{});" });
  const out = await verifyProjectPreviewForChat(args, f.deps);
  assert.equal(out.ok, false);
  assert.ok(f.hits.every(path => path === f.basePath), JSON.stringify(f.hits));
  const redirect = await fixture(t, { redirect: true });
  const redirected = await verifyProjectPreviewForChat(args, redirect.deps);
  assert.equal(redirected.ok, false); assert.ok(!redirect.hits.includes('/outside'));
});
test('real Chromium blocks worker, frame, form and websocket egress', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { script: `
    try { new Worker('/worker') } catch {}
    try { new WebSocket(location.origin.replace('http:','ws:')+'/socket') } catch {}
    const frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame);
    const form=document.createElement('form');form.action='/submit';form.method='post';document.body.append(form);try{form.submit()}catch{}
  ` });
  await verifyProjectPreviewForChat(args, f.deps);
  assert.ok(f.hits.every(path => path === f.basePath), JSON.stringify(f.hits));
  assert.deepEqual(f.socketHits, []);
  assert.equal(f.closes(), 1);
});
test('real Chromium Stop closes a pending browser and returns cancellation', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { hold: true });
  const controller = new AbortController();
  const pending = verifyProjectPreviewForChat({ ...args, signal: controller.signal }, f.deps);
  const deadline = Date.now() + 10_000;
  while (!f.hits.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.hits.length, 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.code, 'E_CANCELLED'); assert.equal(result.ok, false); assert.ok(f.closes() >= 1);
});

test('real Chromium validates each owned redirect hop and never follows an escaping chain', { skip: browserUnavailable }, async t => {
  const valid = await fixture(t, { redirect: 'owned' });
  assert.equal((await verifyProjectPreviewForChat(args, valid.deps)).ok, true);
  assert.deepEqual(valid.hits, [valid.basePath, `${valid.basePath}landing`]);
  const escape = await fixture(t, { redirect: 'chain' });
  assert.equal((await verifyProjectPreviewForChat(args, escape.deps)).ok, false);
  assert.deepEqual(escape.hits, [escape.basePath, `${escape.basePath}landing`]);
});
test('real Chromium redacts echoed preview URLs and raw capability tokens from text and errors', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { script: "const secret=location.pathname.split('/preview/')[1].split('/')[0];document.body.append(secret);console.error('bad '+secret+' '+location.href)" });
  const out = await verifyProjectPreviewForChat(args, f.deps);
  assert.equal(out.ok, false); assert.ok(out.verification.errors.length > 0);
  assert.ok(!JSON.stringify(out).includes(f.token));
  assert.match(out.verification.text, /\[PREVIEW_TOKEN\]/);
});
test('real Vite app renders with its owned HMR socket and no hidden console errors', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { viteApp: true });
  const out = await verifyProjectPreviewForChat(args, f.deps);
  assert.equal(out.ok, true, JSON.stringify(out.verification || out));
  assert.equal(out.verification.expectedTextFound, true); assert.deepEqual(out.verification.errors, []);
  assert.ok(f.hits.some(value => value.includes('/@vite/client')));
  assert.equal(f.socketHits.length, 1); assert.ok(f.socketHits[0].startsWith(f.basePath));
});
test('real Chromium permits owned receive-only sockets but blocks outgoing mutations and WS redirects', { skip: browserUnavailable }, async t => {
  const script = "const ws=new WebSocket(location.href.replace(/^http/,'ws'));ws.onmessage=()=>{document.querySelector('h1').textContent='Socket verificado';ws.send('{\"type\":\"ping\"}');};";
  const owned = await fixture(t, { script });
  const out = await verifyProjectPreviewForChat({ ...args, expectedText: 'Socket verificado' }, owned.deps);
  assert.equal(out.ok, true, JSON.stringify(out.verification || out));
  assert.deepEqual(owned.socketHits, [owned.basePath]); assert.deepEqual(owned.socketMessages, ['{"type":"ping"}']);
  const mutate = await fixture(t, { script: script.replace('ping', 'mutate') });
  assert.equal((await verifyProjectPreviewForChat({ ...args, expectedText: 'Socket verificado' }, mutate.deps)).ok, false);
  assert.deepEqual(mutate.socketMessages, []);
  const redirected = await fixture(t, { script, socketRedirect: true });
  assert.equal((await verifyProjectPreviewForChat({ ...args, expectedText: 'Socket verificado' }, redirected.deps)).ok, false);
  assert.deepEqual(redirected.socketHits, [redirected.basePath]);
});

test('real Chromium matches the opaque preview sandbox instead of validating forbidden localStorage', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { html: '<h1>Preparando</h1><script>localStorage.setItem("key","value");document.querySelector("h1").textContent="Aplicación verificada";</script>' });
  const out = await verifyProjectPreviewForChat(args, f.deps);
  assert.equal(out.ok, false); assert.equal(out.verification.expectedTextFound, false);
  assert.ok(out.verification.errors.some(message => /localStorage|sandbox/i.test(message)));
});
test('real Chromium preserves relative asset URLs after an owned document redirect', { skip: browserUnavailable }, async t => {
  const f = await fixture(t, { redirect: 'relative' });
  const out = await verifyProjectPreviewForChat(args, f.deps);
  assert.equal(out.ok, true, JSON.stringify(out.verification || out));
  assert.ok(f.hits.includes(`${f.basePath}nested/main.js`));
  assert.ok(!f.hits.includes(`${f.basePath}main.js`));
});
test('real Chromium refuses hidden expected text and invisible content', { skip: browserUnavailable }, async t => {
  for (const style of ['opacity:0', 'visibility:hidden', 'display:none', 'position:absolute;top:3000px']) {
    const f = await fixture(t, { html: `<body style="${style}"><h1>Aplicación verificada</h1><button>Comprar</button></body>` });
    const out = await verifyProjectPreviewForChat(args, f.deps);
    assert.equal(out.ok, false, style); assert.equal(out.verification.rendered, false, style);
    assert.equal(out.verification.expectedTextFound, false, style);
  }
});

test('real Chromium blocks WebRTC STUN egress in the page and fresh child realms', { skip: browserUnavailable }, async t => {
  const udp = dgram.createSocket('udp4');
  let packets = 0;
  udp.on('message', () => packets++);
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  t.after(() => udp.close());
  const dial = `const rtc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});rtc.createDataChannel('test');rtc.createOffer().then(o=>rtc.setLocalDescription(o));`;
  const direct = await fixture(t, { script: dial });
  const out = await verifyProjectPreviewForChat(args, direct.deps);
  assert.equal(out.ok, false); assert.ok(out.verification.errors.some(value => /SecurityError|pares/.test(value)));
  assert.equal(packets, 0);
  const child = await fixture(t, { script: `const frame=document.createElement('iframe');document.body.append(frame);try { const RTCPeerConnection=frame.contentWindow.RTCPeerConnection;${dial} } catch {}` });
  await verifyProjectPreviewForChat(args, child.deps);
  assert.equal(packets, 0);
});
