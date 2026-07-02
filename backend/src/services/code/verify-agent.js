'use strict';

/**
 * verify-agent — "does the generated app actually work?" functional check.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Replit-style POST-RUN verification pass for the /code host runner. After a
 * generated project's dev server reaches `ready`, this agent drives a headless
 * Chromium page at the app's local URL and reports whether the thing actually
 * RENDERS — as opposed to `npx tsc --noEmit` (host-runner.verifyRun) which only
 * proves it type-checks. A project can type-check perfectly and still boot to a
 * blank screen, a Vite error overlay, or a "Potemkin" UI of dead buttons.
 *
 * Public API:
 *   verifyRenderedApp({ url, requiredMarkers?, timeoutMs?, launch? }) → verdict
 *
 * Design constraints (mirror of research-agent.js):
 *   - Playwright is loaded LAZILY (mirror of research-agent's getPlaywright).
 *     If Playwright is absent OR chromium can't launch, we DEGRADE GRACEFULLY:
 *     return { skipped:true, ok:true } — a missing browser must NEVER block the
 *     app. "skipped" is explicitly NOT a failure.
 *   - Every await is timeout-bounded; total wall-time is capped by `timeoutMs`.
 *   - The browser is ALWAYS closed in a `finally`, on every code path.
 *   - The in-page snapshot script is a FIXED, SAFE string — we never eval any
 *     LLM/user-provided code inside the page. It is exported so it can be
 *     unit-checked in isolation.
 *   - `launch` is an injectable browser-factory override so the whole flow can be
 *     unit-tested against a scripted fake page WITHOUT a real chromium binary.
 */

// ── Tunables ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  timeoutMs: 20_000,       // hard cap on the whole verification
  minTextLength: 12,       // body innerText length that counts as "rendered"
  navGotoTimeoutMs: 15_000, // per-goto ceiling (still ≤ timeoutMs overall)
};

// ── Lazy Playwright loader (mirror of research-agent.getPlaywright) ─────────
let playwrightModule = null;
function getPlaywright() {
  if (playwrightModule !== null) return playwrightModule;
  try {
    playwrightModule = require('playwright');
  } catch {
    playwrightModule = false; // marker: tried, not available
  }
  return playwrightModule;
}

/**
 * SNAPSHOT_SCRIPT — a FIXED, SAFE in-page probe. Runs inside `page.evaluate`,
 * so it executes in the app's DOM context but is authored entirely by us; no
 * dynamic/LLM code is ever injected. Returns a structured, JSON-serialisable
 * snapshot. Exported (named const) so it can be sanity-checked by a unit test.
 *
 * It takes the required markers + the "rendered" text threshold as arguments so
 * the string itself stays parameter-free and deterministic.
 */
