'use strict';

// Read-only browser evidence for the project owned by this chat. No model URL,
// shared browser profile, desktop session, or automatic form submission.
const previewService = require('./chat-preview.service');
const { verifyPreviewToken } = require('../code/preview-proxy');
const { captureBoundedScreenshot, chromiumExecutablePath } = require('./browser-check');
const { redactPreviewUrl } = require('../../utils/preview-url-redaction');
const { redactString } = require('../../utils/secret-redactor');
const { assertSafeUrl } = require('../agent-harness/tools/web-fetch-tool');

const TIMEOUT_MS = 45_000;
const MAX_REQUESTS = 200;
const MAX_ERRORS = 12;

function clean(value, limit = 500, token = '') {
  const text = String(value || '');
  return redactString(redactPreviewUrl(token ? text.split(token).join('[PREVIEW_TOKEN]') : text), { maxLen: limit });
}
function failed(code, message, projectId = null) {
  return { ok: false, code, message, ...(projectId ? { projectId } : {}) };
}
function requestIsOwned(raw, target) {
  try {
    const url = new URL(raw);
    const base = target.pathname.replace(/\/$/, '');
    return !url.username && !url.password && url.origin === target.origin
      && !/%(?:2e|2f|5c)/i.test(url.pathname) && !url.pathname.includes('\\')
      && (url.pathname === base || url.pathname.startsWith(`${base}/`));
  } catch { return false; }
}

function socketIsOwned(raw, target) {
  try {
    const url = new URL(raw);
    if (url.protocol !== target.protocol.replace('http', 'ws')) return false;
    url.protocol = target.protocol;
    return requestIsOwned(url.href, target);
  } catch { return false; }
}

function ownedTarget(status, projectId, userId, env, deps) {
  const path = typeof status?.basePath === 'string' ? status.basePath : '';
  const prefix = `/api/codex/projects/${encodeURIComponent(projectId)}/preview/`;
  if (!path.startsWith(prefix)) return null;
  const match = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/app\/?$/.exec(path.slice(prefix.length));
  if (!match) return null;
  const claims = verifyPreviewToken(match[1], env);
  if (!claims || claims.projectId !== projectId || claims.userId !== userId) return null;
  const origin = previewService._internal.publicOrigin(env);
  if (!origin) return null;
  let url;
  try {
    url = new URL(previewService._internal.absolutePreviewUrl(path, env, status.framework));
    assertSafeUrl(url.href);
  } catch {
    // Loopback is only for an injected browser against a local test fixture.
    if (env.NODE_ENV !== 'test' || deps.allowTestLoopback !== true || !deps.playwrightImpl) return null;
    try {
      url = new URL(`${origin}${path}`);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    } catch { return null; }
  }
  return url;
}

