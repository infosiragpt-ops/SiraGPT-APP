const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const calls = [];
  const pages = [];
  const windows = new Map([[1, { windowState: 'maximized', left: 0, top: 0, width: 1280, height: 900 }]]);
  let counter = 0;
  let failCommand = '';
  const clipCalls = [];
  const context = {
    pages: () => pages,
    newPage: async () => makePage('about:blank'),
    newCDPSession: async page => ({
      send: async (method, args) => {
        calls.push({ method, args, page: page.id });
        if (failCommand === method) throw new Error('private diagnostic must not become success');
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page.id } };
        if (method === 'Emulation.setDeviceMetricsOverride') { page.viewport = { width: args.width, height: args.height }; return {}; }
        if (method === 'Emulation.clearDeviceMetricsOverride') { page.viewport = null; return {}; }
        if (method === 'Runtime.evaluate') {
          const value = vm.runInNewContext(args.expression, { document: { title: page.documentTitle, readyState: page.readyState, hasFocus: () => page.focus, visibilityState: page.visible ? 'visible' : 'hidden' }, location: { href: page.url() }, innerWidth: (page.viewport || { width: 1280 }).width, innerHeight: (page.viewport || { height: 800 }).height });
          return { result: { value } };
        }
        if (method === 'Page.navigateToHistoryEntry') { page.index = args.entryId; return {}; }
        if (method === 'Page.getNavigationHistory') return { currentIndex: page.index, entries: page.history.map((url, id) => ({ id, url })) };
        if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { ...windows.get(1) } };
        if (method === 'Browser.setWindowBounds') { windows.set(args.windowId, { ...windows.get(args.windowId), ...args.bounds }); return {}; }
        throw Error('Unexpected CDP: ' + method);
      },
      detach: async () => calls.push('detach'),
    }),
  };
  function makePage(url) {
    const page = {
      id: 'target-' + ++counter, history: [url], index: 0, focus: pages.length === 0, visible: pages.length === 0, readyState: 'complete', documentTitle: url === 'about:blank' ? '' : 'Real page',
      context: () => context,
      title: async () => page.url() === 'about:blank' ? '' : 'Real page',
      url: () => page.history[page.index],
      evaluate: async fn => String(fn).includes('hasFocus') ? page.focus : (page.viewport || { width: 1280, height: 800 }),
      bringToFront: async () => { pages.forEach(p => { p.focus = p === page; p.visible = p === page; }); calls.push('front:' + page.id); },
      close: async () => { calls.push('close:' + page.id); pages.splice(pages.indexOf(page), 1); },
      goBack: async () => { page.index--; }, goForward: async () => { page.index++; },
      reload: async options => { calls.push({ reload: page.id, options }); },
      goto: async (url, options) => { page.history.splice(page.index + 1); page.history.push(url); page.index++; calls.push({ goto: page.id, url, options }); },
    };
    pages.push(page); return page;
  }
  const browser = { contexts: () => [context], close: async () => calls.push('disconnect') };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/computer/live-page'), 'utf8'), {
    module, exports: module.exports, process, AbortSignal, Map, Set,
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://test.invalid/browser' }) }),
    require: name => {
      if (name === 'node:timers/promises') return require(name);
      if (name === './orch-client') return { resolveOrchConfig: () => ({ url: 'http://test.invalid' }), orchFetch: async (path, options) => { clipCalls.push({ path, options }); if (failCommand === 'clip') throw new Error('clip failed'); return { ok: true }; } };
      if (name === './cdp-client') return { rewriteCdpWs: url => url };
      if (name === 'playwright') return { chromium: { connectOverCDP: async (_url, options) => { calls.push({ connect: options }); return browser; } } };
      throw Error('Unexpected dependency: ' + name);
    },
  });
  return { ...module.exports, makePage, pages, calls, windows, clipCalls, fail: method => { failCommand = method; } };
}
const session = { sessionId: 'owned-desktop' };

test('browser inventory is read-only even when the persistent browser has no tabs', async () => {
  const h = harness();
  const state = await h.browserState(session);
  assert.deepEqual(JSON.parse(JSON.stringify(state.tabs)), []);
  assert.equal(state.activeTabId, null);
  assert.equal(h.pages.length, 0);
  assert.equal(state.canGoBack, false);
  assert.equal(h.calls.at(-1), 'disconnect');
});

