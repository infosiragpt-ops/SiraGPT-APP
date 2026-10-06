const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ abortSignal = AbortSignal } = {}) {
  const calls = [];
  const pages = [];
  const windows = new Map([[1, { windowState: 'maximized', left: 0, top: 0, width: 1280, height: 900 }]]);
  let counter = 0;
  let failCommand = '';
  let hangOwner;
  const clipCalls = [];
  const connections = [];
  const timers = new Set();
  const pending = new Set();
  let cdpDown = 0;
  let relaunchError = null;
  const relaunches = [];
  const context = {
    pages: () => pages,
    newPage: async () => makePage('about:blank'),
    newCDPSession: async (page, owner) => {
      let detached = false;
      const cdp = {
      send: async (method, args) => {
        if (detached || owner?.closed) throw new Error('CDP session closed');
        calls.push({ method, args, page: page.id });
        if (failCommand === method) throw new Error('private diagnostic must not become success');
        if (failCommand === 'hang:' + method || (failCommand === 'hang-owner:' + method && owner === hangOwner)) return new Promise((resolve, reject) => pending.add({ owner, reject }));
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page.id } };
        if (method === 'Emulation.setDeviceMetricsOverride') {
          if (failCommand !== 'metrics-noop') { page.viewport = { width: args.width, height: args.height }; page.viewportOwner = cdp; }
          return {};
        }
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
      detach: async () => {
        if (detached) return;
        detached = true;
        // Chromium immediately drops an override when its owning CDP session
        // detaches. This behavior is essential to the lifetime regression.
        if (page.viewportOwner === cdp) { page.viewport = null; page.viewportOwner = null; }
        owner?.sessions.delete(cdp);
        calls.push('detach');
      },
      };
      owner?.sessions.add(cdp);
      return cdp;
    },
  };
  function makePage(url) {
    const page = Object.assign(new EventEmitter(), {
      id: 'target-' + ++counter, history: [url], index: 0, focus: pages.length === 0, visible: pages.length === 0, readyState: 'complete', documentTitle: url === 'about:blank' ? '' : 'Real page',
      context: () => context,
      title: async () => page.url() === 'about:blank' ? '' : 'Real page',
      url: () => page.history[page.index],
      evaluate: async fn => String(fn).includes('hasFocus') ? page.focus : (page.viewport || { width: 1280, height: 800 }),
      bringToFront: async () => { pages.forEach(p => { p.focus = p === page; p.visible = p === page; }); calls.push('front:' + page.id); },
      close: async () => { calls.push('close:' + page.id); pages.splice(pages.indexOf(page), 1); page.emit('close'); },
      goBack: async () => { page.index--; }, goForward: async () => { page.index++; },
      reload: async options => { calls.push({ reload: page.id, options }); },
      goto: async (url, options) => { page.history.splice(page.index + 1); page.history.push(url); page.index++; calls.push({ goto: page.id, url, options }); },
    });
    pages.push(page); return page;
  }
  function connectBrowser() {
    const browser = Object.assign(new EventEmitter(), { closed: false, sessions: new Set() });
    const wrappers = new Map();
    const wrap = page => {
      if (!wrappers.has(page)) wrappers.set(page, new Proxy(page, { get(target, key) {
        if (key === 'context') return () => connectedContext;
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } }));
      return wrappers.get(page);
    };
    const connectedContext = { pages: () => pages.map(wrap), newPage: async () => wrap(makePage('about:blank')),
      newCDPSession: page => context.newCDPSession(page, browser) };
    browser.contexts = () => [connectedContext];
    browser.close = async () => {
      if (browser.closed) return;
      browser.closed = true;
      for (const cdp of [...browser.sessions]) await cdp.detach();
      for (const item of [...pending]) if (item.owner === browser) { pending.delete(item); item.reject(new Error('CDP session closed')); }
      browser.emit('disconnected'); calls.push('disconnect');
    };
    connections.push(browser);
    return browser;
  }
  const vmModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/computer/live-page'), 'utf8'), {
    module: vmModule, exports: vmModule.exports, process, AbortSignal: abortSignal, Map, Set,
    setTimeout: (run, ms) => { const timer = { run, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    fetch: async () => {
      if (cdpDown > 0) { cdpDown -= 1; return { ok: false, status: 502, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://test.invalid/browser' }) };
    },
    Date,
    require: name => {
      if (name === 'node:timers/promises') return require(name);
      if (name === './persistent') return { dockerExec: async (sessionArg, command, options) => { relaunches.push({ session: sessionArg, command, options }); if (relaunchError) throw relaunchError; cdpDown = 0; return { ok: true }; } };
      if (name === './chrome-desktop-flags') return { chromeMaximizeOrLaunch: () => 'launch-chrome-with-cdp' };
      if (name === './orch-client') return { resolveOrchConfig: () => ({ url: 'http://test.invalid' }), orchFetch: async (path, options) => { clipCalls.push({ path, options }); if (failCommand === 'clip') throw new Error('clip failed'); return { ok: true }; } };
      if (name === './cdp-client') return { rewriteCdpWs: url => url };
      if (name === 'playwright') return { chromium: { connectOverCDP: async (_url, options) => { calls.push({ connect: options }); return connectBrowser(); } } };
      throw Error('Unexpected dependency: ' + name);
    },
  });
  return { ...vmModule.exports, makePage, pages, calls, windows, clipCalls, connections, timers, relaunches,
    cdp: { down: (count = Infinity) => { cdpDown = count; }, relaunchFails: error => { relaunchError = error; } },
    expireIdle: async () => { for (const timer of [...timers]) { timers.delete(timer); timer.run(); } await new Promise(resolve => setImmediate(resolve)); },
    fail: method => { failCommand = method; if (method.startsWith('hang-owner:')) hangOwner = connections.find(browser => !browser.closed); } };
}
const session = { sessionId: 'owned-desktop' };

function holdNextProtocolResponse(page, methodToHold) {
  const context = page.context();
  const createSession = context.newCDPSession.bind(context);
  let entered, resume;
  const reached = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  let held = false;
  context.newCDPSession = async (...args) => {
    const cdp = await createSession(...args);
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      const response = await send(method, params);
      if (!held && method === methodToHold) {
        held = true;
        entered();
        await released;
      }
      return response;
    };
    return cdp;
  };
  return { reached, resume };
}

