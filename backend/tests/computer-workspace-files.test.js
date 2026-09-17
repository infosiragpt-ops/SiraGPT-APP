'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertWorkspacePath,
  createWorkspaceFileApi,
  WORKSPACE,
} = require('../src/services/computer/workspace-files');

test('assertWorkspacePath stays under /workspace', () => {
  assert.equal(assertWorkspacePath('notas/a.txt'), '/workspace/notas/a.txt');
  assert.equal(assertWorkspacePath('/workspace/b.txt'), '/workspace/b.txt');
  assert.throws(() => assertWorkspacePath('../etc/passwd'), /workspace/);
  assert.throws(() => assertWorkspacePath('/etc/passwd'), /workspace/);
  assert.throws(() => assertWorkspacePath(''), /inválida/);
});

test('writeFile tees UTF-8 into /workspace and mkdir -p parent', async () => {
  const cmds = [];
  const tees = [];
  const files = createWorkspaceFileApi({
    persistent: {
      containerName: () => 'sira-ac-user-test',
      ensureSession: async () => ({ sessionId: 's1', userId: 'u1' }),
      dockerExec: async (_s, cmd) => {
        cmds.push(cmd);
        return { ok: true, stdout: 'ok' };
      },
      dockerTee: async (_s, abs, buf) => {
        tees.push({ abs, text: Buffer.from(buf).toString('utf8') });
        return { ok: true, bytes: buf.length, path: abs };
      },
    },
  });
  const out = await files.writeFile({
    path: 'notas/hola.txt',
    content: 'hola mundo',
    userId: 'u1',
    conversationId: 'c1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.path, '/workspace/notas/hola.txt');
  assert.ok(cmds[0].includes('mkdir -p'));
  assert.equal(tees[0].abs, '/workspace/notas/hola.txt');
  assert.equal(tees[0].text, 'hola mundo');
});

test('editFile replaces exact fragment', async () => {
  let stored = 'alpha beta gamma';
  const files = createWorkspaceFileApi({
    persistent: {
      containerName: () => 'sira-ac-user-test',
      ensureSession: async () => ({ sessionId: 's1', userId: 'u1' }),
      dockerExec: async (_s, cmd) => {
        if (cmd.includes('python3')) return { ok: true, stdout: stored };
        return { ok: true, stdout: '' };
      },
      dockerTee: async (_s, abs, buf) => {
        stored = Buffer.from(buf).toString('utf8');
        return { ok: true, path: abs, bytes: buf.length };
      },
    },
  });
  const out = await files.editFile({
    path: 'a.txt',
    old_string: 'beta',
    new_string: 'BETA',
    userId: 'u1',
    conversationId: 'c1',
  });
  assert.equal(out.ok, true);
  assert.equal(stored, 'alpha BETA gamma');
});

test('listFiles default root is /workspace', async () => {
  const files = createWorkspaceFileApi({
    persistent: {
      containerName: () => 'c',
      ensureSession: async () => ({ sessionId: 's' }),
      dockerExec: async () => ({ ok: true, stdout: 'f notas/a.txt\nd notas\n' }),
    },
  });
  const out = await files.listFiles({ userId: 'u1', conversationId: 'c1' });
  assert.equal(out.root, WORKSPACE);
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].kind, 'file');
});
