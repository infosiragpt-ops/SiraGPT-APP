'use strict';

// Observe the SAME Chrome as the VNC panel. No input values or credentials
// are read. Coordinates let text-only models operate ordinary forms too.
const { resolveOrchConfig } = require('./orch-client');
const { rewriteCdpWs } = require('./cdp-client');

async function withLivePage(session, env, signal, run, { createPage = false } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  signal.throwIfAborted();
  const cfg = resolveOrchConfig(env);
  const base = `${cfg.url}/sessions/${encodeURIComponent(session.sessionId)}/cdp`;
  const headers = cfg.secret ? { Authorization: `Bearer ${cfg.secret}` } : {};
  const response = await fetch(`${base}/json/version`, {
    headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('browser_observation_unavailable');
  const version = await response.json();
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(rewriteCdpWs(version.webSocketDebuggerUrl, base), { headers, timeout: 8000 });
  const disconnect = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', disconnect, { once: true });
  try {
    signal?.throwIfAborted();
    const pages = browser.contexts().flatMap((context) => context.pages());
    let page = pages[0];
    for (const candidate of pages) {
      if (await candidate.evaluate(() => document.hasFocus()).catch(() => false)) { page = candidate; break; }
    }
    // Fresh desktops start Chrome with --no-startup-window. Create only a
    // tab in THAT existing persistent context, never a separate browser.
    if (!page && createPage && browser.contexts()[0]) page = await browser.contexts()[0].newPage();
    if (!page) throw new Error('browser_page_missing');
    return await run(page);
  } finally {
    signal?.removeEventListener('abort', disconnect);
    // Disconnect CDP; never destroy the user's persistent browser.
    await browser.close().catch(() => {});
  }
}

async function observePage(session, env = process.env, signal) {
  return withLivePage(session, env, signal, (page) => page.evaluate(() => {
    const metadata = (el) => el ? {
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      name: el.getAttribute('name') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      label: el.getAttribute('aria-label') || el.labels?.[0]?.innerText || '',
    } : null;
    const controls = Array.from(document.querySelectorAll('input,textarea,select,button,a,[role="button"],[contenteditable="true"]'))
      .flatMap((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return [];
        const m = metadata(el);
        const label = String(m.label || el.innerText || el.getAttribute('placeholder') || m.name || m.type).slice(0, 100);
        return [{ label, type: m.type, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }];
      }).slice(0, 60);
    return {
      url: location.href, title: document.title,
      text: String(document.body?.innerText || '').slice(0, 5000),
      focused: metadata(document.activeElement), controls,
      center: { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) },
    };
  }));
}

async function navigatePage(session, url, env = process.env, signal) {
  return withLivePage(session, env, signal, async (page) => {
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { ok: true, url: page.url() };
  }, { createPage: true });
}

async function actPage(session, action, env = process.env, signal) {
  return withLivePage(session, env, signal, async (page) => {
    await page.bringToFront();
    if (action.type === 'click') {
      // A newly created Linux window may have DOM geometry before Chromium's
      // compositor can accept a raw mouse event. Use Playwright's actionability
      // checks on the observed hit target; never force a click through overlays.
      const hit = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), action);
      try {
        const element = hit.asElement();
        if (!element) throw new Error('browser_target_not_visible');
        const offset = await element.evaluate((el, point) => {
          const rect = el.getBoundingClientRect();
          return { x: point.x - rect.left - el.clientLeft, y: point.y - rect.top - el.clientTop };
        }, action);
        await element.click({ position: offset, button: action.button || 'left', timeout: 8000 });
      } finally { await hit.dispose(); }
    } else if (action.type === 'type') {
      await page.keyboard.insertText(action.text);
    } else if (action.type === 'keypress') {
      await page.keyboard.press(action.keys.join('+'));
    } else if (action.type === 'scroll') {
      const center = await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight / 2 }));
      await page.mouse.move(center.x, center.y);
      await page.mouse.wheel(action.scrollX || 0, action.scrollY || 0);
    } else {
      throw new Error('browser_action_unsupported');
    }
    return { ok: true, type: action.type };
  });
}

module.exports = { observePage, navigatePage, actPage };