test('a delayed inventory cannot invalidate a newer confirmed viewport', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  // Runtime.evaluate has captured the old dimensions before history replies.
  // Only the transport timing changes; every protocol response remains real
  // fixture state and the production observation code is unmodified.
  const hold = holdNextProtocolResponse(page, 'Page.getNavigationHistory');
  const inventory = h.browserState(session);
  await hold.reached;
  const resize = h.browserAction(session, { type: 'browser_resize', width: 901, height: 777 });
  await new Promise(resolve => setImmediate(resolve));
  hold.resume();
  const [before, resized] = await Promise.all([inventory, resize]);
  assert.equal(before.viewport.width, 813);
  assert.equal(resized.viewport.width, 901);
  assert.equal(resized.viewport.height, 777);
  const after = await h.browserState(session);
  assert.equal(after.viewport.width, 901);
  assert.equal(after.viewport.height, 777);
  await h.navigatePage(session, 'https://example.com/next');
  assert.equal(h.calls.filter(call => call?.goto).length, 1);
  await h.browserAction(session, { type: 'browser_restore' });
});

test('a queued inventory waits for resize confirmation instead of observing a partial viewport', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  const hold = holdNextProtocolResponse(page, 'Emulation.setDeviceMetricsOverride');
  const resize = h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  await hold.reached;
  const inventory = h.browserState(session);
  // Install a handler before yielding: the pre-fix inventory rejects here.
  const result = inventory.then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  hold.resume();
  await resize;
  const observed = await result;
  assert.equal(observed.error, undefined);
  assert.equal(observed.value.viewport.width, 813);
  assert.equal(observed.value.viewport.height, 917);
  await h.browserAction(session, { type: 'browser_restore' });
});

test('cancelling an inventory in the session queue returns without opening another connection', async () => {
  const h = harness();
  const page = h.makePage('https://example.com/');
  const hold = holdNextProtocolResponse(page, 'Page.getNavigationHistory');
  const inventory = h.browserState(session);
  await hold.reached;
  const connections = h.connections.length;
  const controller = new AbortController();
  const queued = h.browserState(session, process.env, controller.signal);
  const rejected = assert.rejects(queued, error => error.name === 'AbortError');
  controller.abort();
  await rejected;
  assert.equal(h.connections.length, connections);
  hold.resume();
  await inventory;
  assert.equal((await h.browserState(session)).tabs.length, 1);
});

test('the inventory deadline includes time waiting in the session queue', async () => {
  const deadlines = [];
  const h = harness({ abortSignal: {
    any: signals => AbortSignal.any(signals),
    timeout: ms => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    },
  } });
  const page = h.makePage('https://example.com/');
  const hold = holdNextProtocolResponse(page, 'Page.getNavigationHistory');
  const inventory = h.browserState(session);
  await hold.reached;
  const connections = h.connections.length;
  const count = deadlines.length;
  const queued = h.browserState(session);
  const rejected = assert.rejects(queued, error => error.name === 'TimeoutError');
  assert.equal(deadlines.length, count + 1, 'the queue wait starts its deadline before any new CDP request');
  const deadline = deadlines.at(-1);
  assert.equal(deadline.ms, 25000);
  deadline.controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  await rejected;
  assert.equal(h.connections.length, connections);
  hold.resume();
  await inventory;
  assert.equal((await h.browserState(session)).tabs.length, 1);
});

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

