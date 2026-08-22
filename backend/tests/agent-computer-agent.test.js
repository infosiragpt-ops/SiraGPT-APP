'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { parseAction, canonicalizeAction } = require('../../services/computer/agent/schemas');
const { buildXdotoolArgs } = require('../../services/computer/agent/actions');
const {
  assertSafeRelPath,
  assertSafeTaskId,
  resolveWorkspacePath,
  writeFileSafe,
  listOrRead,
  ensureTaskDir,
  FilePathError,
} = require('../../services/computer/agent/files');

test('zod rejects unknown actions and accepts the documented set', () => {
  assert.throws(() => parseAction({ type: 'shell', cmd: 'rm -rf /' }));
  assert.equal(parseAction({ type: 'click', x: 10, y: 20 }).type, 'click');
  assert.equal(parseAction({ type: 'type', text: 'hello' }).text, 'hello');
  assert.equal(parseAction({ type: 'key', key: 'Return' }).key, 'Return');
  assert.equal(parseAction({ type: 'drag', x: 1, y: 1, x2: 8, y2: 8 }).x2, 8);
});

test('xdotool argv is an argument array — never a shell string', () => {
  const click = buildXdotoolArgs({ type: 'click', x: 5, y: 9 });
  assert.deepEqual(click, ['mousemove', '5', '9', 'click', '1']);
  const typed = buildXdotoolArgs({ type: 'type', text: 'hello; rm -rf /' });
  assert.deepEqual(typed, ['type', '--delay', '20', '--', 'hello; rm -rf /']);
  const key = buildXdotoolArgs({ type: 'key', key: 'ctrl+l' });
  assert.deepEqual(key, ['key', '--', 'ctrl+l']);
});

test('file paths reject traversal, absolute escapes, and null bytes', () => {
  assert.throws(() => assertSafeRelPath('../etc/passwd'), FilePathError);
  assert.throws(() => assertSafeRelPath('/etc/passwd'), FilePathError);
  assert.throws(() => assertSafeRelPath('foo\0bar'), FilePathError);
  assert.throws(() => assertSafeRelPath('/workspace/../etc/passwd'), FilePathError);
  assert.equal(assertSafeRelPath('/workspace/notes.txt'), 'notes.txt');
  assert.equal(assertSafeRelPath('docs/a.txt'), 'docs/a.txt');
});

test('workspace read/write stays inside the root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-acomp-'));
  try {
    await writeFileSafe('notes/hello.txt', 'hi', { root });
    const read = await listOrRead('notes/hello.txt', { root });
    assert.equal(read.kind, 'file');
    assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), 'hi');
    const listing = await listOrRead('notes', { root });
    assert.equal(listing.kind, 'dir');
    assert.ok(listing.entries.some((e) => e.name === 'hello.txt'));
    assert.throws(() => resolveWorkspacePath('../outside', root), FilePathError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task artifacts land under /workspace/<task-id>/', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-acomp-task-'));
  try {
    assert.throws(() => assertSafeTaskId('../etc'), FilePathError);
    assert.throws(() => assertSafeTaskId(''), FilePathError);
    const dir = await ensureTaskDir('task-abc', { root });
    assert.equal(dir.path, 'task-abc');
    assert.equal(dir.workspacePath, '/workspace/task-abc');
    await writeFileSafe('task-abc/note.txt', 'artifact', { root });
    const read = await listOrRead('task-abc/note.txt', { root });
    assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), 'artifact');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonicalizeAction is stable for repeat detection', () => {
  const a = canonicalizeAction({ type: 'click', y: 2, x: 1 });
  const b = canonicalizeAction({ x: 1, type: 'click', y: 2 });
  assert.equal(a, b);
});
