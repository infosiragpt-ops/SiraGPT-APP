'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeTool } = require('../src/services/sira-code/tools');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { runTodo, mergeTodos } = require('../src/services/sira-code/todos');
const { blockedHost, runWebFetch } = require('../src/services/sira-code/webfetch');

function session(agentId, workspace, extra = {}) {
  return { agentId, workspace, permission: 'default', todos: [], ...extra };
}

test('blockedHost rejects loopback and local names', () => {
  assert.equal(blockedHost('localhost'), true);
  assert.equal(blockedHost('127.0.0.1'), true);
  assert.equal(blockedHost('10.0.0.5'), true);
  assert.equal(blockedHost('192.168.1.1'), true);
  assert.equal(blockedHost('example.com'), false);
});

test('webfetch refuses private URLs without calling fetch', async () => {
  let called = 0;
  const result = await runWebFetch({ url: 'http://127.0.0.1/secret' }, {
    fetch: async () => { called += 1; return new Response('no'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'url_blocked');
  assert.equal(called, 0);
});

test('webfetch uses injected fetch for a public https URL', async () => {
  const result = await runWebFetch({ url: 'http://docs.example/page', format: 'markdown' }, {
    fetch: async (href) => {
      assert.equal(href, 'https://docs.example/page');
      return new Response('<html><body><p>Hola Sira</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.match(result.content, /Hola Sira/);
  assert.ok(!result.content.includes('<p>'));
});

test('todo keeps exactly one in_progress', () => {
  const list = mergeTodos([], [
    { id: 'a', content: 'uno', status: 'in_progress' },
    { id: 'b', content: 'dos', status: 'in_progress' },
  ]);
  assert.equal(list.filter((item) => item.status === 'in_progress').length, 1);
  assert.equal(list[0].status, 'in_progress');
  assert.equal(list[1].status, 'pending');
});

test('construir can webfetch and todo; planificar cannot apply_patch', async () => {
  const workspace = await createWorkspace('sc-web');
  try {
    const live = session('construir', workspace);
    const fetched = await executeTool(live, 'webfetch', { url: 'https://docs.example' }, {
      fetch: async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    assert.equal(fetched.ok, true, fetched.error);
    const listed = await executeTool(live, 'todo', {
      todos: [{ content: 'parchear', status: 'in_progress' }],
    });
    assert.equal(listed.ok, true, listed.error);
    assert.equal(live.todos.length, 1);
    const plan = session('planificar', workspace);
    const patched = await executeTool(plan, 'apply_patch', {
      patch: '*** Begin Patch\n*** Add File: x.txt\n+no\n*** End Patch',
    });
    assert.equal(patched.ok, false);
    assert.equal(patched.permission.denied, true);
  } finally {
    await workspace.destroy();
  }
});

test('runTodo requires a session object', () => {
  const missing = runTodo(null, { todos: [{ content: 'x' }] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'session_required');
});