for (const focused of [true, false]) {
  test(`closing a background tab preserves the native ${focused ? 'focused' : 'visible'} tab among three tabs`, async () => {
    const h = harness();
    const first = h.makePage('https://example.com/first');
    const background = h.makePage('https://example.com/background');
    const active = h.makePage('https://example.com/active');
    await active.bringToFront();
    active.focus = focused;
    h.calls.length = 0;

    const state = await h.browserAction(session, { type: 'browser_tab_close', tabId: background.id });

    assert.equal(state.activeTabId, active.id);
    assert.deepEqual(h.pages.map(page => page.id), [first.id, active.id]);
    assert.equal(active.visible, true);
    assert.equal(active.focus, focused, 'closing a background tab does not steal desktop focus');
    assert.equal(first.focus, false);
    assert.deepEqual(h.calls.filter(call => typeof call === 'string' && /^(front|close):/.test(call)), ['close:' + background.id]);
  });
}

test('closing the active tab among three tabs confirms the focused surviving replacement', async () => {
  const h = harness();
  const first = h.makePage('https://example.com/first');
  const middle = h.makePage('https://example.com/middle');
  const active = h.makePage('https://example.com/active');
  await active.bringToFront();
  h.calls.length = 0;

  const state = await h.browserAction(session, { type: 'browser_tab_close', tabId: active.id });

  assert.equal(state.activeTabId, first.id);
  assert.deepEqual(h.pages.map(page => page.id), [first.id, middle.id]);
  assert.equal(first.focus, true);
  assert.equal(first.visible, true);
  assert.deepEqual(h.calls.filter(call => typeof call === 'string' && /^(front|close):/.test(call)), ['front:' + first.id, 'close:' + active.id]);
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

test('viewport survives request disconnection and releases every owner session on restore', async () => {
  const h = harness(); h.makePage('chrome://newtab/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  const observed = await h.browserState(session);
  assert.equal(observed.viewport.width, 813, 'an independent request sees the actual retained width');
  assert.equal(observed.viewport.height, 917);
  const owner = h.connections.find(browser => !browser.closed);
  assert.ok(owner, 'the viewport has one owner after the request connection closes');
  assert.equal(h.connections.filter(browser => !browser.closed).length, 1);
  assert.equal(owner.sessions.size, 1);
  for (let index = 0; index < 3; index++) {
    const state = await h.browserState(session);
    assert.equal(state.viewport.width, 813); assert.equal(state.viewport.height, 917);
    assert.equal(h.connections.filter(browser => !browser.closed).length, 1);
  }
  assert.equal(h.pages[0].url(), 'chrome://newtab/', 'retaining presentation never replaces an internal/user tab');
  await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(h.connections.every(browser => browser.closed), true);
  assert.equal(owner.sessions.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.pages[0].viewport, null);
});

test('aborting an observation leaves the independent viewport owner connected', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  const owner = h.connections.find(browser => !browser.closed);
  h.fail('hang:Runtime.evaluate');
  const controller = new AbortController();
  const reading = h.browserState(session, process.env, controller.signal);
  const rejected = assert.rejects(reading);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected;
  h.fail('');
  assert.equal(owner.closed, false);
  assert.equal((await h.browserState(session)).viewport.width, 813);
  await h.browserAction(session, { type: 'browser_restore' });
});

for (const method of ['Emulation.setDeviceMetricsOverride', 'Target.getTargetInfo']) {
  test(`aborting a retained ${method} command releases the queue for explicit recovery`, async () => {
    const h = harness(); h.makePage('https://example.com/');
    await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
    const owner = h.connections.find(browser => !browser.closed);
    const page = method === 'Target.getTargetInfo' ? h.makePage('https://example.com/new') : h.pages[0];
    h.fail('hang-owner:' + method);
    const controller = new AbortController();
    const resizing = h.browserAction(session, { type: 'browser_resize', tabId: page.id, width: 430, height: 900 }, process.env, controller.signal);
    const rejected = assert.rejects(resizing);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await rejected;
    assert.equal(owner.closed, true, 'abort closes the retained connection, not only the request observer');
    h.fail('');
    await h.browserAction(session, { type: 'browser_restore' });
    assert.equal(h.connections.every(browser => browser.closed), true);
    assert.equal(h.windows.get(1).windowState, 'maximized');
  });
}

test('aborting an unresponsive clear command releases its owner and allows a later explicit restore', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  h.fail('hang-owner:Emulation.clearDeviceMetricsOverride');
  const controller = new AbortController();
  const restoring = h.browserAction(session, { type: 'browser_restore' }, process.env, controller.signal);
  const rejected = assert.rejects(restoring, error => error.code === 'browser_viewport_failed');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected; h.fail('');
  assert.equal(h.connections.every(browser => browser.closed), true);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(h.windows.get(1).windowState, 'maximized');
});

test('lost viewport owner fails closed and an explicit resize can acquire a fresh owner', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  await h.connections.find(browser => !browser.closed).close();
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await assert.rejects(h.browserAction(session, { type: 'browser_tab_create' }), error => error.code === 'browser_viewport_failed');
  const repaired = await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  assert.equal(repaired.viewport.width, 813);
  await h.browserAction(session, { type: 'browser_restore' });
});

