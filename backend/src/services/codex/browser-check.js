'use strict';

/**
 * codex/browser-check — the agent sees the app the way the USER sees it.
 *
 * bolt.diy-style loop closer (clean-room): type_check catches compile errors
 * and dev_server_check catches server stdout, but a blank page from a runtime
 * exception ("Cannot read properties of undefined…") is invisible to both.
 * This module drives the system Chromium (already in the backend image for
 * the doc pipeline) against the project's dev server and reports:
 *
 *   - whether #root actually rendered content (and how much),
 *   - uncaught page exceptions + console.error lines,
 *   - the Vite error-overlay message when present,
 *   - failed network requests (bundle 404s etc.).
 *
 * Fail-open by contract at the tool layer: no browser / no dev URL degrades
 * to an informational result — a verification aid must never break a build.
 */

const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_ERRORS = 12;

function chromiumExecutablePath(env = process.env) {
  return (
    env.PUPPETEER_EXECUTABLE_PATH ||
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    undefined
  );
}

/**
 * Dev-server URL reachable FROM THE BACKEND container. Explicit env wins;
 * otherwise reuse the runner's hostname (the dev server lives in the same
 * container as the runner) with the dev port.
 */
function devUrlFor(env = process.env, port = 5173) {
  if (env.CODE_RUNNER_DEV_URL) {
    try {
      const u = new URL(env.CODE_RUNNER_DEV_URL);
      if (port != null) u.port = String(port);
      return u.toString().replace(/\/+$/, '');
    } catch { /* fall through */ }
  }
  if (env.CODE_RUNNER_URL) {
    try {
      const u = new URL(env.CODE_RUNNER_URL);
      u.port = String(port);
      return u.toString().replace(/\/+$/, '');
    } catch { /* fall through */ }
  }
  return `http://localhost:${port}`;
}

/**
 * Load `url` headless and report what a user would see.
 * `deps.puppeteerImpl` is injectable for offline tests.
 */
async function checkApp({ url, settleMs = DEFAULT_SETTLE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, puppeteerImpl = null } = {}) {
  if (!url) return { ok: false, unavailable: true, reason: 'no_url' };
  let puppeteer = puppeteerImpl;
  if (!puppeteer) {
    try {
      // eslint-disable-next-line global-require
      puppeteer = require('puppeteer');
    } catch (err) {
      return { ok: false, unavailable: true, reason: `puppeteer_unavailable: ${err.message}` };
    }
  }

  let browser = null;
  const errors = [];
  const pushError = (kind, text) => {
    const line = `${kind}: ${String(text || '').slice(0, 300)}`;
    if (errors.length < MAX_ERRORS && !errors.includes(line)) errors.push(line);
  };
  try {
    browser = await puppeteer.launch({
      executablePath: chromiumExecutablePath(env),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      timeout: timeoutMs,
    });
    const page = await browser.newPage();
    page.on('pageerror', (err) => pushError('exception', err && err.message));
    page.on('console', (msg) => {
      if (msg.type && msg.type() === 'error') pushError('console.error', msg.text && msg.text());
    });
    page.on('requestfailed', (req) => {
      const reqUrl = req.url ? req.url() : '';
      if (/favicon|\.map($|\?)/.test(reqUrl)) return;
      pushError('request_failed', `${reqUrl} (${req.failure && req.failure() ? req.failure().errorText : '?'})`);
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    await new Promise((r) => { setTimeout(r, settleMs); });

    const snapshot = await page.evaluate(() => {
      const root = document.querySelector('#root');
      const overlay = document.querySelector('vite-error-overlay');
      let overlayText = null;
      if (overlay && overlay.shadowRoot) {
        const msg = overlay.shadowRoot.querySelector('.message, .message-body, pre');
        overlayText = msg ? msg.textContent : overlay.shadowRoot.textContent;
      }
      return {
        title: document.title || '',
        rootChars: root ? (root.innerText || '').trim().length : -1,
        overlay: overlayText ? String(overlayText).slice(0, 500) : null,
      };
    });

    const rendered = snapshot.rootChars > 0;
    return {
      ok: rendered && !snapshot.overlay && errors.length === 0,
      rendered,
      rootChars: Math.max(snapshot.rootChars, 0),
      rootMissing: snapshot.rootChars === -1,
      overlay: snapshot.overlay,
      title: snapshot.title,
      errors,
    };
  } catch (err) {
    return { ok: false, unavailable: true, reason: String(err && err.message || err).slice(0, 200), errors };
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }
}

/** Human observation for the agent, in Spanish, always actionable. */
function formatReport(result, url) {
  if (result.unavailable) {
    return `No pude abrir la app en un navegador (${result.reason}). Usa dev_server_check para los logs del servidor.`;
  }
  const lines = [`Navegador headless sobre ${url}:`];
  if (result.rootMissing) lines.push('- ✗ No existe #root en el HTML — revisa index.html.');
  else if (!result.rendered) lines.push('- ✗ La página carga pero #root está VACÍO — típico de una excepción en el arranque de React.');
  else lines.push(`- ✓ Render OK (#root con ${result.rootChars} caracteres visibles${result.title ? `, título "${result.title}"` : ''}).`);
  if (result.overlay) lines.push(`- ✗ Overlay de error de Vite:\n${result.overlay}`);
  if (result.errors.length) {
    lines.push('- Errores capturados:');
    for (const e of result.errors) lines.push(`  · ${e}`);
  }
  if (result.ok) lines.push('La app se ve funcional para un usuario.');
  else if (!result.overlay && !result.errors.length && result.rendered === false) lines.push('Diagnostica con read_file sobre src/main.tsx y el componente raíz.');
  else if (!result.ok) lines.push('Corrige estos errores (son lo que el usuario ve) y vuelve a verificar.');
  return lines.join('\n');
}

module.exports = { checkApp, formatReport, devUrlFor, chromiumExecutablePath };