test('real target identity selects tabs and navigation never falls back on a stale or foreign id', async () => {
  const h = harness();
  const first = h.makePage('https://example.com/first');
  const second = h.makePage('https://example.com/second');
  const state = await h.browserAction(session, { type: 'browser_tab_select', tabId: second.id });
  assert.equal(state.activeTabId, second.id);
  assert.equal(state.tabs[1].url, second.url());
  await h.navigatePage(session, 'https://example.com/redirected', process.env, undefined, { tabId: first.id });
  assert.equal(first.url(), 'https://example.com/redirected');
  assert.equal(second.url(), 'https://example.com/second');
  const writes = h.calls.filter(x => x?.goto).length;
  await assert.rejects(h.navigatePage(session, 'https://example.com/wrong', process.env, undefined, { tabId: 'foreign-target' }), e => e.code === 'browser_tab_missing');
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_close', tabId: 'foreign-target' }), e => e.code === 'browser_tab_missing');
  assert.equal(h.calls.filter(x => x?.goto).length, writes);
  assert.equal(h.pages.length, 2);
});

test('history and reload are backed by the selected page, not optimistic frontend state', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/one');
  page.history.push('https://example.com/two'); page.index = 1;
  let state = await h.browserState(session);
  assert.equal(state.canGoBack, true); assert.equal(state.canGoForward, false);
  state = await h.browserAction(session, { type: 'browser_back', tabId: page.id });
  assert.equal(state.tabs[0].url, 'https://example.com/one');
  assert.equal(state.canGoBack, false); assert.equal(state.canGoForward, true);
  state = await h.browserAction(session, { type: 'browser_forward', tabId: page.id });
  assert.equal(state.tabs[0].url, 'https://example.com/two');
  await h.browserAction(session, { type: 'browser_reload', tabId: page.id });
  assert.equal(h.calls.find(x => x?.reload).reload, page.id);
  h.fail('Page.getNavigationHistory');
  await assert.rejects(h.browserState(session), /private diagnostic/);
});

test('closing the last real tab creates its blank replacement before closing and preserves Chrome', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  const state = await h.browserAction(session, { type: 'browser_tab_close', tabId: page.id });
  assert.equal(h.pages.length, 1);
  assert.notEqual(state.activeTabId, page.id);
  assert.equal(state.tabs[0].url, 'about:blank');
  assert.equal(state.tabs[0].title, 'Nueva pestaña');
  assert.ok(h.calls.indexOf('front:' + state.activeTabId) < h.calls.indexOf('close:' + page.id));
});

test('presentation enters fullscreen idempotently and restores the original window state', async () => {
  const h = harness();
  h.makePage('https://example.com/');
  assert.equal((await h.browserAction(session, { type: 'browser_present' })).presentation, 'embedded');
  assert.equal(h.windows.get(1).windowState, 'fullscreen');
  await h.browserAction(session, { type: 'browser_present' });
  assert.equal(h.calls.filter(c => c?.method === 'Browser.setWindowBounds').length, 1);
  assert.equal((await h.browserAction(session, { type: 'browser_restore' })).presentation, 'desktop');
  assert.equal(h.windows.get(1).windowState, 'maximized');
  await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(h.calls.filter(c => c?.method === 'Browser.setWindowBounds').length, 2);
});

test('unknown actions and invalid target identifiers fail before reading or changing the browser', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await assert.rejects(h.browserAction(session, { type: 'browser_arbitrary_eval', code: 'secret' }), e => e.code === 'browser_action_invalid');
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_select', tabId: '../other' }), e => e.code === 'browser_action_invalid');
  assert.equal(h.calls.length, 0);
});


test('viewport reflows the real page and sends only bounded dimensions to its owned desktop', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  let state = await h.browserAction(session, { type: 'browser_resize', width: 430, height: 900 });
  assert.equal(state.viewport.width, 430); assert.equal(state.viewport.height, 900);
  assert.equal(h.windows.get(1).windowState, 'fullscreen');
  assert.equal(h.clipCalls[0].path, '/sessions/owned-desktop/agent/action');
  assert.deepEqual(JSON.parse(JSON.stringify(h.clipCalls[0].options.body)), { type: 'browser_viewport', width: 430, height: 900 });
  state = await h.browserAction(session, { type: 'browser_tab_create' });
  assert.equal(state.viewport.width, 430, 'new tabs inherit the visible content dimensions');
  state = await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(state.viewport.width, 1280);
  assert.equal(page.viewport, null, 'restoration clears metrics from every tab, not just the active one');
  assert.equal(h.clipCalls.at(-1).options.body.type, 'browser_restore_viewport');
  assert.equal(h.windows.get(1).windowState, 'maximized');
});

test('invalid dimensions never reach CDP or the compositor and a clip failure remains restorable', async () => {
  const h = harness(); h.makePage('https://example.com/');
  for (const width of [0, -1, 1921, '430', 1.5, Infinity, '430;curl private']) {
    await assert.rejects(h.browserAction(session, { type: 'browser_resize', width, height: 900 }), e => e.code === 'browser_action_invalid');
  }
  assert.equal(h.calls.length, 0); assert.equal(h.clipCalls.length, 0);
  h.fail('clip');
  await assert.rejects(h.browserAction(session, { type: 'browser_resize', width: 430, height: 900 }), error => error.code === 'browser_viewport_failed');
  h.fail('');
  await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(h.windows.get(1).windowState, 'maximized');
  assert.equal(h.clipCalls.at(-1).options.body.type, 'browser_restore_viewport');
});

