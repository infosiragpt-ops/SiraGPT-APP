'use strict';

/**
 * F6 — `browser_act`: Playwright driven through the ACCESSIBILITY TREE.
 *
 * Vision (screenshot-driven computer use) is F7 — this tool deliberately
 * exposes NO screenshots. The model reads the page as an a11y tree and acts
 * on elements by accessibility role + name, which is cheaper, deterministic
 * and keeps the "web content = data" contract auditable in plain text.
 *
 * Placement: the browser runs as a child process of the Node backend (a
 * dedicated Playwright worker), NOT inside the gVisor sandbox — the F5
 * sandbox keeps `--network none`. SSRF posture mirrors web_fetch:
 *   - the target of every `open` must pass the same assertSafeUrl checks
 *     (http/https only, default ports, no credentials, no IP literals,
 *     localhost/*.internal/*.local blocked);
 *   - on top of that, EVERY request the page makes (subresources, XHR,
 *     client-side redirects) is re-checked in a context.route() gate and
 *     aborted when it targets a blocked host.
 *
 * Lifecycle: one lazy browser session per executor set (per runner turn).
 * It closes on: explicit `close` action, the turn's AbortSignal (F3 Stop),
 * an idle TTL, or process exit. Playwright is REQUIRED lazily — when it is
 * not installed the tool reports an honest ERROR instead of crashing the
 * runner at load time.
 */

const { wrapUntrustedWebData, makeAbortError } = require('./untrusted');

const MAX_SNAPSHOT_CHARS = 16_000;
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_MS = 120_000;

const ROLE_RE = /^[a-z][a-z0-9 _-]{0,40}$/i;

