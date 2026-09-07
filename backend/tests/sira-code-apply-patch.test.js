'use strict';

/**
 * SiraCode ls + apply_patch — offline workspace, no sidecar / network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool } = require('../src/services/sira-code/tools');
const { parsePatch, hunkToOldNew, applyUnique } = require('../src/services/sira-code/apply-patch');

function session(agentId, workspace) {
  return { agentId, workspace, permission: 'default' };
}

test('parsePatch reads add, unique update and delete envelopes', () => {
  const ops = parsePatch(`*** Begin Patch
*** Add File: hello.txt
+Hello
*** Update File: app.py
@@ def greet():
-print("Hi")
+print("Hello")
*** Delete File: gone.txt
*** End Patch`);
  assert.equal(ops.length, 3);
  assert.equal(ops[0].type, 'add');
  assert.equal(ops[0].path, 'hello.txt');
  assert.deepEqual(ops[0].body, ['Hello']);
  assert.equal(ops[1].type, 'update');
  const { oldText, newText } = hunkToOldNew(ops[1].hunks[0]);
  assert.equal(oldText, 'print("Hi")');
  assert.equal(newText, 'print("Hello")');
  assert.equal(ops[2].type, 'delete');
  assert.equal(ops[2].path, 'gone.txt');
});

test('applyUnique refuses missing and ambiguous hunks', () => {
  assert.equal(applyUnique('alpha\nbeta', 'alpha', 'ALPHA'), 'ALPHA\nbeta');
  assert.throws(() => applyUnique('aa aa', 'aa', 'bb'), /más de una vez/);
  assert.throws(() => applyUnique('solo', 'nope', 'x'), /no coincide/);
});

test('ls lists names and sizes without file bodies', async () => {
  const workspace = await createWorkspace('sc-ls');
  try {
    await workspace.writeFile('nota.txt', 'secreto-no-listar');
    const result = await executeTool(session('construir', workspace), 'ls', { path: '.' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /nota\.txt/);
    assert.ok(!String(result.content).includes('secreto-no-listar'));
  } finally {
    await workspace.destroy();
  }
});

test('apply_patch add/update/delete stays inside the workspace jail', async () => {
  const workspace = await createWorkspace('sc-patch');
  try {
    await workspace.writeFile('app.py', 'print("Hi")\n');
    await workspace.writeFile('gone.txt', 'bye');
    const result = await executeTool(session('construir', workspace), 'apply_patch', {
      patch: `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: app.py
-print("Hi")
+print("Hello")
*** Delete File: gone.txt
*** End Patch`,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('hello.txt'), 'Hello world');
    assert.equal(await workspace.readFile('app.py'), 'print("Hello")\n');
    await assert.rejects(() => workspace.readFile('gone.txt'));
    const escaped = await executeTool(session('construir', workspace), 'apply_patch', {
      patch: '*** Begin Patch\n*** Add File: ../escape.txt\n+no\n*** End Patch',
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'path_traversal');
  } finally {
    await workspace.destroy();
  }
});

test('planificar can ls but cannot apply_patch', async () => {
  const workspace = await createWorkspace('sc-plan');
  try {
    await workspace.writeFile('a.txt', 'a');
    const listed = await executeTool(session('planificar', workspace), 'ls', {});
    assert.equal(listed.ok, true, listed.error);
    const patched = await executeTool(session('planificar', workspace), 'apply_patch', {
      patch: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch',
    });
    assert.equal(patched.ok, false);
    assert.equal(patched.permission.denied, true);
    assert.equal(await workspace.readFile('a.txt'), 'a');
  } finally {
    await workspace.destroy();
  }
});

test('apply_patch refuses a hunk that is not unique', async () => {
  const workspace = await createWorkspace('sc-ambig');
  try {
    await workspace.writeFile('dup.txt', 'x\nx\n');
    const result = await executeTool(session('construir', workspace), 'apply_patch', {
      patch: '*** Begin Patch\n*** Update File: dup.txt\n-x\n+y\n*** End Patch',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'hunk_ambiguous');
    assert.equal(await workspace.readFile('dup.txt'), 'x\nx\n');
  } finally {
    await workspace.destroy();
  }
});
