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
const DEFAULT_MAX_SCREENSHOT_BYTES = 900_000;
const ABSOLUTE_MAX_SCREENSHOT_BYTES = 1_500_000;
const SCREENSHOT_VIEWPORT = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const SCREENSHOT_QUALITIES = Object.freeze([72, 50, 32]);
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

function screenshotLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_SCREENSHOT_BYTES;
  return Math.min(Math.floor(parsed), ABSOLUTE_MAX_SCREENSHOT_BYTES);
}

function screenshotBase64(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('base64');
  }
  throw new Error('Chromium devolvió una captura inválida');
}

/**
 * Capture only the visible viewport. The returned data URL is never larger
 * than `maxBytes`; quality is reduced before falling back to text-only.
 */
async function captureBoundedScreenshot(page, { maxBytes = DEFAULT_MAX_SCREENSHOT_BYTES } = {}) {
  if (!page?.screenshot) {
    return { unavailable: true, reason: 'screenshot_not_supported' };
  }
  const limit = screenshotLimit(maxBytes);
  let lastSize = 0;

  for (const quality of SCREENSHOT_QUALITIES) {
    const raw = await page.screenshot({
      type: 'jpeg',
      quality,
      fullPage: false,
      encoding: 'base64',
    });
    const base64 = screenshotBase64(raw);
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    lastSize = Buffer.byteLength(dataUrl, 'utf8');
    if (lastSize <= limit) {
      return {
        dataUrl,
        mediaType: 'image/jpeg',
        byteLength: lastSize,
        binaryBytes: Buffer.byteLength(base64, 'base64'),
        width: SCREENSHOT_VIEWPORT.width,
        height: SCREENSHOT_VIEWPORT.height,
        quality,
      };
    }
  }

  return {
    unavailable: true,
    reason: `screenshot_too_large:${lastSize}>${limit}`,
    byteLength: lastSize,
    maxBytes: limit,
  };
}

function screenshotContentBlock(dataUrl, provider = 'anthropic') {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const providerName = String(provider || '').toLowerCase();
  if (providerName.includes('openrouter') || providerName.includes('openai')) {
    return {
      type: 'image_url',
      image_url: { url: dataUrl },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2].replace(/\s/g, ''),
    },
  };
}

/**
 * Load `url` headless and report what a user would see.
 * `deps.puppeteerImpl` is injectable for offline tests.
 */
