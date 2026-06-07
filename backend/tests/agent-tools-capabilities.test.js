const test = require('node:test');
const assert = require('node:assert/strict');

const agentTools = require('../src/services/agents/agent-tools');
const { createBrowserAdapter, createStubProvider } = require('../src/services/ai-product-os/adapters/browser-adapter');

test('agent tool registry exposes session, extraction and browser automation tools', () => {
  for (const name of [
    'session_search',
    'session_list',
    'session_history',
    'web_search',
    'web_extract',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_scroll',
  ]) {
    assert.ok(agentTools.TOOLS_BY_NAME.has(name), `${name} should be registered`);
    assert.equal(typeof agentTools[name]?.handler, 'function', `${name} should export a handler`);
  }
});

test('web_extract delegates to the protected read_url extractor', async () => {
  const out = await agentTools.web_extract.handler({ url: 'not-a-url' }, {});
  assert.equal(out.error, 'invalid_url');
});

test('session_list / session_history delegate to the session-recall service', async () => {
  // The service validates ctx.userId / args before touching prisma, so these
  // paths prove delegation deterministically without a database.
  await assert.rejects(
    () => agentTools.session_list.handler({}, {}),
    /session_list: ctx\.userId required/,
  );

  const missing = await agentTools.session_history.handler({}, { userId: 'u1' });
  assert.equal(missing.error, 'missing sessionId');
});

test('browser automation wrappers run against an injected browser adapter', async () => {
  const adapter = createBrowserAdapter({ vendor: 'stub', provider: createStubProvider() });
  const ctx = { browserAdapter: adapter };

  const nav = await agentTools.browser_navigate.handler({ url: 'https://example.com/page' }, ctx);
  assert.equal(nav.ok, true);
  assert.equal(nav.action, 'navigate');
  assert.equal(nav.result.url, 'https://example.com/page');
  assert.equal(nav.record.action, 'navigate');
  assert.ok(nav.screenshot.id);

  const typed = await agentTools.browser_type.handler({ selector: '#q', text: 'secret text' }, ctx);
  assert.equal(typed.ok, true);
  assert.equal(typed.record.args.selector, '#q');
  assert.equal(typed.record.args.text, undefined);
  assert.equal(typed.record.args.textLength, 11);

  const scrolled = await agentTools.browser_scroll.handler({}, ctx);
  assert.equal(scrolled.ok, true);
  assert.equal(scrolled.record.args.y, 800);
});

test('browser automation wrappers fail closed without a driver', async () => {
  const out = await agentTools.browser_click.handler({ selector: 'button' }, {});
  assert.equal(out.ok, false);
  assert.equal(out.error, 'browser_driver_required');
});
