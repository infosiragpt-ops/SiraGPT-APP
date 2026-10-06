'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourcePath = require.resolve('../src/services/computer/cdp-client');

function harness({ nodes, failure, noPage = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module, exports: module.exports, require: createRequire(sourcePath),
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => { calls.push('raw-unavailable'); throw Error('raw transport unavailable'); },
  });
  const page = {
    // Deliberately no page.accessibility: removed by Playwright.
    context: () => context,
    title: async () => 'Formulario QA',
    url: () => 'https://example.test/form',
  };
  const context = {
    pages: () => [page],
    newCDPSession: async selected => {
      assert.equal(selected, page);
      calls.push('attach');
      return {
        send: async method => {
          assert.equal(method, 'Accessibility.getFullAXTree');
          calls.push(method);
          if (failure) throw failure;
          return { nodes };
        },
        detach: async () => { calls.push('detach'); },
      };
    },
  };
  const playwrightImpl = { chromium: { connectOverCDP: async (url, options) => {
    calls.push({ url, options });
    return { contexts: () => noPage ? [] : [context], close: async () => { calls.push('disconnect'); } };
  } } };
  return { calls, run: () => module.exports.snapshotAccessibility('http://example.test/cdp', { playwrightImpl, timeoutMs: 200 }) };
}

test('Playwright fallback reads the public CDP accessibility tree without the removed page API', async () => {
  const h = harness({ nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Formulario QA' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Guardar pedido' } },
    { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'fixture-password-do-not-echo' } },
  ] });
  const result = await h.run();
  assert.equal(result.url, 'https://example.test/form');
  assert.equal(result.title, 'Formulario QA');
  assert.match(result.text, /button "Guardar pedido"/);
  assert.doesNotMatch(result.text, /fixture-password-do-not-echo/);
  assert.equal(h.calls.filter(call => call === 'Accessibility.getFullAXTree').length, 1);
  assert.deepEqual(h.calls.slice(-2), ['detach', 'disconnect']);
});

test('fallback attaches without imposing Playwright default emulation on the existing browser', async () => {
  const h = harness({ nodes: [] });
  await h.run().catch(() => {});
  const connection = h.calls.find(call => call && typeof call === 'object');
  assert.equal(connection.url, 'http://example.test/cdp');
  assert.deepEqual(JSON.parse(JSON.stringify(connection.options)), { timeout: 200, noDefaults: true });
});

test('CDP tree failures are not acknowledged as an empty successful observation and always disconnect', async () => {
  const failure = Error('controlled accessibility protocol failure');
  const h = harness({ failure });
  await assert.rejects(h.run(), error => error === failure);
  assert.deepEqual(h.calls.slice(-2), ['detach', 'disconnect']);
});

test('malformed CDP trees fail closed and observations keep the existing text cap', async () => {
  for (const nodes of [null, []]) {
    const invalid = harness({ nodes });
    await assert.rejects(invalid.run(), /cdp_accessibility_unavailable/);
    assert.deepEqual(invalid.calls.slice(-2), ['detach', 'disconnect']);
  }
  const large = harness({ nodes: Array.from({ length: 400 }, (_, i) => ({ nodeId: String(i), role: { value: 'button' }, name: { value: 'Visible '.repeat(25) } })) });
  assert.equal((await large.run()).text.length, 24000);
});

test('no-context fallback retains its explicit no-page result and disconnects', async () => {
  const h = harness({ noPage: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.run())), { text: '(no page)', url: null, title: '' });
  assert.equal(h.calls.at(-1), 'disconnect');
  assert.equal(h.calls.includes('attach'), false);
});