function envInt(env, key, fallback) {
  const n = Number.parseInt(env?.[key] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadPlaywrightDefault() {
  // eslint-disable-next-line global-require
  return require('playwright');
}

/** Reuse web_fetch's URL-level SSRF gate (throws WebFetchError). */
function assertSafeBrowserUrl(rawUrl) {
  const { assertSafeUrl } = require('../../agent-harness/tools/web-fetch-tool');
  return assertSafeUrl(rawUrl);
}

function isSafeBrowserUrl(rawUrl) {
  try { assertSafeBrowserUrl(rawUrl); return true; } catch (_) { return false; }
}

/**
 * Create the browser_act executor. Injectables (tests):
 *   - loadPlaywright: () => playwright-like module ({ chromium.launch }).
 *   - launch:         async (pw) => browser (overrides chromium.launch).
 *   - env:            environment map for timeouts/idle TTL.
 */
function createBrowserActExecutor({
  env = process.env,
  loadPlaywright = loadPlaywrightDefault,
  launch,
} = {}) {
  const navTimeoutMs = envInt(env, 'SIRAGPT_AGENT_BROWSER_NAV_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
  const actionTimeoutMs = envInt(env, 'SIRAGPT_AGENT_BROWSER_ACTION_TIMEOUT_MS', DEFAULT_ACTION_TIMEOUT_MS);
  const idleMs = envInt(env, 'SIRAGPT_AGENT_BROWSER_IDLE_MS', DEFAULT_IDLE_MS);

  let session = null; // { browser, context, page }
  let idleTimer = null;
  let exitHookInstalled = false;

  async function closeSession() {
    const s = session;
    session = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (s && s.browser && typeof s.browser.close === 'function') {
      try { await s.browser.close(); } catch (_) { /* already gone */ }
    }
  }

  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!session) return;
    idleTimer = setTimeout(() => { closeSession(); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function ensurePage() {
    if (session && session.page) return session.page;
    let pw;
    try {
      pw = loadPlaywright();
    } catch (err) {
      const e = new Error(
        'browser_unavailable: playwright is not installed in this deployment '
        + `(${err && err.message}). Use web_fetch for static pages instead.`,
      );
      e.code = 'browser_unavailable';
      throw e;
    }
    let browser;
    try {
      browser = launch
        ? await launch(pw)
        : await pw.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    } catch (err) {
      const e = new Error(
        'browser_unavailable: chromium could not be launched '
        + `(${err && err.message}). Run "npx playwright install chromium" or use web_fetch instead.`,
      );
      e.code = 'browser_unavailable';
      throw e;
    }
    const context = typeof browser.newContext === 'function'
      ? await browser.newContext({ userAgent: 'siraGPT-agent-browser/1.0 (+https://siragpt.com)' })
      : browser;
    // Per-request SSRF gate: a page cannot pull the agent into localhost,
    // private ranges or cloud metadata via subresources/XHR/JS redirects.
    // Safe URLs use route.fallback() (→ next handler if any, else network)
    // so offline tests can register a fulfilling route underneath the gate.
    if (typeof context.route === 'function') {
      await context.route('**/*', (route) => {
        const reqUrl = route.request().url();
        if (!isSafeBrowserUrl(reqUrl)) {
          route.abort('blockedbyclient');
        } else if (typeof route.fallback === 'function') {
          route.fallback();
        } else {
          route.continue();
        }
      });
    }
    const page = typeof context.newPage === 'function' ? await context.newPage() : context;
    session = { browser, context, page };
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once('exit', () => {
        // Best-effort sync kill on process exit (async close can't run here).
        try { if (session && session.browser && session.browser.close) session.browser.close(); } catch (_) { /* ignore */ }
      });
    }
    touchIdle();
    return page;
  }

  async function snapshotOf(page) {
    let tree = null;
    // Playwright ≥1.49: YAML-ish aria snapshot — compact and role/name based.
    try {
      if (typeof page.locator === 'function') {
        const body = page.locator('body');
        if (body && typeof body.ariaSnapshot === 'function') {
          tree = await body.ariaSnapshot({ timeout: actionTimeoutMs });
        }
      }
    } catch (_) { tree = null; }
    // Fallback: the (deprecated but functional) accessibility.snapshot().
    if (!tree) {
      try {
        const acc = page.accessibility && typeof page.accessibility.snapshot === 'function'
          ? await page.accessibility.snapshot()
          : null;
        if (acc) tree = JSON.stringify(acc, null, 1);
      } catch (_) { tree = null; }
    }
    let title = '';
    try { title = typeof page.title === 'function' ? await page.title() : ''; } catch (_) { title = ''; }
    const url = typeof page.url === 'function' ? page.url() : '';
    const treeText = String(tree || '(accessibility tree unavailable)');
    return {
      url,
      title,
      truncated: treeText.length > MAX_SNAPSHOT_CHARS,
      tree: treeText.slice(0, MAX_SNAPSHOT_CHARS),
    };
  }

  function snapshotResult(snap, extra = {}) {
    return wrapUntrustedWebData(
      JSON.stringify({ ...extra, ...snap }, null, 1),
      { kind: 'web page accessibility tree' },
    );
  }

  function locatorFor(page, role, name) {
    if (typeof page.getByRole !== 'function') {
      throw new Error('this Playwright version does not support getByRole');
    }
    const locator = page.getByRole(role, name ? { name } : {});
    return typeof locator.first === 'function' ? locator.first() : locator;
  }

  return async function browserAct(args, ctx = {}) {
    const action = String(args?.action || '').trim().toLowerCase();
    const signal = ctx.signal;
    if (signal?.aborted) throw makeAbortError('browser_act aborted');

    // F3: a Stop mid-action kills the browser — the pending goto/click then
    // rejects immediately instead of running to its own timeout.
    let onAbort = null;
    if (signal) {
      onAbort = () => { closeSession(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      switch (action) {
        case 'open': {
          const url = String(args?.url || '').trim();
          if (!url) return 'ERROR: url is required for action "open"';
          try {
            assertSafeBrowserUrl(url);
          } catch (err) {
            return `ERROR: browser_act blocked url (${err?.code || 'unsafe_url'}): ${err?.message || String(err)}`;
          }
          const page = await ensurePage();
          await page.goto(url, { timeout: navTimeoutMs, waitUntil: 'domcontentloaded' });
          return snapshotResult(await snapshotOf(page), { action: 'open' });
        }
        case 'snapshot': {
          if (!session || !session.page) return 'ERROR: no page is open — call browser_act with action "open" first';
          return snapshotResult(await snapshotOf(session.page), { action: 'snapshot' });
        }
        case 'click': {
          if (!session || !session.page) return 'ERROR: no page is open — call browser_act with action "open" first';
          const role = String(args?.role || '').trim();
          const name = String(args?.name || '').trim();
          if (!role || !ROLE_RE.test(role)) return 'ERROR: a valid accessibility "role" is required for action "click"';
          const target = locatorFor(session.page, role, name);
          await target.click({ timeout: actionTimeoutMs });
          return snapshotResult(await snapshotOf(session.page), { action: 'click', role, name });
        }
        case 'type': {
          if (!session || !session.page) return 'ERROR: no page is open — call browser_act with action "open" first';
          const role = String(args?.role || '').trim();
          const name = String(args?.name || '').trim();
          const text = String(args?.text ?? '');
          if (!role || !ROLE_RE.test(role)) return 'ERROR: a valid accessibility "role" is required for action "type"';
          const target = locatorFor(session.page, role, name);
          await target.fill(text, { timeout: actionTimeoutMs });
          if (args?.press_enter === true && typeof target.press === 'function') {
            await target.press('Enter', { timeout: actionTimeoutMs });
          }
          return snapshotResult(await snapshotOf(session.page), { action: 'type', role, name });
        }
        case 'close': {
          await closeSession();
          return 'OK: browser closed';
        }
        default:
          return `ERROR: unknown browser_act action "${action}". Use open | snapshot | click | type | close.`;
      }
    } catch (err) {
      if (signal?.aborted) throw makeAbortError('browser_act aborted');
      return `ERROR: browser_act ${action || '(none)'} failed (${err?.code || err?.name || 'error'}): ${err?.message || String(err)}`;
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      touchIdle();
    }
  };
}

module.exports = {
  createBrowserActExecutor,
  isSafeBrowserUrl,
  MAX_SNAPSHOT_CHARS,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_IDLE_MS,
};