const SNAPSHOT_SCRIPT = `(function(args){
  var markers = (args && args.markers) || [];
  var minText = (args && typeof args.minText === 'number') ? args.minText : 12;
  function txt(el){ try { return (el && el.innerText || '').trim(); } catch (e) { return ''; } }

  var body = document.body;
  var bodyText = txt(body);
  var textLength = bodyText.length;

  // "rendered": either the body has real text, OR the SPA root actually mounted
  // children (React/Next hydrate into #root / #__next).
  var root = document.getElementById('root') || document.getElementById('__next');
  var rootChildCount = root ? root.children.length : 0;
  var rootHasContent = textLength > minText || rootChildCount > 0;

  // Error-overlay detection: Vite (<vite-error-overlay>), Next.js dev overlay,
  // a React error-boundary fallback, or plain crash strings.
  var lower = bodyText.toLowerCase();
  var hasViteOverlay = !!document.querySelector('vite-error-overlay') ||
    !!document.querySelector('[data-vite-dev-id][style*="z-index"]');
  var hasNextOverlay = !!document.querySelector('nextjs-portal') ||
    !!document.querySelector('#__next-build-watcher') ||
    !!document.querySelector('[data-nextjs-dialog], [data-nextjs-error-overlay]');
  var crashPhrases = [
    'application error', 'internal server error', 'cannot get /',
    'unhandled runtime error', 'failed to compile', 'this page isn',
    '500 - ', '502 bad gateway', '503 service'
  ];
  var hasCrashText = crashPhrases.some(function(p){ return lower.indexOf(p) !== -1; });
  // A bare "500" alone is noisy; only count it as an overlay when it's the whole
  // (short) body — e.g. an unstyled error page.
  var isBare500 = textLength < 40 && /(^|\\s)5\\d\\d(\\s|$)/.test(bodyText);
  var hasErrorOverlay = hasViteOverlay || hasNextOverlay || hasCrashText || isBare500;

  // Extract the ACTUAL error text from the overlay so the finding is
  // actionable (the auto-repair loop can act on the real message, not just
  // "there is an overlay"). Vite renders inside a shadow DOM; Next in a portal.
  var overlayText = '';
  try {
    // Read the MESSAGE text out of a (possibly shadow-DOM) overlay root. The
    // overlay injects its own <style> (Bootstrap reset etc.), so a naive
    // textContent leads with CSS and buries the error — prefer known message
    // nodes, else concatenate leaf text while skipping style/script.
    function messageText(root){
      if (!root) return '';
      try {
        var pick = root.querySelector(
          '.nextjs-container-errors-header, [data-nextjs-dialog-header], ' +
          '.nextjs__container_errors__error, .error-overlay-message, ' +
          '.message-body, .message, pre, h1, h2'
        );
        if (pick && (pick.textContent || '').trim()) return pick.textContent;
        var out = [];
        var all = root.querySelectorAll('*');
        for (var j = 0; j < all.length && out.length < 60; j++) {
          var n = all[j];
          if (n.tagName === 'STYLE' || n.tagName === 'SCRIPT') continue;
          if (n.children.length === 0) {
            var tt = (n.textContent || '').trim();
            if (tt) out.push(tt);
          }
        }
        return out.join(' ');
      } catch (e) { return ''; }
    }
    function overlayRoot(el){
      if (!el) return null;
      try { if (el.shadowRoot) return el.shadowRoot; } catch (e) {}
      return el;
    }
    var vo = document.querySelector('vite-error-overlay');
    if (vo) {
      overlayText = messageText(overlayRoot(vo));
    } else if (hasNextOverlay) {
      var nd = document.querySelector('nextjs-portal') ||
        document.querySelector('[data-nextjs-dialog], [data-nextjs-error-overlay]');
      overlayText = messageText(overlayRoot(nd));
    } else if (hasCrashText || isBare500) {
      overlayText = bodyText;
    }
    // Last-resort generic scan: any custom element whose shadow root carries
    // error text (covers framework variants our selectors miss).
    if (!overlayText) {
      var hosts = document.querySelectorAll('*');
      for (var i = 0; i < hosts.length && i < 400; i++) {
        var sr = hosts[i].shadowRoot;
        if (!sr) continue;
        var cand = messageText(sr);
        if (/error|exception|failed|is not defined|cannot|unexpected/i.test(cand)) { overlayText = cand; break; }
      }
    }
    overlayText = String(overlayText).replace(/\\s+/g, ' ').trim().slice(0, 600);
  } catch (e) { overlayText = ''; }

  // Buttons + "Potemkin" heuristic: a button/[role=button] with no click affordance
  // (no onclick attr, not inside a <form>, no data-* handler hint) is best-effort
  // evidence of a decorative, non-functional control.
  var buttonEls = Array.prototype.slice.call(
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')
  );
  var buttonCount = buttonEls.length;
  function looksWired(el){
    if (el.hasAttribute('onclick')) return true;
    if (el.type === 'submit' || el.type === 'button') { /* still needs a form/handler */ }
    if (el.closest && el.closest('form')) return true;
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var n = attrs[i].name || '';
      // data-* handler hints (data-action, data-testid on interactive, etc.) or
      // framework binding attrs (v-on:, @click, ng-click) count as "wired".
      if (n.indexOf('data-') === 0) return true;
      if (n === 'href') return true;
      if (n.charAt(0) === '@' || n.indexOf('v-on') === 0 || n.indexOf('ng-') === 0) return true;
    }
    return false;
  }
  var buttonsWithoutHandler = buttonEls.filter(function(el){ return !looksWired(el); }).length;

  // Links + dead-link heuristic (href empty or "#").
  var linkEls = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
  var linkCount = linkEls.length;
  var deadLinks = linkEls.filter(function(a){
    var h = (a.getAttribute('href') || '').trim();
    return h === '' || h === '#';
  }).length;

  var formCount = document.querySelectorAll('form').length;

  // Which required markers are present — in body text (case-insensitive) OR as a
  // data-testid attribute value.
  var presentMarkers = markers.filter(function(m){
    if (!m) return false;
    var needle = String(m);
    if (lower.indexOf(needle.toLowerCase()) !== -1) return true;
    try {
      if (document.querySelector('[data-testid="' + needle.replace(/"/g, '') + '"]')) return true;
    } catch (e) { /* invalid selector — ignore */ }
    return false;
  });

  return {
    rootHasContent: rootHasContent,
    textLength: textLength,
    hasErrorOverlay: hasErrorOverlay,
    overlayText: overlayText,
    buttonCount: buttonCount,
    buttonsWithoutHandler: buttonsWithoutHandler,
    linkCount: linkCount,
    deadLinks: deadLinks,
    formCount: formCount,
    presentMarkers: presentMarkers
  };
})`;