test('desktop viewport mapper is closed to shell injection and retains the server display', () => {
  const { buildActionCommand } = require('../../services/computer-orchestrator/agent-actions');
  assert.equal(buildActionCommand({ type: 'browser_viewport', width: 430, height: 900 }), "x11vnc -sync -remote 'clip:430x900+0+0'");
  assert.equal(buildActionCommand({ type: 'browser_restore_viewport' }), "x11vnc -sync -remote 'clip:'");
  for (const width of [undefined, '430', 0, -5, 1930, 1.3, '20; touch /tmp/injection']) assert.equal(buildActionCommand({ type: 'browser_viewport', width, height: 900 }), null);
  for (const height of [0, 1081, 2.3, '900']) assert.equal(buildActionCommand({ type: 'browser_viewport', width: 430, height }), null);
});

test('a queued tab close cannot race a pending navigation on the same desktop', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  const originalGoto = page.goto;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  page.goto = async (...args) => { await waiting; return originalGoto(...args); };
  const navigation = h.navigatePage(session, 'https://example.com/next', process.env, undefined, { tabId: page.id });
  await new Promise(resolve => setImmediate(resolve));
  const closing = h.browserAction(session, { type: 'browser_tab_close', tabId: page.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes('close:' + page.id), false);
  release();
  assert.equal((await navigation).url, 'https://example.com/next');
  await closing;
  assert.ok(h.calls.findIndex(c => c?.goto) < h.calls.indexOf('close:' + page.id));
});

test('an aborted browser request cannot mutate a tab or block later actions', async () => {
  const h = harness(); const page = h.makePage('https://example.com/');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_close', tabId: page.id }, process.env, controller.signal), error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0); assert.equal(h.pages.length, 1);
  assert.equal((await h.browserAction(session, { type: 'browser_tab_select', tabId: page.id })).activeTabId, page.id);
});

test('normal window bounds survive repeated present and are restored without illegal CDP geometry', async () => {
  const h = harness(); h.makePage('https://example.com/');
  const original = { windowState: 'normal', left: 13, top: 21, width: 901, height: 711 };
  h.windows.set(1, { ...original });
  await h.browserAction(session, { type: 'browser_present' });
  await h.browserAction(session, { type: 'browser_present' });
  await h.browserAction(session, { type: 'browser_restore' });
  assert.deepEqual(h.windows.get(1), original);
  const restores = h.calls.filter(c => c?.method === 'Browser.setWindowBounds').slice(1);
  assert.equal(restores[0].args.bounds.windowState, 'normal');
  assert.equal(Object.keys(restores[0].args.bounds).length, 1);
  assert.equal(restores[1].args.bounds.width, original.width);
});

test('switching apps waits for a pending presentation before restoring, including its first window', async () => {
  const h = harness(); const page = h.makePage('https://example.com/');
  const context = page.context();
  const createSession = context.newCDPSession;
  let first = true, release;
  const waiting = new Promise(resolve => { release = resolve; });
  context.newCDPSession = async target => {
    const cdp = await createSession(target);
    const send = cdp.send;
    cdp.send = async (method, args) => {
      if (method === 'Browser.getWindowForTarget' && first) { first = false; await waiting; }
      return send(method, args);
    };
    return cdp;
  };
  const presenting = h.browserAction(session, { type: 'browser_present' });
  await new Promise(resolve => setImmediate(resolve));
  const restoring = h.restoreBrowserPresentation(session);
  release();
  await presenting; await restoring;
  assert.equal(h.windows.get(1).windowState, 'maximized');
});

test('a failed viewport cannot be acknowledged by tab changes, polling or navigation without explicit recovery', async () => {
  const h = harness(); const page = h.makePage('https://example.com/');
  h.fail('clip');
  await assert.rejects(h.browserAction(session, { type: 'browser_resize', width: 430, height: 900 }));
  h.fail('');
  const attempts = h.clipCalls.length;
  const oldUrl = page.url();
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_create' }), error => error.code === 'browser_viewport_failed');
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_select', tabId: page.id }), error => error.code === 'browser_viewport_failed');
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await assert.rejects(h.navigatePage(session, 'https://example.com/next'), error => error.code === 'browser_viewport_failed');
  assert.equal(h.pages.length, 1, 'unconfirmed presentation must not mutate another tab');
  assert.equal(page.url(), oldUrl);
  assert.equal(h.clipCalls.length, attempts, 'no action or poll may silently retry clip');
  const recovered = await h.browserAction(session, { type: 'browser_resize', width: 430, height: 900 });
  assert.equal(recovered.viewport.width, 430);
  assert.equal(h.clipCalls.length, attempts + 1, 'only explicit resize retries the failed command');
  assert.equal((await h.browserAction(session, { type: 'browser_tab_create' })).tabs.length, 2);
});