async function checkApp({
  url,
  expectedText = null,
  settleMs = DEFAULT_SETTLE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  puppeteerImpl = null,
  captureScreenshot = false,
  maxScreenshotBytes = null,
} = {}) {
  if (!url) return { ok: false, unavailable: true, reason: 'no_url' };
  let puppeteer = puppeteerImpl;
  if (!puppeteer) {
    try {
      // Puppeteer 25 is ESM-only; import lazily so loading the backend
      // neither launches a browser nor fails on an async ESM dependency.
      puppeteer = (await import('puppeteer')).default;
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
    let screenshotUnavailable = null;
    if (captureScreenshot && page.setViewport) {
      try {
        await page.setViewport(SCREENSHOT_VIEWPORT);
      } catch (err) {
        screenshotUnavailable = `viewport_failed:${String(err?.message || err).slice(0, 160)}`;
      }
    }
    page.on('pageerror', (err) => pushError('exception', err && err.message));
    page.on('console', (msg) => {
      if (!msg.type || msg.type() !== 'error') return;
      // Resource-load failures surface here with a URL-less text ("Failed to
      // load resource: … 404"); the URL lives in msg.location(). Skip the
      // same noise requestfailed skips (favicon, sourcemaps) and attach the
      // URL to real ones so the agent knows WHICH resource broke.
      const loc = msg.location ? msg.location() : null;
      const locUrl = loc && loc.url ? String(loc.url) : '';
      if (/favicon|\.map($|\?)/.test(locUrl)) return;
      const text = msg.text ? msg.text() : '';
      pushError('console.error', locUrl && /Failed to load resource/i.test(text) ? `${text} (${locUrl})` : text);
    });
    page.on('requestfailed', (req) => {
      const reqUrl = req.url ? req.url() : '';
      if (/favicon|\.map($|\?)/.test(reqUrl)) return;
      pushError('request_failed', `${reqUrl} (${req.failure && req.failure() ? req.failure().errorText : '?'})`);
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    await new Promise((r) => { setTimeout(r, settleMs); });

    const snapshot = await page.evaluate((expected) => {
      const root = document.querySelector('#root');
      const overlay = document.querySelector('vite-error-overlay');
      const rootText = root ? (root.innerText || '').trim() : '';
      let overlayText = null;
      if (overlay && overlay.shadowRoot) {
        const msg = overlay.shadowRoot.querySelector('.message, .message-body, pre');
        overlayText = msg ? msg.textContent : overlay.shadowRoot.textContent;
      }
      return {
        title: document.title || '',
        rootChars: root ? rootText.length : -1,
        expectedTextFound: expected ? rootText.includes(expected) : true,
        overlay: overlayText ? String(overlayText).slice(0, 500) : null,
      };
    }, expectedText ? String(expectedText).slice(0, 500) : null);

    const rendered = snapshot.rootChars > 0;
    const expectedTextFound = expectedText ? snapshot.expectedTextFound === true : true;
    let screenshot = null;
    if (captureScreenshot && !screenshotUnavailable) {
      try {
        const captured = await captureBoundedScreenshot(page, {
          maxBytes: maxScreenshotBytes ?? env.CODEX_BROWSER_SCREENSHOT_MAX_BYTES,
        });
        if (captured.dataUrl) screenshot = captured;
        else screenshotUnavailable = captured.reason || 'screenshot_unavailable';
      } catch (err) {
        screenshotUnavailable = `screenshot_failed:${String(err?.message || err).slice(0, 160)}`;
      }
    }
    return {
      ok: rendered && expectedTextFound && !snapshot.overlay && errors.length === 0,
      rendered,
      expectedTextFound,
      rootChars: Math.max(snapshot.rootChars, 0),
      rootMissing: snapshot.rootChars === -1,
      overlay: snapshot.overlay,
      title: snapshot.title,
      errors,
      ...(screenshot ? { screenshot } : {}),
      ...(screenshotUnavailable ? { screenshotUnavailable } : {}),
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
  if (result.expectedTextFound === false) lines.push('- ✗ El render no contiene el marcador esperado; el preview está sirviendo una versión anterior.');
  if (result.overlay) lines.push(`- ✗ Overlay de error de Vite:\n${result.overlay}`);
  if (result.errors.length) {
    lines.push('- Errores capturados:');
    for (const e of result.errors) lines.push(`  · ${e}`);
  }
  if (result.screenshotUnavailable) {
    lines.push(`- Captura visual no disponible (${result.screenshotUnavailable}); se conserva la verificación textual.`);
  }
  if (result.ok) lines.push('La app se ve funcional para un usuario.');
  else if (!result.overlay && !result.errors.length && result.rendered === false) lines.push('Diagnostica con read_file sobre src/main.tsx y el componente raíz.');
  else if (!result.ok) lines.push('Corrige estos errores (son lo que el usuario ve) y vuelve a verificar.');
  return lines.join('\n');
}

/**
 * Return multimodal tool content only when the active model can consume it.
 * Callers without capability information keep the existing string contract.
 */
function formatObservation(result, url, { supportsVision = false, provider = 'anthropic' } = {}) {
  const report = formatReport(result, url);
  if (!supportsVision || !result?.screenshot?.dataUrl) return report;
  const imageBlock = screenshotContentBlock(result.screenshot.dataUrl, provider);
  if (!imageBlock) return report;
  return [{ type: 'text', text: report }, imageBlock];
}

/**
 * Tool-layer convenience over `formatObservation` keyed on the ACTIVE model:
 * a `checkApp` result that carries a screenshot AND a vision-capable model
 * yields Anthropic-style content blocks
 * `[{ type: 'text', text }, { type: 'image', source: { type: 'base64', … } }]`;
 * any other combination (no screenshot, capture degraded to a note, or a
 * text-only model) returns the exact same plain-text report as before, so
 * callers can hand the return value to either transport unchanged.
 */
function buildVisionObservation({
  result,
  modelSupportsVision = false,
  url = null,
  provider = 'anthropic',
} = {}) {
  const safeResult = result && typeof result === 'object'
    ? result
    : { ok: false, unavailable: true, reason: 'no_result' };
  return formatObservation(safeResult, url ?? safeResult.url ?? '', {
    supportsVision: modelSupportsVision === true,
    provider,
  });
}

module.exports = {
  checkApp,
  captureBoundedScreenshot,
  screenshotContentBlock,
  buildVisionObservation,
  formatObservation,
  formatReport,
  devUrlFor,
  chromiumExecutablePath,
  DEFAULT_MAX_SCREENSHOT_BYTES,
  ABSOLUTE_MAX_SCREENSHOT_BYTES,
};