// A neutral snapshot used whenever the real probe can't run (never crashes the verdict).
function emptySnapshot() {
  return {
    rootHasContent: false,
    textLength: 0,
    hasErrorOverlay: false,
    overlayText: '',
    buttonCount: 0,
    buttonsWithoutHandler: 0,
    linkCount: 0,
    deadLinks: 0,
    formCount: 0,
    presentMarkers: [],
  };
}

// Guard a promise with a timeout so a hung page.* can never block forever.
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}`)), Math.max(1, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * verifyRenderedApp — open the app in headless chromium and report whether it
 * actually renders + works.
 *
 * @param {object}   opts
 * @param {string}   opts.url                  local dev-server URL to open
 * @param {string[]} [opts.requiredMarkers=[]] text / data-testid values that MUST be present
 * @param {number}   [opts.timeoutMs=20000]    hard wall-time cap
 * @param {function} [opts.launch]             injectable browser factory (tests) —
 *                                             async () => browser (Playwright-shaped)
 * @returns {Promise<object>} verdict — see the return shapes below.
 */
async function verifyRenderedApp({ url, requiredMarkers = [], timeoutMs = DEFAULTS.timeoutMs, launch } = {}) {
  const markers = Array.isArray(requiredMarkers) ? requiredMarkers.filter(Boolean).map(String) : [];
  const cap = Math.max(2_000, Number(timeoutMs) || DEFAULTS.timeoutMs);
  const startedAt = Date.now();

  if (!url || typeof url !== 'string') {
    // Nothing to open — treat as skipped (no browser work attempted).
    return { skipped: true, reason: 'no_url', ok: true, findings: [] };
  }

  // Resolve the browser factory. When no override is supplied, fall back to the
  // lazily-loaded Playwright chromium. If Playwright itself is absent → skip.
  let launchFn = typeof launch === 'function' ? launch : null;
  if (!launchFn) {
    const pw = getPlaywright();
    if (!pw) {
      return { skipped: true, reason: 'chromium_unavailable', ok: true, findings: [] };
    }
    // On Alpine (node:*-alpine) Playwright's bundled chromium doesn't run
    // (musl); we install the system `chromium` apk and point Playwright at it
    // via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. --no-sandbox is required running
    // as a non-root container user; --disable-dev-shm-usage avoids the tiny
    // /dev/shm crashing chromium. Falls back to Playwright's own browser when
    // the env var is unset (e.g. local dev with a downloaded chromium).
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH ||
      undefined;
    launchFn = () => pw.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }

  let browser = null;
  try {
    // Launch — a missing chromium BINARY throws here. Degrade, don't fail.
    try {
      browser = await withTimeout(Promise.resolve(launchFn()), Math.min(cap, 10_000), 'launch');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      // eslint-disable-next-line no-console
      console.warn('[verify-agent] chromium launch failed, skipping runtime check:', msg);
      return { skipped: true, reason: 'chromium_unavailable', ok: true, findings: [] };
    }
    if (!browser) {
      return { skipped: true, reason: 'chromium_unavailable', ok: true, findings: [] };
    }

    // ── Signal collectors (populated by page listeners) ──────────────────
    const consoleErrors = [];
    const pageErrors = [];
    const failedResponses = [];
    let navStatus = null;

    // Open a page (Playwright: newPage on the browser; some fakes expose it on a context).
    const page = await withTimeout(Promise.resolve(openPage(browser)), Math.min(cap, 8_000), 'newPage');
    if (!page) {
      return { skipped: true, reason: 'no_page', ok: true, findings: [] };
    }

    // Wire listeners defensively — a fake page may not implement `.on`.
    safeOn(page, 'console', (msg) => {
      try {
        const type = typeof msg.type === 'function' ? msg.type() : msg.type;
        if (type === 'error') {
          const text = typeof msg.text === 'function' ? msg.text() : msg.text;
          consoleErrors.push(String(text || '').slice(0, 500));
        }
      } catch { /* best effort */ }
    });
    safeOn(page, 'pageerror', (err) => {
      pageErrors.push(String((err && err.message) || err).slice(0, 500));
    });
    safeOn(page, 'response', (resp) => {
      try {
        const status = typeof resp.status === 'function' ? resp.status() : resp.status;
        if (typeof status === 'number' && status >= 500) {
          const rurl = typeof resp.url === 'function' ? resp.url() : resp.url;
          failedResponses.push({ url: String(rurl || '').slice(0, 300), status });
        }
      } catch { /* best effort */ }
    });

    // ── Navigate (bounded). Prefer networkidle, but fall back to 'load' — an app
    // with a persistent HMR websocket / long-poll never reaches networkidle. ──
    const remaining = () => Math.max(1_000, cap - (Date.now() - startedAt));
    const gotoTimeout = Math.min(DEFAULTS.navGotoTimeoutMs, remaining());
    try {
      let resp = null;
      try {
        resp = await withTimeout(
          Promise.resolve(page.goto(url, { waitUntil: 'networkidle', timeout: gotoTimeout })),
          gotoTimeout + 500,
          'goto:networkidle',
        );
      } catch {
        // networkidle can legitimately time out (live HMR socket). Retry with 'load'.
        resp = await withTimeout(
          Promise.resolve(page.goto(url, { waitUntil: 'load', timeout: Math.min(DEFAULTS.navGotoTimeoutMs, remaining()) })),
          Math.min(DEFAULTS.navGotoTimeoutMs, remaining()) + 500,
          'goto:load',
        );
      }
      if (resp) {
        navStatus = typeof resp.status === 'function' ? resp.status() : resp.status;
      }
    } catch (err) {
      // Navigation entirely failed (dev server down, connection refused, hard
      // timeout). That IS a failure of the rendered app — record and continue to
      // build the verdict (no snapshot).
      pageErrors.push(`navigation_failed: ${(err && err.message) || err}`);
    }

    // Give a beat for late client-side render, bounded by what's left.
    if (typeof page.waitForTimeout === 'function' && remaining() > 1_200) {
      try { await withTimeout(Promise.resolve(page.waitForTimeout(500)), 900, 'settle'); } catch { /* ignore */ }
    }

    // ── In-page snapshot (fixed safe script; never eval LLM code) ─────────
    let snapshot = emptySnapshot();
    try {
      // Playwright's string-form page.evaluate does NOT bind a second arg, so we
      // bake the args into the script as a self-invoking IIFE literal (markers
      // come from project source → JSON.stringify escapes them safely). This
      // avoids the "arguments is not defined" trap of `})(arguments[0])`.
      const snapshotCall = `${SNAPSHOT_SCRIPT}(${JSON.stringify({ markers, minText: DEFAULTS.minTextLength })})`;
      const raw = await withTimeout(
        Promise.resolve(page.evaluate(snapshotCall)),
        Math.min(4_000, remaining()),
        'evaluate',
      );
      if (raw && typeof raw === 'object') snapshot = { ...emptySnapshot(), ...raw };
    } catch (err) {
      pageErrors.push(`snapshot_failed: ${(err && err.message) || err}`);
    }

    return buildVerdict({ navStatus, snapshot, markers, consoleErrors, pageErrors, failedResponses });
  } finally {
    // ALWAYS close the browser, on every code path.
    if (browser && typeof browser.close === 'function') {
      try { await withTimeout(Promise.resolve(browser.close()), 5_000, 'close'); } catch { /* ignore */ }
    }
  }
}

// Open a page whether the fake/real browser exposes newPage directly or via a context.
async function openPage(browser) {
  if (typeof browser.newPage === 'function') return browser.newPage();
  if (typeof browser.newContext === 'function') {
    const ctx = await browser.newContext();
    if (ctx && typeof ctx.newPage === 'function') return ctx.newPage();
  }
  return null;
}

function safeOn(emitter, event, handler) {
  if (emitter && typeof emitter.on === 'function') {
    try { emitter.on(event, handler); } catch { /* best effort */ }
  }
}

/**
 * buildVerdict — turn the collected signals + snapshot into the final verdict.
 * `ok` is true iff: navigation was 2xx/3xx (or unknown-but-rendered) AND the
 * root rendered content AND no error overlay AND no page/console errors AND
 * every required marker is present. Potemkin buttons and dead links are WARNINGS
 * (they don't by themselves fail the check).
 */
function buildVerdict({ navStatus, snapshot, markers, consoleErrors, pageErrors, failedResponses }) {
  const findings = [];
  const errors = [];
  const warnings = [];

  const navOk = navStatus == null
    ? snapshot.rootHasContent // no status (some fakes) — trust the render signal
    : (navStatus >= 200 && navStatus < 400);

  if (navStatus != null && !navOk) {
    const f = { severity: 'error', kind: 'failed_request', message: `La navegación devolvió HTTP ${navStatus}.` };
    findings.push(f); errors.push(f.message);
  }

  if (!snapshot.rootHasContent) {
    const f = { severity: 'error', kind: 'blank', message: 'La app cargó pero no renderizó contenido (pantalla en blanco / root vacío).' };
    findings.push(f); errors.push(f.message);
  }

  if (snapshot.hasErrorOverlay) {
    // Include the REAL overlay error text so the auto-repair loop can act on it.
    const detail = typeof snapshot.overlayText === 'string' && snapshot.overlayText.trim()
      ? ` Error: ${snapshot.overlayText.trim()}`
      : '';
    const f = { severity: 'error', kind: 'error_overlay', message: `Se detectó un overlay de error en pantalla (Vite/Next/error boundary).${detail}` };
    findings.push(f); errors.push(f.message);
  }

  for (const pe of pageErrors) {
    const f = { severity: 'error', kind: 'js_runtime_error', message: `Error de JavaScript en ejecución: ${pe}` };
    findings.push(f); errors.push(f.message);
  }

  for (const ce of consoleErrors) {
    const f = { severity: 'error', kind: 'console_error', message: `Error en consola: ${ce}` };
    findings.push(f); errors.push(f.message);
  }

  for (const fr of failedResponses) {
    const f = { severity: 'error', kind: 'failed_request', message: `Petición fallida (${fr.status}): ${fr.url}` };
    findings.push(f); errors.push(f.message);
  }

  const missingMarkers = markers.filter((m) => !snapshot.presentMarkers.includes(m));
  for (const m of missingMarkers) {
    const f = { severity: 'error', kind: 'missing_marker', message: `Falta el elemento esperado: "${m}".` };
    findings.push(f); errors.push(f.message);
  }

  // Potemkin / dead-UI heuristics → warnings only.
  if (snapshot.buttonsWithoutHandler > 0 && snapshot.buttonCount > 0) {
    const f = {
      severity: 'warn',
      kind: 'potemkin_buttons',
      message: `${snapshot.buttonsWithoutHandler} de ${snapshot.buttonCount} botones no parecen tener acción (posible UI decorativa).`,
    };
    findings.push(f); warnings.push(f.message);
  }
  if (snapshot.deadLinks > 0) {
    const f = {
      severity: 'warn',
      kind: 'dead_links',
      message: `${snapshot.deadLinks} enlace(s) apuntan a "#" o vacío (sin destino).`,
    };
    findings.push(f); warnings.push(f.message);
  }

  const ok = navOk
    && snapshot.rootHasContent
    && !snapshot.hasErrorOverlay
    && pageErrors.length === 0
    && consoleErrors.length === 0
    && failedResponses.length === 0
    && missingMarkers.length === 0;

  const summary = ok
    ? `La app renderiza correctamente${markers.length ? ` (marcadores presentes: ${snapshot.presentMarkers.length}/${markers.length})` : ''}${warnings.length ? ` · ${warnings.length} aviso(s)` : ''}.`
    : `La app tiene ${errors.length} problema(s)${warnings.length ? ` + ${warnings.length} aviso(s)` : ''}: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? ' …' : ''}`;

  return {
    ok,
    skipped: false,
    navStatus: navStatus == null ? null : navStatus,
    rendered: !!snapshot.rootHasContent,
    errors,
    warnings,
    findings,
    summary,
  };
}

module.exports = {
  verifyRenderedApp,
  SNAPSHOT_SCRIPT,
  // Exported for white-box tests / reuse.
  buildVerdict,
  emptySnapshot,
  DEFAULTS,
};
