'use strict';

// Observe the SAME Chrome as the VNC panel. No input values or credentials
// are read. Coordinates let text-only models operate ordinary forms too.
const { resolveOrchConfig, orchFetch } = require('./orch-client');
const { rewriteCdpWs } = require('./cdp-client');

async function withLiveBrowser(session, env, signal, run) {
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
  const browser = await chromium.connectOverCDP(rewriteCdpWs(version.webSocketDebuggerUrl, base), { headers, timeout: 8000, noDefaults: true });
  const disconnect = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', disconnect, { once: true });
  try {
    signal?.throwIfAborted();
    return await run(browser);
  } finally {
    signal?.removeEventListener('abort', disconnect);
    // Disconnect CDP; never destroy the user's persistent browser.
    await browser.close().catch(() => {});
  }
}

function browserError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.publicMessage = code === 'browser_tab_missing'
    ? 'La pestaña ya no está disponible. Selecciona otra pestaña.'
    : 'No se pudo completar la acción del navegador. Vuelve a intentarlo.';
  return error;
}

function validateTabId(tabId, required = false) {
  if (tabId === undefined && !required) return;
  if (typeof tabId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tabId)) throw browserError('browser_action_invalid');
}

async function targetId(page) {
  const cdp = await page.context().newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach().catch(() => {}); }
}

async function selectPage(browser, tabId, createPage = false) {
  const pages = browser.contexts().flatMap(context => context.pages());
  if (tabId !== undefined) {
    validateTabId(tabId, true);
    for (const page of pages) if (await targetId(page) === tabId) return page;
    // Never redirect a stale/foreign target to another tab in this session.
    throw browserError('browser_tab_missing', 404);
  }
  // CDP attachment must preserve native focus. A background Chrome window can
  // have a visible tab without document focus; the focused window takes priority.
  // Read the current document directly, avoiding BFCache utility-context state.
  let visiblePage;
  for (const page of pages) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const data = await cdp.send('Runtime.evaluate', {
        expression: '({ focused: document.hasFocus(), visible: document.visibilityState === "visible" })',
        returnByValue: true,
      });
      const state = data?.result?.value;
      if (data?.exceptionDetails || typeof state?.focused !== 'boolean' || typeof state?.visible !== 'boolean') {
        throw browserError('browser_document_unavailable', 502);
      }
      if (state.focused) return page;
      if (state.visible && !visiblePage) visiblePage = page;
    } finally { await cdp.detach().catch(() => {}); }
  }
  if (visiblePage) return visiblePage;
  if (pages[0]) return pages[0];
  if (createPage && browser.contexts()[0]) return browser.contexts()[0].newPage();
  return null;
}

async function withLivePage(session, env, signal, run, { createPage = false, tabId } = {}) {
  validateTabId(tabId);
  return withLiveBrowser(session, env, signal, async browser => {
    const page = await selectPage(browser, tabId, createPage);
    if (!page) throw new Error('browser_page_missing');
    return run(page);
  });
}

// Only presentation changes are retained, never browsing content or credentials.
// Session commands are serialized so repeated present/restore cannot overwrite
// the original window bounds. Read-only inventories do not create a session/tab.
const presentationBySession = new Map();
const viewportBySession = new Map();
const pendingBySession = new Map();
const BROWSER_ACTIONS = new Set([
  'browser_tab_create', 'browser_tab_select', 'browser_tab_close',
  'browser_back', 'browser_forward', 'browser_reload', 'browser_present', 'browser_restore', 'browser_resize',
]);

function validateBrowserAction(action) {
  if (!action || !BROWSER_ACTIONS.has(action.type)) throw browserError('browser_action_invalid');
  validateTabId(action.tabId, action.type === 'browser_tab_select' || action.type === 'browser_tab_close');
  if (action.type === 'browser_resize' && (!Number.isInteger(action.width) || !Number.isInteger(action.height)
    || action.width < 32 || action.height < 32 || action.width > 1920 || action.height > 1080)) throw browserError('browser_action_invalid');
}

async function inBrowserOrder(session, signal, run) {
  const key = session.sessionId;
  const previous = pendingBySession.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); return run(); });
  pendingBySession.set(key, next);
  try { return await next; }
  finally { if (pendingBySession.get(key) === next) pendingBySession.delete(key); }
}

async function presentPage(session, page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: id });
    let windows = presentationBySession.get(session.sessionId);
    if (!windows) {
      // Refuse additional retained state rather than evicting an active user's
      // restoration data. Closed panels release their entries via restore.
      if (presentationBySession.size >= 1000) throw browserError('browser_presentation_capacity', 503);
      windows = new Map();
      presentationBySession.set(session.sessionId, windows);
    }
    if (!windows.has(windowId)) windows.set(windowId, { ...bounds });
    if (bounds.windowState !== 'fullscreen') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    }
  } finally { await cdp.detach().catch(() => {}); }
}