test('a partially failed restore remains unconfirmed until an explicit restore succeeds', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 430, height: 900 });
  h.fail('clip');
  await assert.rejects(h.browserAction(session, { type: 'browser_restore' }));
  h.fail('');
  const attempts = h.clipCalls.length;
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_create' }), error => error.code === 'browser_viewport_failed');
  assert.equal(h.clipCalls.length, attempts);
  const restored = await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(restored.presentation, 'desktop');
  assert.equal(restored.viewport.width, 1280);
  assert.equal((await h.browserState(session)).presentation, 'desktop');
});


test('cached history restores confirm the real document without relying on a new DOMContentLoaded or stale utility context', async () => {
  const h = harness(); const page = h.makePage('https://example.com/one');
  page.history.push('https://example.com/two'); page.index = 1;
  page.goBack = async () => { page.index = 0; const error = new Error('cached document does not emit DOMContentLoaded'); error.name = 'TimeoutError'; throw error; };
  page.title = async () => { throw new Error('stale utility context after BFCache'); };
  const state = await h.browserAction(session, { type: 'browser_back', tabId: page.id });
  assert.equal(state.tabs[0].url, 'https://example.com/one');
  assert.equal(state.tabs[0].title, 'Real page');
  assert.equal(state.canGoBack, false); assert.equal(state.canGoForward, true);
  assert.equal(h.calls.filter(call => call?.method === 'Page.navigateToHistoryEntry').length, 1);
  assert.equal(h.calls.find(call => call?.method === 'Page.navigateToHistoryEntry').args.entryId, 0);
});

test('same-URL history entries confirm entry identity in both directions and do not navigate beyond boundaries', async () => {
  const h = harness(); const page = h.makePage('https://example.com/same');
  page.history.push(page.url()); page.index = 1;
  await h.browserAction(session, { type: 'browser_back', tabId: page.id });
  assert.equal(page.index, 0);
  await h.browserAction(session, { type: 'browser_back', tabId: page.id });
  await h.browserAction(session, { type: 'browser_forward', tabId: page.id });
  assert.equal(page.index, 1);
  await h.browserAction(session, { type: 'browser_forward', tabId: page.id });
  const navigations = h.calls.filter(call => call?.method === 'Page.navigateToHistoryEntry');
  assert.deepEqual(navigations.map(call => call.args.entryId), [0, 1]);
});

test('a committed but still-loading history document cannot be acknowledged and abort does not repeat navigation', async () => {
  const h = harness(); const page = h.makePage('https://example.com/one');
  page.history.push('https://example.com/two'); page.index = 1; page.readyState = 'loading';
  await assert.rejects(h.browserAction(session, { type: 'browser_back', tabId: page.id }, process.env, AbortSignal.timeout(60)), error => error.name === 'TimeoutError');
  assert.equal(h.calls.filter(call => call?.method === 'Page.navigateToHistoryEntry').length, 1);
  assert.equal(h.calls.at(-1), 'disconnect');
});


test('reconnection preserves native focus and chooses the visible tab when Chrome is not focused', async () => {
  const h = harness();
  const first = h.makePage('https://example.com/background');
  const second = h.makePage('https://example.com/current');
  first.focus = false; first.visible = false;
  second.focus = false; second.visible = true;
  // The stale Playwright utility context must not decide which native tab wins.
  first.evaluate = async () => true;
  const state = await h.browserState(session);
  assert.equal(state.activeTabId, second.id);
  assert.equal(h.calls.find(call => call.connect).connect.noDefaults, true);
});

test('native focused window wins over a visible tab in a background window', async () => {
  const h = harness();
  const first = h.makePage('https://example.com/background-window');
  const second = h.makePage('https://example.com/focused-window');
  first.focus = false; first.visible = true;
  // Native activation can precede its visibility-change event.
  second.focus = true; second.visible = false;
  first.evaluate = async () => true;
  assert.equal((await h.browserState(session)).activeTabId, second.id);
});

test('a native tab switch after a tool selection is observed without remembering a stale target', async () => {
  const h = harness();
  const first = h.makePage('https://example.com/first');
  const second = h.makePage('https://example.com/second');
  await h.browserAction(session, { type: 'browser_tab_select', tabId: second.id });
  first.focus = false; second.focus = false;
  first.visible = true; second.visible = false;
  assert.equal((await h.browserState(session)).activeTabId, first.id);
  first.visible = false; second.visible = true;
  assert.equal((await h.browserState(session)).activeTabId, second.id);
});
