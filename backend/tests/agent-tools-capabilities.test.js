const test = require('node:test');
const assert = require('node:assert/strict');

const agentTools = require('../src/services/agents/agent-tools');
const { createBrowserAdapter, createStubProvider } = require('../src/services/ai-product-os/adapters/browser-adapter');

test('agent tool registry exposes session, extraction and browser automation tools', () => {
  for (const name of [
    'session_search',
    'session_list',
    'session_history',
    'session_send',
    'session_spawn',
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

test('session_spawn / session_send are cost-guarded: blocked at max depth, no sub-agent run', async () => {
  const { maxSpawnDepth } = require('../src/services/agents/subagent-guard');
  const deep = { userId: 'u1', depth: maxSpawnDepth() };

  // At/over max depth the guard returns a structured refusal WITHOUT
  // invoking the skill handler (so no prisma write / no runAgent).
  const spawn = await agentTools.session_spawn.handler({ prompt: 'do x' }, deep);
  assert.equal(spawn.spawned, false);
  assert.match(spawn.reason, /depth/i);

  const send = await agentTools.session_send.handler(
    { sessionId: 's1', message: 'm', runAgent: true }, deep,
  );
  assert.equal(send.appended, false);
  assert.match(send.reason, /depth/i);
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
