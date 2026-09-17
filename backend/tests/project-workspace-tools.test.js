'use strict';

// Etapa 3 MVP programación web en /agentes: project_read / project_write /
// project_exec con alcance al proyecto vinculado al chat. Tests con dobles
// en memoria: sin DB real ni runner real.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/services/agents/project-workspace-tools');

const { sanitizeRelPath, isBlockedSecretPath, normalizeExecCmd, resolveBoundProject } = tools._internal;

function makeBinding(projectByChat = {}) {
  return {
    findProjectForChat: async ({ userId, chatId }) => {
      const key = `${userId}:${chatId}`;
      return projectByChat[key] ? { ...projectByChat[key] } : null;
    },
  };
}

function makeRunner(impl = {}) {
  const calls = [];
  return {
    calls,
    readFile: async (projectId, path) => {
      calls.push(['readFile', projectId, path]);
      if (impl.readFile) return impl.readFile(projectId, path);
      return { ok: true, path, content: 'line1\nline2\nline3\n' };
    },
    writeFiles: async (projectId, files) => {
      calls.push(['writeFiles', projectId, files]);
      if (impl.writeFiles) return impl.writeFiles(projectId, files);
      return { ok: true, written: files.length };
    },
    exec: async (projectId, cmd, opts) => {
      calls.push(['exec', projectId, cmd, opts]);
      if (impl.exec) return impl.exec(projectId, cmd, opts);
      return { ok: true, exitCode: 0, timedOut: false, stdout: 'out', stderr: '' };
    },
  };
}

function ctxWith(projectByChat, runnerImpl) {
  return {
    userId: 'u1',
    chatId: 'chat1',
    prisma: {},
    projectTools: { binding: makeBinding(projectByChat), runner: makeRunner(runnerImpl) },
  };
}

const BOUND = { 'u1:chat1': { id: 'p1', userId: 'u1', name: 'Mi app web' } };

test('tool shapes: nombres, schemas y required', () => {
  assert.equal(tools.projectReadTool.name, 'project_read');
  assert.equal(tools.projectWriteTool.name, 'project_write');
  assert.equal(tools.projectExecTool.name, 'project_exec');
  assert.deepEqual(tools.projectReadTool.parameters.required, ['path']);
  assert.deepEqual(tools.projectWriteTool.parameters.required, ['path', 'content']);
  assert.deepEqual(tools.projectExecTool.parameters.required, ['cmd']);
  for (const t of [tools.projectReadTool, tools.projectWriteTool, tools.projectExecTool]) {
    assert.equal(t.parameters.additionalProperties, false);
    assert.equal(typeof t.execute, 'function');
  }
});

test('sanitizeRelPath acepta relativas y rechaza escapes', () => {
  assert.equal(sanitizeRelPath('src/App.tsx'), 'src/App.tsx');
  assert.equal(sanitizeRelPath('package.json'), 'package.json');
  assert.equal(sanitizeRelPath('../x'), null);
  assert.equal(sanitizeRelPath('a/../../b'), null);
  assert.equal(sanitizeRelPath('/abs/path'), null);
  assert.equal(sanitizeRelPath('C:\\win'), null);
  assert.equal(sanitizeRelPath('a\\b'), null);
  assert.equal(sanitizeRelPath(''), null);
  assert.equal(sanitizeRelPath('a\0b'), null);
  assert.equal(sanitizeRelPath('.'), null);
  assert.equal(sanitizeRelPath('x'.repeat(501)), null);
});

test('isBlockedSecretPath bloquea .env y claves', () => {
  assert.equal(isBlockedSecretPath('.env'), true);
  assert.equal(isBlockedSecretPath('sub/.env.local'), true);
  assert.equal(isBlockedSecretPath('.env.example'), false);
  assert.equal(isBlockedSecretPath('id_rsa'), true);
  assert.equal(isBlockedSecretPath('src/App.tsx'), false);
});

test('resolveBoundProject: sin ctx → no_chat_context', async () => {
  const r = await resolveBoundProject({});
  assert.equal(r.error.code, 'no_chat_context');
});

test('resolveBoundProject: sin vínculo → no_project con guía', async () => {
  const r = await resolveBoundProject(ctxWith({}, null));
  assert.equal(r.error.code, 'no_project');
  assert.match(r.error.message, /Nuevo proyecto/);
});