async function setPageViewport(page, viewport) {
  const cdp = await page.context().newCDPSession(page);
  try {
    if (viewport) await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    else await cdp.send('Emulation.clearDeviceMetricsOverride');
  } finally { await cdp.detach().catch(() => {}); }
}

async function clipViewport(session, viewport, env, signal) {
  try {
    const data = await orchFetch('/sessions/' + encodeURIComponent(session.sessionId) + '/agent/action', {
      method: 'POST', env,
      body: viewport ? { type: 'browser_viewport', ...viewport } : { type: 'browser_restore_viewport' },
      fetchImpl: (url, init) => fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, init.signal]) : init.signal }),
    });
    if (data?.ok !== true) throw browserError('browser_viewport_failed', 502);
  } catch (cause) {
    const error = browserError('browser_viewport_failed', 502);
    error.cause = cause;
    throw error;
  }
}

function requireConfirmedViewport(session) {
  const viewport = viewportBySession.get(session.sessionId);
  if (viewport && !viewport.confirmed) throw browserError('browser_viewport_failed', 502);
}

async function restorePresentation(session, browser, env, signal) {
  if (viewportBySession.has(session.sessionId)) {
    // Clearing Chrome metrics and resetting RFB are one presentation change.
    // A partial restore remains failed, even if Chrome alone now has its old size.
    viewportBySession.get(session.sessionId).confirmed = false;
    for (const page of browser.contexts().flatMap(context => context.pages())) await setPageViewport(page, null);
    await clipViewport(session, null, env, signal);
    viewportBySession.delete(session.sessionId);
  }
  const saved = presentationBySession.get(session.sessionId);
  if (!saved) return;
  const visited = new Set();
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: id });
      if (visited.has(windowId) || !saved.has(windowId)) continue;
      visited.add(windowId);
      const bounds = saved.get(windowId);
      // CDP forbids geometry and a non-normal windowState in the same call.
      const restore = bounds.windowState && bounds.windowState !== 'normal'
        ? { windowState: bounds.windowState } : { ...bounds, windowState: 'normal' };
      if (restore.windowState === 'normal') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: restore });
      saved.delete(windowId);
    } finally { await cdp.detach().catch(() => {}); }
  }
  // Entries for windows closed by the user are no longer restorable.
  presentationBySession.delete(session.sessionId);
}

// A BFCache restore does not emit a new DOMContentLoaded and can leave the
// temporary Playwright connection's utility context waiting for a new document.
// Read only fixed, visible metadata directly from the actual document instead.
async function readPageDocument(cdp) {
  const data = await cdp.send('Runtime.evaluate', {
    expression: '({ title: document.title, url: location.href, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight } })',
    returnByValue: true,
  });
  const value = data?.result?.value;
  if (data?.exceptionDetails || !value || typeof value.title !== 'string' || typeof value.url !== 'string'
    || !['loading', 'interactive', 'complete'].includes(value.readyState)
    || !Number.isFinite(value.viewport?.width) || !Number.isFinite(value.viewport?.height)) {
    throw browserError('browser_document_unavailable', 502);
  }
  return value;
}

async function navigateHistory(page, delta, signal) {
  const { setTimeout: delay } = require('node:timers/promises');
  const cdp = await page.context().newCDPSession(page);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  // Closing this CDP session also rejects a pending protocol command at the
  // existing deadline; it never closes Chrome or repeats the navigation.
  const abort = () => { void cdp.detach().catch(() => {}); };
  deadline.addEventListener('abort', abort, { once: true });
  try {
    deadline.throwIfAborted();
    const history = await cdp.send('Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return;
    await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    for (;;) {
      deadline.throwIfAborted();
      const current = await cdp.send('Page.getNavigationHistory');
      const active = current.entries[current.currentIndex];
      if (active?.id === entry.id) {
        const document = await readPageDocument(cdp);
        if (document.readyState !== 'loading' && document.url === active.url) {
          const confirmed = await cdp.send('Page.getNavigationHistory');
          const final = confirmed.entries[confirmed.currentIndex];
          if (final?.id === entry.id && final.url === document.url) { deadline.throwIfAborted(); return; }
        }
      }
      // Confirmation polling only; navigateToHistoryEntry is sent exactly once.
      await delay(25, undefined, { signal: deadline });
    }
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) throw browserError('browser_history_timeout', 504);
    throw error;
  } finally {
    deadline.removeEventListener('abort', abort);
    await cdp.detach().catch(() => {});
  }
}