async function verifyOwnedPreview({ userId, chatId, projectId, expectedText, signal } = {}, deps = {}) {
  if (!userId || !chatId || !projectId) return failed('preview_identity_invalid', 'Falta el proyecto propietario de este chat.');
  if (signal?.aborted) return failed('E_CANCELLED', 'Comprobación cancelada.', projectId);
  let d, status, target;
  try {
    d = previewService.resolveDeps(deps);
    const access = await previewService.assertCodexAccess({ userId, db: d.db, env: d.env });
    if (!access.ok) return failed('codex_forbidden', 'No se pudo autorizar la comprobación del proyecto.', projectId);
    if (signal?.aborted) return failed('E_CANCELLED', 'Comprobación cancelada.', projectId);
    const project = await d.binding.findProjectForChat({ userId, chatId, db: d.db, projects: d.projectService });
    if (signal?.aborted) return failed('E_CANCELLED', 'Comprobación cancelada.', projectId);
    if (!project || project.id !== projectId) return failed('preview_identity_invalid', 'El proyecto no pertenece a este chat.', projectId);
    status = await d.runner.devStatus(projectId);
    if (signal?.aborted) return failed('E_CANCELLED', 'Comprobación cancelada.', projectId);
    if (status?.project !== projectId) return failed('preview_identity_invalid', 'El servidor no confirmó el proyecto solicitado.', projectId);
    if (status.running !== true || status.ready !== true || status.error) return failed('preview_not_ready', 'La aplicación todavía no está lista para comprobarla.', projectId);
    target = ownedTarget(status, projectId, userId, d.env, deps);
    if (!target) return failed('preview_identity_invalid', 'El acceso a la vista previa no es válido o caducó. Vuelve a iniciarla.', projectId);
  } catch { return failed('preview_not_ready', 'No se pudo comprobar el estado del proyecto.', projectId); }

  let playwright;
  try { playwright = deps.playwrightImpl || require('playwright'); }
  catch { return failed('browser_unavailable', 'El navegador de comprobación no está disponible.', projectId); }
  let browser, page, timedOut = false, requestCount = 0, socketCount = 0;
  const errors = [];
  const redirectsToNavigate = new Set();
  const redirectedResponses = new Map();
  let pendingNavigation;
  const token = target.pathname.split('/preview/')[1].split('/')[0];
  const addError = (message) => {
    const safe = clean(message, 500, token);
    if (safe && errors.length < MAX_ERRORS && !errors.includes(safe)) errors.push(safe);
  };
  const close = async () => { if (browser) { try { await browser.close(); } catch { /* already closed */ } } };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Math.max(100, Math.min(TIMEOUT_MS, Number(deps.timeoutMs) || TIMEOUT_MS));
  const timer = setTimeout(() => { timedOut = true; void close(); }, timeoutMs);
  try {
    browser = await playwright.chromium.launch({
      headless: true, executablePath: chromiumExecutablePath(d.env),
      args: ['--disable-dev-shm-usage', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], timeout: timeoutMs,
    });
    if (signal?.aborted || timedOut) throw new Error('cancelled');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false, javaScriptEnabled: true,
    });
    // STUN/TURN bypass Playwright HTTP routing and CSP connect-src. Disable
    // peer connections in every document before project JavaScript executes.
    await context.addInitScript(() => {
      const unavailable = function () { throw new DOMException('Las conexiones entre pares no están disponibles durante la comprobación de lectura.', 'SecurityError'); };
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
        Object.defineProperty(globalThis, name, { value: unavailable, writable: false, configurable: false });
      }
    });
    const socketTarget = target.href.replace(/^http/, 'ws').replace(/\/$/, '');
    const policy = `sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; connect-src ${target.origin}${target.pathname.replace(/\/$/, '')}/ ${socketTarget}/`;
    // WebSocket traffic does not pass through HTTP routing. Keep the app's
    // own development connection, while blocking other origins/projects.
    await context.routeWebSocket('**/*', socket => {
      if (++socketCount > 4 || !socketIsOwned(socket.url(), target)) {
        addError('La aplicación intentó una conexión fuera de la vista previa del proyecto.');
        return socket.close({ code: 1008, reason: 'Read-only project verification' });
      }
      const upstream = socket.connectToServer();
      socket.onMessage(message => {
        // HMR can receive reload notifications. Verification must not send
        // arbitrary application mutations through a socket during page load.
        if (message === '{"type":"ping"}') upstream.send(message);
        else {
          addError('La aplicación intentó enviar datos durante la comprobación de lectura.');
          void socket.close({ code: 1008, reason: 'Read-only project verification' });
        }
      });
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const raw = request.url();
      try {
        if (++requestCount > MAX_REQUESTS || !requestIsOwned(raw, target) || !['GET', 'HEAD'].includes(request.method())) {
          addError('La aplicación intentó una solicitud fuera de la comprobación de lectura del proyecto.');
          await route.abort('blockedbyclient');
          return;
        }
        if (request.resourceType() === 'document' && request.frame() !== page.mainFrame()) {
          addError('La aplicación intentó abrir otra ventana durante la comprobación.');
          await route.abort('blockedbyclient');
          return;
        }
        // Chromium can follow fulfilled redirects without re-entering routing.
        // Resolve every hop ourselves, and only fulfill the final response.
        let nextUrl = raw;
        let response = redirectedResponses.get(raw);
        redirectedResponses.delete(raw);
        for (let redirects = 0; !response; redirects++) {
          response = await route.fetch({ url: nextUrl, maxRedirects: 0, timeout: timeoutMs });
          if (![301, 302, 303, 307, 308].includes(response.status())) break;
          const location = response.headers().location;
          const destination = location ? new URL(location, nextUrl) : null;
          if (destination) destination.hash = '';
          if (redirects >= 5 || ++requestCount > MAX_REQUESTS || !destination || !requestIsOwned(destination.href, target)) {
            addError('La aplicación redirigió fuera de su vista previa o superó el límite de redirecciones.');
            await route.abort('blockedbyclient');
            return;
          }
          nextUrl = destination.href;
          response = null;
        }
        if (nextUrl !== raw && request.resourceType() === 'document') {
          // A fulfilled body keeps the original browser URL. Navigate to the
          // validated final document instead, preserving relative assets and
          // routing without letting Chromium follow an unchecked redirect.
          redirectedResponses.set(nextUrl, response);
          redirectsToNavigate.add(raw);
          pendingNavigation = nextUrl;
          await route.abort('aborted');
          return;
        }
        if (nextUrl !== raw && ['script', 'stylesheet'].includes(request.resourceType())) {
          addError('No se pudo preservar la dirección de un recurso redirigido al verificar la aplicación.');
          await route.abort('blockedbyclient');
          return;
        }
        if (response.status() >= 400) addError(`Recurso del proyecto devolvió HTTP ${response.status()}.`);
        const headers = response.headers();
        if (request.resourceType() === 'document') {
          headers['content-security-policy'] = headers['content-security-policy']
            ? `${headers['content-security-policy']}, ${policy}` : policy;
        }
        await route.fulfill({ response, headers });
      } catch {
        if (!signal?.aborted && !timedOut) addError('No se pudo cargar un recurso del proyecto.');
        try { await route.abort('failed'); } catch { /* page closed */ }
      }
    });
    page = await context.newPage();
    context.on('page', opened => { if (opened !== page) void opened.close().catch(() => {}); });
    page.on('pageerror', error => addError(`Error de ejecución: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') addError(message.text()); });
    page.on('requestfailed', request => {
      if (redirectsToNavigate.has(request.url()) || /favicon|\.map(?:$|\?)/i.test(request.url())) return;
      addError('Falló una solicitud de la aplicación.');
    });
    let navigation = target.href;
    for (let attempt = 0; ; attempt++) {
      try {
        await page.goto(navigation, { waitUntil: 'networkidle', timeout: timeoutMs });
        break;
      } catch (error) {
        if (!pendingNavigation || attempt >= 5 || signal?.aborted || timedOut) throw error;
        navigation = pendingNavigation;
        pendingNavigation = null;
      }
    }
    if (!requestIsOwned(page.url(), target)) throw new Error('navigation_left_project');
    const marker = typeof expectedText === 'string' ? expectedText.trim().slice(0, 500) : '';
    const snapshot = await page.evaluate((expected) => {
      const visible = element => {
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0) return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      };
      const nodes = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      const parts = [];
      while (nodes.nextNode()) {
        const node = nodes.currentNode;
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !visible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) parts.push(node.textContent.trim());
      }
      const text = parts.filter(Boolean).join('\n');
      const images = [...document.images].filter(image => visible(image) && image.complete && image.naturalWidth > 0).length;
      const controls = [...document.querySelectorAll('button,input,select,textarea,a[href],[role="button"]')].filter(visible).length;
      return { title: document.title, text: text.slice(0, 6000), textChars: text.length,
        rendered: text.length > 0 || images > 0 || controls > 0,
        expectedTextFound: !expected || text.replace(/\s+/g, ' ').includes(expected.replace(/\s+/g, ' ')), images, controls };
    }, marker);
    const screenshot = await captureBoundedScreenshot({
      screenshot: ({ type, quality, fullPage }) => page.screenshot({ type, quality, fullPage }),
    });
    if (signal?.aborted || timedOut) throw new Error('cancelled');
    if (!screenshot?.dataUrl) addError('No se pudo obtener una captura verificable de la aplicación.');
    const verification = {
      kind: 'browser', mode: 'read_only', rendered: snapshot.rendered === true,
      expectedTextFound: snapshot.expectedTextFound === true, title: clean(snapshot.title, 200, token),
      text: clean(snapshot.text, 6000, token), textChars: snapshot.textChars,
      images: snapshot.images, controls: snapshot.controls, errors,
      checkedAt: new Date().toISOString(),
    };
    const ok = verification.rendered && verification.expectedTextFound && errors.length === 0 && Boolean(screenshot?.dataUrl);
    return { ok, code: ok ? 'browser_verified' : 'browser_check_failed', projectId, verification,
      ...(screenshot?.dataUrl ? { screenshot } : {}) };
  } catch {
    return failed(signal?.aborted ? 'E_CANCELLED' : timedOut ? 'browser_timeout' : browser ? 'browser_check_failed' : 'browser_unavailable',
      signal?.aborted ? 'Comprobación cancelada.' : 'No se pudo completar la comprobación real en el navegador.', projectId);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await close();
  }
}

// Bound cancellation from the first ownership lookup, including a pending
// runner request. The inner signal closes Chromium and prevents late launches.
async function verifyProjectPreviewForChat(args = {}, deps = {}) {
  if (args.signal?.aborted) return failed('E_CANCELLED', 'Comprobación cancelada.', args.projectId);
  const controller = new AbortController();
  let cancel;
  const interrupted = new Promise(resolve => { cancel = resolve; });
  const abort = code => {
    controller.abort();
    cancel(failed(code, code === 'E_CANCELLED' ? 'Comprobación cancelada.' : 'La comprobación del navegador superó su tiempo disponible.', args.projectId));
  };
  const onAbort = () => abort('E_CANCELLED');
  args.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('browser_timeout'), Math.max(100, Math.min(TIMEOUT_MS, Number(deps.timeoutMs) || TIMEOUT_MS)));
  try {
    return await Promise.race([verifyOwnedPreview({ ...args, signal: controller.signal }, deps), interrupted]);
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { verifyProjectPreviewForChat, _internal: { requestIsOwned, socketIsOwned, ownedTarget } };