test('a successful CDP acknowledgement without actual reflow never confirms the viewport', async () => {
  const h = harness(); h.makePage('https://example.com/'); h.fail('metrics-noop');
  await assert.rejects(h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 }), error => error.code === 'browser_viewport_failed');
  h.fail('');
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await h.browserAction(session, { type: 'browser_restore' });
});

test('idle viewport restores original desktop geometry and releases the persistent connection', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  assert.equal([...h.timers][0].ms, 5 * 60_000);
  await h.expireIdle();
  assert.equal(h.windows.get(1).windowState, 'maximized');
  assert.equal(h.pages[0].viewport, null);
  assert.equal(h.clipCalls.at(-1).options.body.type, 'browser_restore_viewport');
  assert.equal(h.connections.every(browser => browser.closed), true);
  assert.equal(h.timers.size, 0);
  assert.equal((await h.browserState(session)).presentation, 'desktop');
});

test('an idle callback queued before recent activity cannot retire the active viewport', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  const staleTimer = [...h.timers][0];
  await h.browserState(session);
  staleTimer.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.connections.filter(browser => !browser.closed).length, 1);
  assert.equal((await h.browserState(session)).viewport.width, 813);
  await h.browserAction(session, { type: 'browser_restore' });
});

test('failed idle restoration releases resources but preserves the repair gate and original bounds', async () => {
  const h = harness(); h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  h.fail('clip'); await h.expireIdle(); h.fail('');
  assert.equal(h.connections.every(browser => browser.closed), true);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.browserState(session), error => error.code === 'browser_viewport_failed');
  await h.browserAction(session, { type: 'browser_restore' });
  assert.equal(h.windows.get(1).windowState, 'maximized');
});

test('closing an emulated tab releases its target session without disconnecting the surviving viewport', async () => {
  const h = harness(); const first = h.makePage('https://example.com/');
  await h.browserAction(session, { type: 'browser_resize', width: 813, height: 917 });
  await h.browserAction(session, { type: 'browser_tab_create' });
  const owner = h.connections.find(browser => !browser.closed);
  assert.equal(owner.sessions.size, 2);
  await h.browserAction(session, { type: 'browser_tab_close', tabId: first.id });
  assert.equal(owner.sessions.size, 1);
  assert.equal((await h.browserState(session)).viewport.width, 813);
  await h.browserAction(session, { type: 'browser_restore' });
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

// Prod 2026-10-03: with Chrome closed inside the desktop, every 4-second
// browser poll answered 502 for hours. CDP unreachable now relaunches Chrome
// (with its DevTools port) once per cooldown and continues; a desktop whose
// container is gone is reported as desktop_unavailable, never retried blindly.
test('an unreachable DevTools port relaunches Chrome in the same desktop and the inventory continues', async () => {
  const h = harness();
  h.makePage('https://example.com/');
  h.cdp.down(1);
  const state = await h.browserState(session);
  assert.equal(state.tabs.length, 1);
  assert.equal(h.relaunches.length, 1);
  assert.equal(h.relaunches[0].session, session);
  assert.equal(h.relaunches[0].command, 'launch-chrome-with-cdp');
  assert.ok(h.relaunches[0].options.timeoutMs <= 12_000);
});

test('a relaunch cooldown stops a dead desktop from becoming a relaunch storm', async () => {
  const h = harness();
  h.makePage('https://example.com/');
  h.cdp.down();
  h.cdp.relaunchFails(new Error('xdotool: desktop_app_not_ready'));
  await assert.rejects(h.browserState(session), error => error.code === 'browser_observation_unavailable' && error.status === 502);
  await assert.rejects(h.browserState(session), error => error.code === 'browser_observation_unavailable');
  assert.equal(h.relaunches.length, 1, 'second poll inside the cooldown must not relaunch again');
});

test('a missing desktop container is reported as desktop_unavailable with a user-facing message', async () => {
  const h = harness();
  h.cdp.down();
  h.cdp.relaunchFails(Object.assign(new Error('Command failed: docker exec'), { stderr: 'Error: No such container: sira-ac-user-luis' }));
  await assert.rejects(h.browserState(session), error => error.code === 'desktop_unavailable' && error.status === 503 && /Vuelve a abrir la computadora/.test(error.publicMessage));
});