async function readBrowserState(session, browser, selected) {
  requireConfirmedViewport(session);
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = selected || await selectPage(browser);
  const tabs = [];
  let activeTabId = null;
  let canGoBack = false, canGoForward = false, viewport = null, presentation = 'desktop';
  for (const candidate of pages) {
    const cdp = await candidate.context().newCDPSession(candidate);
    try {
      const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
      const document = await readPageDocument(cdp);
      tabs.push({ id, title: document.title.slice(0, 300) || 'Nueva pestaña', url: document.url });
      if (candidate !== page) continue;
      activeTabId = id;
      const history = await cdp.send('Page.getNavigationHistory');
      if (presentationBySession.has(session.sessionId)) {
        const { bounds } = await cdp.send('Browser.getWindowForTarget');
        if (bounds.windowState === 'fullscreen') presentation = 'embedded';
      }
      canGoBack = history.currentIndex > 0;
      canGoForward = history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1;
      viewport = document.viewport;
    } finally { await cdp.detach().catch(() => {}); }
  }
  return { tabs, activeTabId, canGoBack, canGoForward, viewport, presentation };
}

async function browserState(session, env = process.env, signal) {
  return withLiveBrowser(session, env, signal, browser => readBrowserState(session, browser));
}

async function browserAction(session, action, env = process.env, signal) {
  validateBrowserAction(action);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  return inBrowserOrder(session, signal, () => withLiveBrowser(session, env, signal, async browser => {
    let page;
    if (action.type === 'browser_restore') {
      await restorePresentation(session, browser, env, signal);
      return readBrowserState(session, browser);
    }
    // Only an explicit resize or restore may repair an unconfirmed framebuffer.
    // Tab changes must not acknowledge DOM dimensions that RFB never applied.
    if (action.type !== 'browser_resize') requireConfirmedViewport(session);
    if (action.type === 'browser_tab_create') {
      const context = browser.contexts()[0];
      if (!context) throw browserError('browser_page_missing', 503);
      page = await context.newPage();
    } else {
      page = await selectPage(browser, action.tabId, action.type === 'browser_present' || action.type === 'browser_resize');
    }
    if (!page) throw browserError('browser_tab_missing', 404);
    if (action.type === 'browser_tab_close') {
      const pages = browser.contexts().flatMap(context => context.pages());
      const next = pages.find(candidate => candidate !== page) || await page.context().newPage();
      // Opening the replacement first keeps the last Chrome window/profile alive.
      await next.bringToFront();
      await page.close();
      page = next;
    } else {
      await page.bringToFront();
      const options = { waitUntil: 'domcontentloaded', timeout: 15000 };
      if (action.type === 'browser_back' || action.type === 'browser_forward') {
        await navigateHistory(page, action.type === 'browser_back' ? -1 : 1, signal);
      } else if (action.type === 'browser_reload') await page.reload(options);
    }
    if (action.type === 'browser_present' || action.type === 'browser_resize' || presentationBySession.has(session.sessionId)) await presentPage(session, page);
    const previousViewport = viewportBySession.get(session.sessionId);
    if (action.type === 'browser_resize') {
      const viewport = { size: { width: action.width, height: action.height }, confirmed: false };
      // Retain cleanup information before either mutation, but do not expose the
      // requested size as applied until both Chrome and the RFB server accept it.
      viewportBySession.set(session.sessionId, viewport);
      await setPageViewport(page, viewport.size);
      await clipViewport(session, viewport.size, env, signal);
      viewport.confirmed = true;
    } else if (previousViewport) await setPageViewport(page, previousViewport.size);
    return readBrowserState(session, browser, page);
  }));
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

async function navigatePage(session, url, env = process.env, signal, { tabId } = {}) {
  validateTabId(tabId);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  return inBrowserOrder(session, signal, () => {
    requireConfirmedViewport(session);
    return withLivePage(session, env, signal, async (page) => {
      await page.bringToFront();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { ok: true, url: page.url() };
    }, { createPage: true, tabId });
  });
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

async function restoreBrowserPresentation(session, env = process.env, signal) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  return inBrowserOrder(session, signal, async () => {
    // A preceding present may still be connecting and has not saved its bounds
    // yet. Check only after it settles, before another desktop app is focused.
    if (!presentationBySession.has(session.sessionId) && !viewportBySession.has(session.sessionId)) return;
    return withLiveBrowser(session, env, signal, browser => restorePresentation(session, browser, env, signal));
  });
}

module.exports = { observePage, navigatePage, actPage, browserState, browserAction, validateBrowserAction, restoreBrowserPresentation };