test('resolveBoundProject: ownership por userId', async () => {
  const ctx = ctxWith(BOUND, null);
  const ok = await resolveBoundProject(ctx);
  assert.equal(ok.project.id, 'p1');
  const other = await resolveBoundProject({ ...ctx, userId: 'u2' });
  assert.equal(other.error.code, 'no_project');
});

test('project_read: pagina líneas y marca truncated', async () => {
  const ctx = ctxWith(BOUND, { readFile: async () => ({ ok: true, content: 'a\nb\nc\nd\ne\n' }) });
  const r = await tools.projectReadTool.execute({ path: 'f.txt', offset: 1, limit: 2 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.content, 'b\nc');
  assert.equal(r.totalLines, 6);
  assert.equal(r.truncated, true);
});

test('project_read: bloquea secretos y bad_path sin tocar runner', async () => {
  const runner = makeRunner();
  const ctx = { userId: 'u1', chatId: 'chat1', prisma: {}, projectTools: { binding: makeBinding(BOUND), runner } };
  const s = await tools.projectReadTool.execute({ path: '.env' }, ctx);
  assert.equal(s.code, 'blocked_secret');
  const b = await tools.projectReadTool.execute({ path: '../x' }, ctx);
  assert.equal(b.code, 'bad_path');
  assert.equal(runner.calls.length, 0);
});

test('project_read: runner caído → runner_unreachable', async () => {
  const ctx = ctxWith(BOUND, { readFile: async () => { throw new Error('boom'); } });
  const r = await tools.projectReadTool.execute({ path: 'f.txt' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runner_unreachable');
});

test('project_write: escribe un archivo con bytes', async () => {
  const runner = makeRunner();
  const ctx = { userId: 'u1', chatId: 'chat1', prisma: {}, projectTools: { binding: makeBinding(BOUND), runner } };
  const r = await tools.projectWriteTool.execute({ path: 'src/A.tsx', content: 'export {};\n' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.path, 'src/A.tsx');
  assert.deepEqual(runner.calls[0][0], 'writeFiles');
  assert.deepEqual(runner.calls[0][2], [{ path: 'src/A.tsx', content: 'export {};\n' }]);
});

test('project_write: contenido gigante y secretos bloqueados', async () => {
  const ctx = ctxWith(BOUND, null);
  const big = await tools.projectWriteTool.execute({ path: 'f.txt', content: 'x'.repeat(tools.WRITE_MAX_CONTENT_BYTES + 1) }, ctx);
  assert.equal(big.code, 'content_too_large');
  const sec = await tools.projectWriteTool.execute({ path: '.env', content: 'K=V' }, ctx);
  assert.equal(sec.code, 'blocked_secret');
});

test('normalizeExecCmd valida argv sin shell', () => {
  assert.deepEqual(normalizeExecCmd(['bun', 'x', 'tsc']), ['bun', 'x', 'tsc']);
  assert.equal(normalizeExecCmd('bun install'), null);
  assert.equal(normalizeExecCmd([]), null);
  assert.equal(normalizeExecCmd(['a', 42]), null);
  assert.equal(normalizeExecCmd(new Array(65).fill('a')), null);
  assert.equal(normalizeExecCmd(['x'.repeat(4001)]), null);
});

test('project_exec: ejecuta argv y recorta salida', async () => {
  const ctx = ctxWith(BOUND, { exec: async () => ({ ok: true, exitCode: 0, timedOut: false, stdout: 'y'.repeat(25000), stderr: '' }) });
  const r = await tools.projectExecTool.execute({ cmd: ['bun', '--version'] }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.length, tools.OUTPUT_MAX_CHARS);
  assert.equal(r.truncated, true);
});

test('project_exec: comando inválido no llega al runner', async () => {
  const runner = makeRunner();
  const ctx = { userId: 'u1', chatId: 'chat1', prisma: {}, projectTools: { binding: makeBinding(BOUND), runner } };
  const r = await tools.projectExecTool.execute({ cmd: 'rm -rf /' }, ctx);
  assert.equal(r.code, 'invalid_command');
  assert.equal(runner.calls.length, 0);
});

test('execute nunca lanza: binding roto → internal/no_project', async () => {
  const ctx = {
    userId: 'u1',
    chatId: 'chat1',
    prisma: {},
    projectTools: {
      binding: { findProjectForChat: async () => { throw new Error('db caída'); } },
      runner: makeRunner(),
    },
  };
  const r = await tools.projectReadTool.execute({ path: 'f.txt' }, ctx);
  // resolveBoundProject captura el fallo de binding como no_project
  assert.equal(r.code, 'no_project');
});
